import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { LocalState, Task } from "./types.js";

/** DB行（snake_case / 0|1のboolean） */
interface Row {
  id: string;
  seq: number | null;
  title: string;
  notion_status: string | null;
  priority: string | null;
  due_date: string | null;
  assignee: string | null;
  url: string | null;
  notion_created_time: string | null;
  notion_last_edited_time: string | null;
  is_done_in_notion: number;
  body: string | null;
  local_state: string;
  agent_notes: string | null;
  local_updated_at: string | null;
  last_synced_at: string;
  completed_at: string | null;
  archived: number;
}

function rowToTask(r: Row): Task {
  return {
    id: r.id,
    no: r.seq ?? 0,
    title: r.title,
    notionStatus: r.notion_status,
    priority: r.priority,
    dueDate: r.due_date,
    assignee: r.assignee,
    url: r.url,
    notionCreatedTime: r.notion_created_time,
    notionLastEditedTime: r.notion_last_edited_time,
    isDoneInNotion: r.is_done_in_notion === 1,
    body: r.body,
    localState: r.local_state as LocalState,
    agentNotes: r.agent_notes,
    localUpdatedAt: r.local_updated_at,
    lastSyncedAt: r.last_synced_at,
    completedAt: r.completed_at,
    archived: r.archived === 1,
  };
}

/** done状態(Notion完了 or ローカルdone)に応じて completed_at を決める */
function computeCompletedAt(
  isDone: boolean,
  prevCompletedAt: string | null,
  fallback: string,
): string | null {
  if (!isDone) return null; // 再オープンはクリア
  return prevCompletedAt ?? fallback; // 既に記録があれば維持、なければ新規
}

/** Notion由来のフィールド（同期で上書きされる部分） */
export interface NotionFields {
  id: string;
  title: string;
  notionStatus: string | null;
  priority: string | null;
  dueDate: string | null;
  assignee: string | null;
  url: string | null;
  notionCreatedTime: string | null;
  notionLastEditedTime: string | null;
  isDoneInNotion: boolean;
  body: string | null;
}

