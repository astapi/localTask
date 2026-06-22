import readline from "node:readline";
import { exec } from "node:child_process";
import { loadConfig, requireNotionConfig } from "./config.js";
import { TaskStore } from "./db.js";
import { syncFromNotion } from "./notion.js";
import type { LocalState, Task } from "./types.js";

// ===== ANSI ヘルパー =====
const ESC = "\x1b[";
const clear = () => process.stdout.write(`${ESC}2J${ESC}H`);
const home = () => process.stdout.write(`${ESC}H`);
const hideCursor = () => process.stdout.write(`${ESC}?25l`);
const showCursor = () => process.stdout.write(`${ESC}?25h`);
const dim = (s: string) => `${ESC}2m${s}${ESC}0m`;
const bold = (s: string) => `${ESC}1m${s}${ESC}0m`;
const reverse = (s: string) => `${ESC}7m${s}${ESC}0m`;
const color = (code: number, s: string) => `${ESC}${code}m${s}${ESC}0m`;

const STATE_LABEL: Record<LocalState, string> = {
  inbox: "未着手",
  in_progress: "進行中",
  undeployed: "未デプロイ",
  deployed: "デプロイ済",
};
const STATE_COLOR: Record<LocalState, number> = {
  inbox: 37,
  in_progress: 36,
  undeployed: 33,
  deployed: 32,
};

type Filter =
  | "open"
  | "inbox"
  | "in_progress"
  | "undeployed"
  | "deployed"
  | "all";
const FILTERS: Filter[] = [
  "open",
  "inbox",
  "in_progress",
  "undeployed",
  "deployed",
  "all",
];
const FILTER_LABEL: Record<Filter, string> = {
  open: "未完了",
  inbox: "未着手",
  in_progress: "進行中",
  undeployed: "未デプロイ",
  deployed: "デプロイ済",
  all: "全件",
};

/** 文字の表示幅（全角=2） */
function charWidth(ch: string): number {
  return ch.charCodeAt(0) > 0xff ? 2 : 1;
}
function strWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

/** 文字幅（全角=2）を考慮して切り詰める */
function truncate(s: string, width: number): string {
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = charWidth(ch);
    if (w + cw > width) {
      out += "…";
      break;
    }
    out += ch;
    w += cw;
  }
  return out;
}

/** 表示幅 width に右側スペースで揃える（切り詰めも行う） */
function padWidth(s: string, width: number): string {
  const t = truncate(s, width);
  return t + " ".repeat(Math.max(0, width - strWidth(t)));
}

class TaskTUI {
  private store: TaskStore;
  private config = loadConfig();
  private rows: Task[] = [];
  private cursor = 0;
  private scroll = 0;
  private filter: Filter = "open";
  private search = "";
  private mode: "list" | "detail" = "list";
  private status = "";
  private busy = false;
  private running = true;
  /** Undo用: 変更前のローカル状態スナップショット（新しいものが末尾） */
  private history: Array<{
    id: string;
    title: string;
    localState: LocalState;
    agentNotes: string | null;
  }> = [];
  /** インライン1行入力の状態（nullなら入力中でない） */
  private input: {
    label: string;
    buffer: string;
    resolve: (v: string | null) => void;
  } | null = null;
  /** Warpなどで上部がオーバーレイに隠れる対策。先頭に空ける行数 */
  private topMargin = Math.max(
    0,
    parseInt(process.env.LOCALTASK_TUI_TOP ?? "6", 10) || 0,
  );

  constructor() {
    this.store = new TaskStore(this.config.dbPath);
  }

  /** 非同期アクションを busy ガード付きで実行（例外時も必ず解除） */
  private async runBusy(fn: () => Promise<void>): Promise<void> {
    this.busy = true;
    try {
      await fn();
    } catch (e) {
      this.status = `エラー: ${e instanceof Error ? e.message : e}`;
    } finally {
      this.busy = false;
    }
  }

  /** 変更前の状態をUndoスタックに積む */
  private snapshot(t: Task): void {
    this.history.push({
      id: t.id,
      title: t.title,
      localState: t.localState,
      agentNotes: t.agentNotes,
    });
    if (this.history.length > 100) this.history.shift();
  }

