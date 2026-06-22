/** ローカルで保持するタスクの状態（Notion同期では上書きされない） */
export type LocalState =
  | "inbox" // 未着手（Notionから来たまま）
  | "in_progress" // 進行中
  | "undeployed" // 未デプロイ（実装済みだが未デプロイ）
  | "deployed"; // デプロイ済（=完了）

export interface Task {
  /** NotionページID（主キー） */
  id: string;
  /** 人間が参照しやすい連番（採番後は不変） */
  no: number;
  title: string;
  /** Notion上のステータス文字列（同期で上書き） */
  notionStatus: string | null;
  priority: string | null;
  dueDate: string | null; // ISO日付
  assignee: string | null;
  url: string | null;
  notionCreatedTime: string | null;
  notionLastEditedTime: string | null;
  /** Notionで完了扱いか */
  isDoneInNotion: boolean;
  /** ページ本文をテキスト化したもの（同期で更新） */
  body: string | null;

  // --- ローカル専用フィールド（同期で保持される） ---
  localState: LocalState;
  /** エージェントや人が残したメモ */
  agentNotes: string | null;
  /** ローカルで着手/更新した最終時刻 */
  localUpdatedAt: string | null;

  // --- メタ ---
  lastSyncedAt: string;
  /** 完了（Notion完了 or ローカルdone）になった時刻。再オープンでnullに戻る */
  completedAt: string | null;
  /** Notion側から削除/アーカイブされたか */
  archived: boolean;
}

export interface SyncResult {
  added: number;
  updated: number;
  archived: number;
  total: number;
}