export class TaskStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        notion_status TEXT,
        priority TEXT,
        due_date TEXT,
        assignee TEXT,
        url TEXT,
        notion_created_time TEXT,
        notion_last_edited_time TEXT,
        is_done_in_notion INTEGER NOT NULL DEFAULT 0,
        local_state TEXT NOT NULL DEFAULT 'inbox',
        agent_notes TEXT,
        local_updated_at TEXT,
        last_synced_at TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_local_state ON tasks(local_state);
      CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(archived);
    `);
    // 既存DBへのカラム追加（冪等）
    const cols = (this.db.prepare("PRAGMA table_info(tasks)").all() as {
      name: string;
    }[]).map((c) => c.name);
    if (!cols.includes("body")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN body TEXT");
    }
    if (!cols.includes("completed_at")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN completed_at TEXT");
    }
    if (!cols.includes("seq")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN seq INTEGER");
      // 既存タスクに作成順で採番（古い=小さいNo）
      const rows = this.db
        .prepare(
          "SELECT id FROM tasks ORDER BY notion_created_time ASC, id ASC",
        )
        .all() as { id: string }[];
      const upd = this.db.prepare("UPDATE tasks SET seq = ? WHERE id = ?");
      let i = 0;
      this.db.transaction(() => {
        for (const r of rows) upd.run(++i, r.id);
      })();
    }
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_seq ON tasks(seq)",
    );
    // 旧ローカル状態名を新名称へ移行（done→deployed, blocked→undeployed）
    this.db.exec(
      "UPDATE tasks SET local_state = 'deployed' WHERE local_state = 'done'",
    );
    this.db.exec(
      "UPDATE tasks SET local_state = 'undeployed' WHERE local_state = 'blocked'",
    );
  }

  private nextSeq(): number {
    const r = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM tasks")
      .get() as { n: number };
    return r.n;
  }

  /**
   * Notionから取得したタスクをupsertする。
   * 既存行のローカル専用フィールド（local_state, agent_notes等）は保持する。
   * @returns "added" | "updated"
   */
  upsertFromNotion(n: NotionFields, now: string): "added" | "updated" {
    const existing = this.db
      .prepare(
        "SELECT id, local_state, is_done_in_notion, completed_at FROM tasks WHERE id = ?",
      )
      .get(n.id) as
      | {
          id: string;
          local_state: string;
          is_done_in_notion: number;
          completed_at: string | null;
        }
      | undefined;

    if (existing) {
      // done = Notion完了 または ローカルでdone（local_stateは保持される）
      const isDone = n.isDoneInNotion || existing.local_state === "deployed";
      const wasDone =
        existing.is_done_in_notion === 1 ||
        existing.local_state === "deployed";
      // 新規完了(was→done)は今を記録。既に完了済みで未記録(マイグレ等)は最終編集時刻で代用。
      const fallback = wasDone ? (n.notionLastEditedTime ?? now) : now;
      const completedAt = computeCompletedAt(
        isDone,
        existing.completed_at,
        fallback,
      );
      this.db
        .prepare(
          `UPDATE tasks SET
             title = @title,
             notion_status = @notionStatus,
             priority = @priority,
             due_date = @dueDate,
             assignee = @assignee,
             url = @url,
             notion_created_time = @notionCreatedTime,
             notion_last_edited_time = @notionLastEditedTime,
             is_done_in_notion = @isDoneInNotion,
             body = @body,
             completed_at = @completedAt,
             last_synced_at = @now,
             archived = 0
           WHERE id = @id`,
        )
        .run({
          ...n,
          isDoneInNotion: n.isDoneInNotion ? 1 : 0,
          completedAt,
          now,
        });
      return "updated";
    }

    // 新規: 既にNotion完了済みなら、完了時刻は最終編集時刻で代用（初回の誤検知防止）
    const completedAt = n.isDoneInNotion
      ? (n.notionLastEditedTime ?? now)
      : null;
    this.db
      .prepare(
        `INSERT INTO tasks (
           id, seq, title, notion_status, priority, due_date, assignee, url,
           notion_created_time, notion_last_edited_time, is_done_in_notion, body,
           completed_at, local_state, agent_notes, local_updated_at, last_synced_at, archived
         ) VALUES (
           @id, @seq, @title, @notionStatus, @priority, @dueDate, @assignee, @url,
           @notionCreatedTime, @notionLastEditedTime, @isDoneInNotion, @body,
           @completedAt, 'inbox', NULL, NULL, @now, 0
         )`,
      )
      .run({
        ...n,
        seq: this.nextSeq(),
        isDoneInNotion: n.isDoneInNotion ? 1 : 0,
        completedAt,
        now,
      });
    return "added";
  }

  /** 指定IDセットに含まれない（=Notionから消えた）タスクをアーカイブ扱いにする */
  archiveMissing(presentIds: string[], now: string): number {
    if (presentIds.length === 0) {
      const res = this.db
        .prepare("UPDATE tasks SET archived = 1 WHERE archived = 0")
        .run();
      return res.changes;
    }
    const placeholders = presentIds.map(() => "?").join(",");
    const res = this.db
      .prepare(
        `UPDATE tasks SET archived = 1, last_synced_at = ?
         WHERE archived = 0 AND id NOT IN (${placeholders})`,
      )
      .run(now, ...presentIds);
    return res.changes;
  }

  list(opts: {
    includeArchived?: boolean;
    includeDone?: boolean;
    localState?: LocalState;
  } = {}): Task[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (!opts.includeArchived) where.push("archived = 0");
    // 明示的に状態指定があるときは「完了除外」を適用しない（deployed指定が空になるため）
    if (!opts.includeDone && !opts.localState) {
      where.push("local_state != 'deployed'");
      where.push("is_done_in_notion = 0");
    }
    if (opts.localState) {
      where.push("local_state = ?");
      params.push(opts.localState);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks ${clause}
         ORDER BY
           CASE
             WHEN priority IN ('High','HIGH','high','高') THEN 0
             WHEN priority IN ('Medium','MEDIUM','medium','Mid','中') THEN 1
             WHEN priority IN ('Low','LOW','low','低') THEN 2
             ELSE 3
           END,
           CASE WHEN due_date IS NULL THEN 1 ELSE 0 END,
           due_date ASC,
           notion_last_edited_time DESC`,
      )
      .all(...params) as Row[];
    return rows.map(rowToTask);
  }

  /** 指定時刻(ISO)以降に完了したタスクを新しい順で返す */
  completedSince(iso: string): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE completed_at IS NOT NULL AND completed_at >= ?
         ORDER BY completed_at DESC`,
      )
      .all(iso) as Row[];
    return rows.map(rowToTask);
  }

  get(id: string): Task | undefined {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? rowToTask(row) : undefined;
  }

  /** タスクNo（連番）で取得する */
  getByNo(no: number): Task | undefined {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE seq = ?")
      .get(no) as Row | undefined;
    return row ? rowToTask(row) : undefined;
  }

  /** No または NotionID でタスクを解決する */
  resolve(ref: string | number): Task | undefined {
    if (typeof ref === "number") return this.getByNo(ref);
    return /^\d+$/.test(ref) ? this.getByNo(parseInt(ref, 10)) : this.get(ref);
  }

  /**
   * ローカル専用フィールドを更新する（Notionには書き戻さない）。
   * agentNotes は undefined のとき据え置き、null/"" を渡すと明示的にクリアする。
   */
  updateLocal(
    id: string,
    patch: { localState?: LocalState; agentNotes?: string | null },
    now: string,
  ): Task | undefined {
    const task = this.get(id);
    if (!task) return undefined;
    const nextNotes =
      patch.agentNotes !== undefined ? patch.agentNotes : task.agentNotes;
    const nextState = patch.localState ?? task.localState;
    const isDone = task.isDoneInNotion || nextState === "deployed";
    const completedAt = computeCompletedAt(isDone, task.completedAt, now);
    this.db
      .prepare(
        `UPDATE tasks SET
           local_state = @localState,
           agent_notes = @agentNotes,
           completed_at = @completedAt,
           local_updated_at = @now
         WHERE id = @id`,
      )
      .run({
        id,
        localState: nextState,
        agentNotes: nextNotes && nextNotes.length ? nextNotes : null,
        completedAt,
        now,
      });
    return this.get(id);
  }

  close(): void {
    this.db.close();
  }
}
