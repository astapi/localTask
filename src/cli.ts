#!/usr/bin/env -S npx tsx
import { loadConfig, requireNotionConfig } from "./config.js";
import { TaskStore } from "./db.js";
import { syncFromNotion } from "./notion.js";
import {
  buildSummary,
  formatSummaryText,
  previousBusinessDayStart,
  jpDateLabel,
} from "./summary.js";
import { buildSlackPayload, sendToSlack } from "./slack.js";
import type { LocalState, Task } from "./types.js";

const HELP = `localtask — Notion一方向同期のローカルタスク管理

使い方:
  localtask ui                   対話的TUIで閲覧・操作・編集（おすすめ）
  localtask sync                 NotionからローカルDBへ同期（pull）
  localtask list [opts]          残タスク一覧を表示
      --all                      アーカイブ含む全件
      --done                     完了タスクも含む
      --state <inbox|in_progress|undeployed|deployed>
  localtask show <No|id>         タスク詳細を表示
  localtask summary              残タスクのサマリを表示
  localtask notify               サマリをSlackへ送信
  localtask set <No|id> <state>  状態変更 (inbox|in_progress|undeployed|deployed)
  localtask note <No|id> <text>  ローカルメモを追記
  localtask tick                 同期 → Slack通知 を一括実行（スケジュール用）
  localtask help                 このヘルプ
`;

function withStore<T>(fn: (store: TaskStore) => T): T {
  const config = loadConfig();
  const store = new TaskStore(config.dbPath);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function printTask(t: Task, opts: { url?: boolean } = {}): void {
  const showUrl = opts.url ?? true;
  const flags: string[] = [t.localState];
  if (t.isDoneInNotion) flags.push("notion:done");
  if (t.archived) flags.push("archived");
  const due = t.dueDate ? ` 期限:${t.dueDate}` : "";
  console.log(`#${t.no} [${flags.join(",")}] ${t.title}${due}`);
  console.log(`    id:${t.id}${showUrl && t.url ? `  ${t.url}` : ""}`);
  if (t.agentNotes) console.log(`    memo: ${t.agentNotes}`);
}

const VALID_STATES: LocalState[] = [
  "inbox",
  "in_progress",
  "undeployed",
  "deployed",
];

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "ui":
    case "tui": {
      const { runTUI } = await import("./tui.js");
      await runTUI();
      break;
    }

    case "sync": {
      const config = loadConfig();
      requireNotionConfig(config);
      const store = new TaskStore(config.dbPath);
      try {
        console.log("Notionから同期中…");
        const r = await syncFromNotion(store, config);
        console.log(
          `完了: 新規${r.added} / 更新${r.updated} / アーカイブ${r.archived}（取得${r.total}件）`,
        );
      } finally {
        store.close();
      }
      break;
    }

    case "list": {
      const includeArchived = args.includes("--all");
      const includeDone = args.includes("--done") || includeArchived;
      const stateIdx = args.indexOf("--state");
      const localState =
        stateIdx >= 0 ? (args[stateIdx + 1] as LocalState) : undefined;
      withStore((store) => {
        const tasks = store.list({ includeArchived, includeDone, localState });
        if (tasks.length === 0) {
          console.log("該当するタスクはありません。");
          return;
        }
        tasks.forEach((t) => printTask(t, { url: false }));
        console.log(`\n計 ${tasks.length}件`);
      });
      break;
    }

    case "show": {
      const ref = args[0];
      if (!ref) throw new Error("No か id を指定してください: localtask show <No|id>");
      withStore((store) => {
        const t = store.resolve(ref);
        if (!t) {
          console.log("見つかりません。");
          return;
        }
        console.log(JSON.stringify(t, null, 2));
      });
      break;
    }

    case "summary": {
      withStore((store) => {
        const open = store.list();
        console.log(formatSummaryText(buildSummary(open)));
      });
      break;
    }

    case "notify": {
      const config = loadConfig();
      if (!config.slackWebhookUrl) {
        throw new Error("SLACK_WEBHOOK_URL が未設定です（.env を確認）。");
      }
      await withStore(async (store) => {
        const summary = buildSummary(store.list());
        const since = previousBusinessDayStart();
        const completed = store.completedSince(since.toISOString());
        const label = jpDateLabel(since);
        await sendToSlack(
          config.slackWebhookUrl!,
          buildSlackPayload(summary, completed, label),
        );
        console.log(
          `Slackへ送信しました（残${summary.total}件 / ${label}以降の完了${completed.length}件）。`,
        );
      });
      break;
    }

    case "set": {
      const [ref, state] = args;
      if (!ref || !VALID_STATES.includes(state as LocalState)) {
        throw new Error(
          `使い方: localtask set <No|id> <${VALID_STATES.join("|")}>`,
        );
      }
      withStore((store) => {
        const t = store.resolve(ref);
        if (!t) {
          console.log("見つかりません。");
          return;
        }
        const updated = store.updateLocal(
          t.id,
          { localState: state as LocalState },
          new Date().toISOString(),
        );
        if (updated) printTask(updated);
      });
      break;
    }

    case "note": {
      const [ref, ...rest] = args;
      const text = rest.join(" ");
      if (!ref || !text) {
        throw new Error("使い方: localtask note <No|id> <メモ本文>");
      }
      withStore((store) => {
        const existing = store.resolve(ref);
        if (!existing) {
          console.log("見つかりません。");
          return;
        }
        const stamp = new Date().toISOString();
        const merged = existing.agentNotes
          ? `${existing.agentNotes}\n[${stamp}] ${text}`
          : `[${stamp}] ${text}`;
        const updated = store.updateLocal(
          existing.id,
          { agentNotes: merged },
          stamp,
        );
        if (updated) printTask(updated);
      });
      break;
    }

    case "tick": {
      const config = loadConfig();
      requireNotionConfig(config);
      const store = new TaskStore(config.dbPath);
      try {
        console.log("[tick] 同期中…");
        const r = await syncFromNotion(store, config);
        console.log(
          `[tick] 同期完了: 新規${r.added} / 更新${r.updated} / アーカイブ${r.archived}`,
        );
        const summary = buildSummary(store.list());
        const since = previousBusinessDayStart();
        const completed = store.completedSince(since.toISOString());
        const label = jpDateLabel(since);
        console.log(formatSummaryText(summary));
        console.log(`✅ ${label}以降の完了: ${completed.length}件`);
        if (config.slackWebhookUrl) {
          await sendToSlack(
            config.slackWebhookUrl,
            buildSlackPayload(summary, completed, label),
          );
          console.log("[tick] Slack通知を送信しました。");
        } else {
          console.log("[tick] SLACK_WEBHOOK_URL未設定のため通知はスキップ。");
        }
      } finally {
        store.close();
      }
      break;
    }

    case "help":
    case undefined:
    case "--help":
    case "-h":
      console.log(HELP);
      break;

    default:
      console.error(`不明なコマンド: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("エラー:", err instanceof Error ? err.message : err);
  process.exit(1);
});
