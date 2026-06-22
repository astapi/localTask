import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, requireNotionConfig } from "./config.js";
import { TaskStore } from "./db.js";
import { syncFromNotion } from "./notion.js";
import { buildSummary } from "./summary.js";
import type { LocalState, Task } from "./types.js";

const config = loadConfig();
const store = new TaskStore(config.dbPath);

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function compact(t: Task) {
  return {
    no: t.no,
    id: t.id,
    title: t.title,
    localState: t.localState,
    notionStatus: t.notionStatus,
    priority: t.priority,
    dueDate: t.dueDate,
    assignee: t.assignee,
    url: t.url,
    agentNotes: t.agentNotes,
    isDoneInNotion: t.isDoneInNotion,
  };
}

const server = new McpServer({
  name: "localtask",
  version: "0.1.0",
});

server.tool(
  "list_tasks",
  "ローカルのタスク一覧を取得する。残タスク（未完了）がデフォルト。フィルタ指定可。",
  {
    includeDone: z.boolean().optional().describe("完了タスクも含めるか"),
    includeArchived: z.boolean().optional().describe("アーカイブも含めるか"),
    localState: z
      .enum(["inbox", "in_progress", "undeployed", "deployed"])
      .optional()
      .describe("ローカル状態で絞り込む"),
  },
  async ({ includeDone, includeArchived, localState }) => {
    const tasks = store.list({
      includeDone,
      includeArchived,
      localState: localState as LocalState | undefined,
    });
    return ok({ count: tasks.length, tasks: tasks.map(compact) });
  },
);

server.tool(
  "get_task",
  "タスク詳細（本文込み）を取得する。No か NotionID のどちらかを指定。",
  {
    no: z.number().int().optional().describe("タスクNo（連番）"),
    id: z.string().optional().describe("NotionページID"),
  },
  async ({ no, id }) => {
    const t = no != null ? store.getByNo(no) : id ? store.get(id) : undefined;
    return t ? ok(t) : ok({ error: "not found", no, id });
  },
);

server.tool(
  "get_summary",
  "残タスクのサマリ（期限超過/期限間近/未デプロイ/進行中/未着手）を取得する。",
  {},
  async () => {
    const s = buildSummary(store.list());
    return ok({
      total: s.total,
      counts: {
        inProgress: s.inProgress.length,
        undeployed: s.undeployed.length,
        inbox: s.inbox.length,
        overdue: s.overdue.length,
        dueSoon: s.dueSoon.length,
      },
      overdue: s.overdue.map(compact),
      dueSoon: s.dueSoon.map(compact),
      undeployed: s.undeployed.map(compact),
      inProgress: s.inProgress.map(compact),
    });
  },
);

server.tool(
  "update_task_state",
  "タスクのローカル状態を変更する（Notionには書き戻さない）。着手=in_progress、実装済み未デプロイ=undeployed、デプロイ済(完了)=deployed。No か id を指定。",
  {
    no: z.number().int().optional().describe("タスクNo（連番）"),
    id: z.string().optional().describe("NotionページID"),
    localState: z.enum(["inbox", "in_progress", "undeployed", "deployed"]),
  },
  async ({ no, id, localState }) => {
    const target = no != null ? store.getByNo(no) : id ? store.get(id) : undefined;
    if (!target) return ok({ error: "not found", no, id });
    const updated = store.updateLocal(
      target.id,
      { localState: localState as LocalState },
      new Date().toISOString(),
    );
    return updated ? ok(compact(updated)) : ok({ error: "update failed", no, id });
  },
);

server.tool(
  "add_task_note",
  "タスクにメモを追記する（進捗・調査結果・ブロック理由などをエージェントが記録する用途）。No か id を指定。",
  {
    no: z.number().int().optional().describe("タスクNo（連番）"),
    id: z.string().optional().describe("NotionページID"),
    note: z.string().describe("追記するメモ本文"),
  },
  async ({ no, id, note }) => {
    const existing = no != null ? store.getByNo(no) : id ? store.get(id) : undefined;
    if (!existing) return ok({ error: "not found", no, id });
    const stamp = new Date().toISOString();
    const merged = existing.agentNotes
      ? `${existing.agentNotes}\n[${stamp}] ${note}`
      : `[${stamp}] ${note}`;
    const updated = store.updateLocal(existing.id, { agentNotes: merged }, stamp);
    return ok(updated ? compact(updated) : { error: "update failed", no, id });
  },
);

server.tool(
  "sync_from_notion",
  "Notionから最新タスクをローカルへ同期する（一方向pull）。ローカルの状態・メモは保持される。",
  {},
  async () => {
    requireNotionConfig(config);
    const r = await syncFromNotion(store, config);
    return ok(r);
  },
);

async function run(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdoutはMCPプロトコル専用。ログはstderrへ。
  console.error("[localtask-mcp] started");
}

run().catch((err) => {
  console.error("[localtask-mcp] fatal:", err);
  process.exit(1);
});