  private reload(): void {
    const base = this.store.list({ includeArchived: true, includeDone: true });
    let rows = base.filter((t) => !t.archived);
    switch (this.filter) {
      case "open":
        rows = rows.filter(
          (t) => t.localState !== "deployed" && !t.isDoneInNotion,
        );
        break;
      case "deployed":
        rows = rows.filter(
          (t) => t.localState === "deployed" || t.isDoneInNotion,
        );
        break;
      case "all":
        break;
      default:
        rows = rows.filter((t) => t.localState === this.filter);
    }
    if (this.search) {
      const q = this.search.toLowerCase();
      rows = rows.filter((t) => t.title.toLowerCase().includes(q));
    }
    this.rows = rows;
    if (this.cursor >= rows.length) this.cursor = Math.max(0, rows.length - 1);
  }

  private get current(): Task | undefined {
    return this.rows[this.cursor];
  }

  // ===== 描画 =====
  private render(): void {
    if (this.mode === "detail") return this.renderDetail();
    this.renderList();
  }

  /** フッター行: 入力中はプロンプト、操作後はステータス、通常は凡例 */
  private footerLine(legend: string): string {
    if (this.input) {
      return (
        color(36, this.input.label) +
        this.input.buffer +
        "█" +
        dim("   (Enter:確定  Esc:キャンセル  Ctrl+U:全消去)")
      );
    }
    return this.status ? color(33, this.status) : dim(legend);
  }

  /** 優先度を1文字マーク(H/M/L)＋色で表す。{char, code} を返す */
  private priorityMark(t: Task): { char: string; code: number } {
    const p = (t.priority ?? "").toLowerCase();
    if (/high|高/.test(p)) return { char: "H", code: 31 }; // 赤
    if (/medium|mid|中/.test(p)) return { char: "M", code: 33 }; // 黄
    if (/low|低/.test(p)) return { char: "L", code: 34 }; // 青
    return { char: " ", code: 90 };
  }

  private renderList(): void {
    const cols = process.stdout.columns || 100;
    const totalRows = process.stdout.rows || 30;
    // topMargin(空白) + ヘッダ3 + リスト + フッタ2
    const listHeight = Math.max(3, totalRows - this.topMargin - 3 - 2 - 1);

    // スクロール調整
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    if (this.cursor >= this.scroll + listHeight)
      this.scroll = this.cursor - listHeight + 1;

    home();
    const out: string[] = [];
    for (let i = 0; i < this.topMargin; i++) out.push("");

    const filterBar = FILTERS.map((f) =>
      f === this.filter ? reverse(` ${FILTER_LABEL[f]} `) : ` ${FILTER_LABEL[f]} `,
    ).join("");
    out.push(bold("📋 localtask") + "  " + filterBar);
    const searchInfo = this.search ? `  検索:"${this.search}"` : "";
    out.push(
      dim(`${this.rows.length}件${searchInfo}`) +
        dim("   優先度順 | H/M/L=優先度  [ ]=ローカル状態(i/p/b/x)  ·=Notion"),
    );
    out.push(dim("─".repeat(Math.min(cols, 120))));

    const view = this.rows.slice(this.scroll, this.scroll + listHeight);
    if (view.length === 0) {
      out.push(dim("  (該当タスクなし)"));
    }
    view.forEach((t, i) => {
      const idx = this.scroll + i;
      const selected = idx === this.cursor;
      const noTag = `#${String(t.no).padStart(3)}`;
      const prio = this.priorityMark(t);
      const tag = `[${padWidth(STATE_LABEL[t.localState], 10)}]`;
      const due = t.dueDate ? ` ${t.dueDate}` : "";
      const note = t.agentNotes ? " 📝" : "";
      const notion = t.notionStatus ? `  ·${t.notionStatus}` : "";
      const fixed =
        2 +
        strWidth(noTag) +
        2 +
        2 +
        strWidth(tag) +
        1 +
        strWidth(due) +
        strWidth(notion) +
        (note ? 3 : 0);
      const title = truncate(t.title, Math.max(10, cols - fixed - 1));
      if (selected) {
        // 反転表示でも見えるよう、色を使わず文字で表現
        const plain = `${noTag} ${prio.char} ${tag} ${title}${due}${notion}${note}`;
        out.push(reverse(` ${padWidth(plain, cols - 2)}`));
      } else {
        out.push(
          `  ${dim(noTag)} ${color(prio.code, prio.char)} ${color(STATE_COLOR[t.localState], tag)} ${title}${dim(due)}${dim(notion)}${note}`,
        );
      }
    });

    // フッター（リストを埋めて下寄せ）
    for (let i = view.length; i < listHeight; i++) out.push("");
    out.push(dim("─".repeat(Math.min(cols, 120))));
    out.push(
      this.footerLine(
        "↑↓/jk 移動  Enter 詳細  Tab ﾌｨﾙﾀ  i/p/b/x 状態  u 取消  r 更新  e メモ  o Notion  s 同期  / 検索  q 終了",
      ),
    );
    // 各行を画面幅でクリアしつつ出力
    process.stdout.write(out.map((l) => `${ESC}K${l}`).join("\n") + `${ESC}J`);
  }

