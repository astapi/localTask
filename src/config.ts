import "dotenv/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

export interface Config {
  notionToken: string;
  /** 新Notion APIのデータソースID（databases.query ではなく dataSources.query を使う） */
  notionDataSourceId: string;
  props: {
    status: string;
    due: string;
    priority: string;
    assignee: string;
  };
  /** select型プロパティでの絞り込み（例: Project = Pody）。値が空なら絞り込まない */
  filter: {
    property: string;
    value: string | undefined;
  };
  doneStatuses: string[];
  slackWebhookUrl: string | undefined;
  dbPath: string;
}

function splitCsv(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): Config {
  return {
    notionToken: process.env.NOTION_TOKEN ?? "",
    notionDataSourceId: process.env.NOTION_DATA_SOURCE_ID ?? "",
    props: {
      status: process.env.NOTION_PROP_STATUS ?? "Status",
      due: process.env.NOTION_PROP_DUE ?? "Due date",
      priority: process.env.NOTION_PROP_PRIORITY ?? "Priority",
      assignee: process.env.NOTION_PROP_ASSIGNEE ?? "Assignee",
    },
    filter: {
      property: process.env.NOTION_FILTER_PROPERTY ?? "Project",
      value: process.env.NOTION_FILTER_VALUE || undefined,
    },
    doneStatuses: splitCsv(process.env.DONE_STATUSES, [
      "Done",
      "完了",
      "Complete",
      "Closed",
    ]),
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || undefined,
    dbPath:
      process.env.LOCALTASK_DB ||
      path.join(projectRoot, "data", "localtask.db"),
  };
}

/** Notion同期に必要な設定が揃っているか検証する */
export function requireNotionConfig(config: Config): void {
  const missing: string[] = [];
  if (!config.notionToken) missing.push("NOTION_TOKEN");
  if (!config.notionDataSourceId) missing.push("NOTION_DATA_SOURCE_ID");
  if (missing.length > 0) {
    throw new Error(
      `Notion同期に必要な環境変数が未設定です: ${missing.join(", ")}\n` +
        `.env を作成して設定してください（.env.example を参照）。`,
    );
  }
}
