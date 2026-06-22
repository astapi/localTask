import { Client } from "@notionhq/client";
import type { Config } from "./config.js";
import type { NotionFields } from "./db.js";
import { TaskStore } from "./db.js";
import type { SyncResult } from "./types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type NotionPage = any;

/** プレーンテキストを rich_text / title 配列から抽出 */
function plainText(prop: any): string | null {
  if (!prop) return null;
  const arr = prop.title ?? prop.rich_text;
  if (Array.isArray(arr)) {
    const text = arr.map((t: any) => t.plain_text ?? "").join("").trim();
    return text || null;
  }
  return null;
}

/** ステータス系プロパティ（status / select / formula等）から文字列を取り出す */
function readStatusLike(prop: any): string | null {
  if (!prop) return null;
  switch (prop.type) {
    case "status":
      return prop.status?.name ?? null;
    case "select":
      return prop.select?.name ?? null;
    case "multi_select":
      return prop.multi_select?.map((s: any) => s.name).join(", ") || null;
    case "checkbox":
      return prop.checkbox ? "Done" : "Todo";
    case "formula":
      return prop.formula?.string ?? prop.formula?.number?.toString() ?? null;
    default:
      return null;
  }
}

function readDate(prop: any): string | null {
  if (!prop) return null;
  if (prop.type === "date") return prop.date?.start ?? null;
  return null;
}

function readPeople(prop: any): string | null {
  if (!prop) return null;
  if (prop.type === "people") {
    return prop.people?.map((p: any) => p.name).filter(Boolean).join(", ") || null;
  }
  if (prop.type === "rich_text") return plainText(prop);
  return null;
}

/** ページのタイトル列を自動検出して取り出す */
function readTitle(page: NotionPage): string {
  const props = page.properties ?? {};
  for (const key of Object.keys(props)) {
    if (props[key]?.type === "title") {
      return plainText(props[key]) ?? "(無題)";
    }
  }
  return "(無題)";
}

export function mapPageToFields(
  page: NotionPage,
  config: Config,
): NotionFields {
  const props = page.properties ?? {};
  const status = readStatusLike(props[config.props.status]);
  const isDone =
    status != null &&
    config.doneStatuses.some(
      (d) => d.toLowerCase() === status.toLowerCase(),
    );

  return {
    id: page.id,
    title: readTitle(page),
    notionStatus: status,
    priority: readStatusLike(props[config.props.priority]),
    dueDate: readDate(props[config.props.due]),
    assignee: readPeople(props[config.props.assignee]),
    url: page.url ?? null,
    notionCreatedTime: page.created_time ?? null,
    notionLastEditedTime: page.last_edited_time ?? null,
    isDoneInNotion: isDone,
    body: null, // 本文は後段で取得する
  };
}

/** 1ブロックをMarkdown風の1行に変換（対象外はnull） */
function renderBlock(b: any, depth: number): string | null {
  const indent = "  ".repeat(depth);
  const rt: string = (b[b.type]?.rich_text ?? [])
    .map((r: any) => r.plain_text ?? "")
    .join("");
  switch (b.type) {
    case "heading_1":
      return `${indent}# ${rt}`;
    case "heading_2":
      return `${indent}## ${rt}`;
    case "heading_3":
      return `${indent}### ${rt}`;
    case "bulleted_list_item":
      return `${indent}- ${rt}`;
    case "numbered_list_item":
      return `${indent}1. ${rt}`;
    case "to_do":
      return `${indent}- [${b.to_do?.checked ? "x" : " "}] ${rt}`;
    case "quote":
      return `${indent}> ${rt}`;
    case "callout":
      return `${indent}💡 ${rt}`;
    case "toggle":
      return `${indent}▸ ${rt}`;
    case "code":
      return `${indent}\`\`\`\n${indent}${rt}\n${indent}\`\`\``;
    case "divider":
      return `${indent}---`;
    case "paragraph":
      return rt ? `${indent}${rt}` : "";
    default:
      return rt ? `${indent}${rt}` : null;
  }
}

/** ページ本文ブロックを再帰的にテキスト化する */
async function blocksToText(
  client: Client,
  blockId: string,
  depth = 0,
  budget = { n: 0 },
): Promise<string[]> {
  if (depth > 3 || budget.n > 400) return [];
  const lines: string[] = [];
  let cursor: string | undefined = undefined;
  do {
    const res: any = await client.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const b of res.results) {
      budget.n++;
      const line = renderBlock(b, depth);
      if (line !== null) lines.push(line);
      if (
        b.has_children &&
        b.type !== "child_page" &&
        b.type !== "child_database"
      ) {
        lines.push(...(await blocksToText(client, b.id, depth + 1, budget)));
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return lines;
}

/** データソースの全ページを取得（ページネーション + 任意のselectフィルタ） */
async function fetchAllPages(
  client: Client,
  config: Config,
): Promise<NotionPage[]> {
  const filter = config.filter.value
    ? {
        property: config.filter.property,
        select: { equals: config.filter.value },
      }
    : undefined;

  const pages: NotionPage[] = [];
  let cursor: string | undefined = undefined;
  do {
    const res: any = await client.dataSources.query({
      data_source_id: config.notionDataSourceId,
      filter,
      start_cursor: cursor,
      page_size: 100,
    });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return pages;
}

/** Notion → ローカルへ一方向同期する */
export async function syncFromNotion(
  store: TaskStore,
  config: Config,
): Promise<SyncResult> {
  const client = new Client({ auth: config.notionToken });
  const pages = await fetchAllPages(client, config);
  const now = new Date().toISOString();

  let added = 0;
  let updated = 0;
  const presentIds: string[] = [];

  for (const page of pages) {
    const fields = mapPageToFields(page, config);
    presentIds.push(fields.id);

    // 本文は「未取得」または「Notion側で更新された」場合のみ取り直す（高速化）
    const existing = store.get(fields.id);
    if (
      existing &&
      existing.body !== null &&
      existing.notionLastEditedTime === fields.notionLastEditedTime
    ) {
      fields.body = existing.body;
    } else {
      const lines = await blocksToText(client, fields.id);
      fields.body = lines.join("\n") || null;
    }

    const result = store.upsertFromNotion(fields, now);
    if (result === "added") added++;
    else updated++;
  }

  const archived = store.archiveMissing(presentIds, now);

  return { added, updated, archived, total: pages.length };
}