  private renderDetail(): void {
    const t = this.current;
    clear();
    if (!t) {
      this.mode = "list";
      return this.render();
    }
    const cols = process.stdout.columns || 100;
    const out: string[] = [];
    for (let i = 0; i < this.topMargin; i++) out.push("");
    out.push(bold("─ タスク詳細 ") + dim("─".repeat(Math.max(0, Math.min(cols, 100) - 13))));
    out.push("");
    out.push(bold(`#${t.no}  ${t.title}`));
    out.push("");
    out.push(
      `  ローカル状態 : ${color(STATE_COLOR[t.localState], STATE_LABEL[t.localState].trim())}`,
    );
    out.push(`  Notionｽﾃｰﾀｽ : ${t.notionStatus ?? "-"}${t.isDoneInNotion ? color(32, "  (Notion上で完了)") : ""}`);
    out.push(`  優先度       : ${t.priority ?? "-"}`);
    out.push(`  期限         : ${t.dueDate ?? "-"}`);
    out.push(`  担当         : ${t.assignee ?? "-"}`);
    out.push(`  URL          : ${t.url ?? "-"}`);
    out.push(`  最終同期     : ${dim(t.lastSyncedAt)}`);
    out.push("");
    out.push(bold("  メモ:"));
    if (t.agentNotes) {
      for (const ln of t.agentNotes.split("\n")) out.push("    " + ln);
    } else {
      out.push(dim("    (なし)"));
    }
    out.push("");
    out.push(bold("  本文 (Notion):"));
    if (t.body) {
      // 残り画面高に収まる範囲で表示（超過分は省略表示）
      const totalRows = process.stdout.rows || 30;
      const remaining = Math.max(3, totalRows - out.length - 3);
      const bodyLines = t.body.split("\n");
      for (const ln of bodyLines.slice(0, remaining)) {
        out.push("    " + truncate(ln, Math.min(cols, 100) - 4));
      }
      if (bodyLines.length > remaining) {
        out.push(dim(`    …他 ${bodyLines.length - remaining} 行（全文はoでNotion参照）`));
      }
    } else {
      out.push(dim("    (なし)"));
    }
    out.push("");
    out.push(dim("─".repeat(Math.min(cols, 100))));
    out.push(
      this.footerLine(
        "i 進行中  p 未着手  b 未ﾃﾞﾌﾟﾛｲ  x ﾃﾞﾌﾟﾛｲ済  u 取消  e メモ編集  a メモ追記  o Notion  Esc/← 戻る  q 終了",
      ),
    );
    process.stdout.write(out.join("\n"));
  }

  // ===== 入力（生モードのままインライン1行入力） =====
  // readline.createInterface を使うとモード切替で stdin が固まるため自前実装。
  private readLine(label: string, initial = ""): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      this.input = { label, buffer: initial, resolve };
      this.render();
    });
  }

  private finishInput(value: string | null): void {
    const inp = this.input;
    if (!inp) return;
    this.input = null;
    inp.resolve(value);
  }

  /** 入力中のキー処理（Enter確定 / Esc・Ctrl+Cキャンセル / Backspace / 文字入力） */
  private handleInputKey(str: string, key: readline.Key): void {
    const inp = this.input;
    if (!inp) return;
    if (key.name === "return" || key.name === "enter") {
      this.finishInput(inp.buffer);
    } else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      this.finishInput(null);
    } else if (key.name === "backspace" || str === "\x7f") {
      inp.buffer = Array.from(inp.buffer).slice(0, -1).join("");
      this.render();
    } else if (key.ctrl && key.name === "u") {
      inp.buffer = "";
      this.render();
    } else if (str && !key.ctrl && !key.meta && str >= " ") {
      inp.buffer += str;
      this.render();
    }
  }

  // ===== アクション =====
  /** 更新後タスクを現在の表示行にその場で反映（フィルタ再適用しない＝消えない） */
  private replaceRow(updated: Task | undefined): void {
    if (!updated) return;
    const idx = this.rows.findIndex((t) => t.id === updated.id);
    if (idx >= 0) this.rows[idx] = updated;
  }

  private setState(s: LocalState): void {
    const t = this.current;
    if (!t) return;
    if (t.localState === s) {
      this.status = `すでに「${STATE_LABEL[s]}」です`;
      return;
    }
    this.snapshot(t);
    const updated = this.store.updateLocal(
      t.id,
      { localState: s },
      new Date().toISOString(),
    );
    // その場で書き換え、リストからは消さない（r/Tab/同期/再起動でフィルタ反映）
    this.replaceRow(updated);
    this.status = `「${truncate(t.title, 24)}」→ ${STATE_LABEL[s]}  (u 取消 / r 更新)`;
  }

  /** 直前の変更を取り消す */
  private undo(): void {
    const prev = this.history.pop();
    if (!prev) {
      this.status = "取り消せる操作がありません";
      return;
    }
    const updated = this.store.updateLocal(
      prev.id,
      { localState: prev.localState, agentNotes: prev.agentNotes },
      new Date().toISOString(),
    );
    const idx = this.rows.findIndex((t) => t.id === prev.id);
    if (idx >= 0) {
      this.replaceRow(updated);
      this.cursor = idx;
    } else {
      this.reload();
    }
    this.status = `取消: 「${truncate(prev.title, 24)}」を ${STATE_LABEL[prev.localState]} に戻しました`;
  }

  private async editNote(append: boolean): Promise<void> {
    const t = this.current;
    if (!t) return;
    const label = append ? "追記メモ" : "メモ (全置換)";
    const input = await this.readLine(
      `${label}> `,
      append ? "" : (t.agentNotes ?? ""),
    );
    if (input === null) return;
    this.snapshot(t);
    const stamp = new Date().toISOString();
    let notes: string;
    if (append) {
      if (!input.trim()) {
        this.status = "追記をキャンセル";
        return;
      }
      notes = t.agentNotes
        ? `${t.agentNotes}\n[${stamp}] ${input}`
        : `[${stamp}] ${input}`;
    } else {
      notes = input;
    }
    this.replaceRow(this.store.updateLocal(t.id, { agentNotes: notes }, stamp));
    this.status = "メモを更新しました";
  }

  private openNotion(): void {
    const t = this.current;
    if (!t?.url) {
      this.status = "URLがありません";
      return;
    }
    exec(`open ${JSON.stringify(t.url)}`);
    this.status = "Notionを開きました";
  }

  private async doSync(): Promise<void> {
    try {
      requireNotionConfig(this.config);
      this.status = "同期中…";
      this.render();
      const r = await syncFromNotion(this.store, this.config);
      this.reload();
      this.status = `同期完了: 新規${r.added}/更新${r.updated}/ｱｰｶｲﾌﾞ${r.archived}`;
    } catch (e) {
      this.status = `同期失敗: ${e instanceof Error ? e.message : e}`;
    }
  }

  private async search_(): Promise<void> {
    const q = await this.readLine("検索 (タイトル)> ", this.search);
    if (q === null) return;
    this.search = q.trim();
    this.cursor = 0;
    this.scroll = 0;
    this.reload();
  }

  // ===== キー処理 =====
  private async onKey(str: string, key: readline.Key): Promise<void> {
    // 入力中は最優先でテキスト入力として処理（q も文字として扱う）
    if (this.input) return this.handleInputKey(str, key);
    // 終了は何があっても最優先で効かせる（busy中でも）
    if ((key.ctrl && key.name === "c") || str === "q") return this.quit();
    if (this.busy) return;
    this.status = "";

    if (this.mode === "detail") {
      switch (key.name || str) {
        case "escape":
        case "left":
        case "h":
          this.mode = "list";
          break;
        case "i":
          this.setState("in_progress");
          break;
        case "p":
          this.setState("inbox");
          break;
        case "b":
          this.setState("undeployed");
          break;
        case "x":
          this.setState("deployed");
          break;
        case "e":
          await this.runBusy(() => this.editNote(false));
          break;
        case "a":
          await this.runBusy(() => this.editNote(true));
          break;
        case "u":
          this.undo();
          break;
        case "r":
          this.reload();
          this.status = "リストを更新しました";
          break;
        case "o":
          this.openNotion();
          break;
      }
      return this.render();
    }

    // list mode
    switch (key.name || str) {
      case "down":
      case "j":
        if (this.cursor < this.rows.length - 1) this.cursor++;
        break;
      case "up":
      case "k":
        if (this.cursor > 0) this.cursor--;
        break;
      case "g":
        this.cursor = 0;
        break;
      case "G":
        this.cursor = this.rows.length - 1;
        break;
      case "return":
      case "right":
      case "l":
        if (this.current) this.mode = "detail";
        break;
      case "tab":
        this.filter =
          FILTERS[(FILTERS.indexOf(this.filter) + 1) % FILTERS.length];
        this.cursor = 0;
        this.scroll = 0;
        this.reload();
        break;
      case "i":
        this.setState("in_progress");
        break;
      case "p":
        this.setState("inbox");
        break;
      case "b":
        this.setState("undeployed");
        break;
      case "x":
        this.setState("deployed");
        break;
      case "e":
        await this.runBusy(() => this.editNote(false));
        break;
      case "u":
        this.undo();
        break;
      case "r":
        this.reload();
        this.status = "リストを更新しました";
        break;
      case "o":
        this.openNotion();
        break;
      case "s":
        await this.runBusy(() => this.doSync());
        break;
      case "/":
        await this.runBusy(() => this.search_());
        break;
    }
    this.render();
  }

  private attachKeys(): void {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.removeAllListeners("keypress");
    process.stdin.on("keypress", (str, key) => {
      void this.onKey(str, key ?? {});
    });
    // readline.close() 後はstdinがpauseされるため、必ず再開してキー入力を受ける
    process.stdin.resume();
  }

  private quit(): void {
    if (!this.running) return;
    this.running = false;
    showCursor();
    clear();
    try {
      process.stdin.setRawMode?.(false);
    } catch {
      /* noop */
    }
    process.stdin.pause();
    try {
      this.store.close();
    } catch {
      /* noop */
    }
    console.log("localtask を終了しました。");
    process.exit(0);
  }

  async start(): Promise<void> {
    if (!process.stdin.isTTY) {
      console.error(
        "TUIはインタラクティブな端末でのみ動作します（パイプ/非TTY不可）。",
      );
      process.exit(1);
    }
    // 入力モード外でのCtrl+C等の保険（rawモード中はkeypressで処理）
    process.on("SIGINT", () => this.quit());
    process.on("SIGTERM", () => this.quit());

    this.reload();
    hideCursor();
    clear();
    this.attachKeys();
    this.render();
    // プロセスを生かし続ける
    await new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        if (!this.running) {
          clearInterval(iv);
          resolve();
        }
      }, 200);
    });
  }
}

export async function runTUI(): Promise<void> {
  await new TaskTUI().start();
}
