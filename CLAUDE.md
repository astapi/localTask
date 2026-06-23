# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## このプロジェクト

Notion のタスクDBと **一方向（Notion → ローカル）** で同期する、ローカル完結のタスク管理ツール。
SQLite に取り込んだタスクを CLI / TUI から操作でき、MCP サーバー経由で AI エージェント（Claude Code）からも読み書きできる。残タスクのサマリは Slack に通知する。

## コマンド

ビルド工程はなく、`tsx` で `.ts` を直接実行する（ESM, `"type": "module"`）。

```bash
npm install
npm run typecheck                  # tsc --noEmit（唯一の検証手段。テストは無い）

npm run ui                         # 対話的TUI
npm run localtask -- sync          # Notion→ローカル同期
npm run localtask -- list [--all|--done|--state <s>]
npm run localtask -- show <No|id>
npm run localtask -- summary
npm run localtask -- notify        # Slackへサマリ送信
npm run localtask -- set <No|id> <inbox|in_progress|undeployed|deployed>
npm run localtask -- note <No|id> "<メモ>"
npm run localtask -- tick          # 同期→サマリ→Slack を一括（スケジュール用）
npm run mcp                        # MCPサーバーを起動（通常はscripts/mcp.sh経由）
```

テストフレームワークは導入されていない。変更後の検証は `npm run typecheck` と、必要に応じて実コマンド実行で行う。

## アーキテクチャ

データは Notion から一方向に流れ、ローカルでフィルタ・表示・状態管理される。

```
Notion DataSource ─(pull)─▶ notion.ts ─▶ db.ts (SQLite) ─┬─▶ cli.ts / tui.ts（人）
                                                          ├─▶ mcp-server.ts（エージェント）
                                                          └─▶ summary.ts ─▶ slack.ts（通知）
```

- `src/config.ts` — `.env` 読み込みと検証。Notionプロパティ名のマッピング、selectフィルタ、`doneStatuses`、`dbPath` を集約。全モジュールがここから `Config` を受け取る。
- `src/notion.ts` — `syncFromNotion()` が同期の中核。新Notion API（2025-09-03以降）の `dataSources.query` を使う（`databases.query` ではない）。ページ本文は再帰的にMarkdown風テキストへ変換する。
- `src/db.ts` — `TaskStore` クラスが SQLite アクセスを全て担う。コンストラクタで冪等な `migrate()` を実行（後述）。
- `src/summary.ts` — 残タスクから集計（期限超過/間近/未デプロイ/進行中/未着手）。Slack/ターミナル両用の整形を提供。
- `src/cli.ts` — コマンドディスパッチ。`bin` エントリでもある。
- `src/mcp-server.ts` — 6つのMCPツールを公開。`TaskStore` をプロセス常駐で1つ保持する。
- `src/tui.ts` — 端末の生モード制御を含む対話UI（最大ファイル）。

### 同期で守るべき不変条件（最重要）

同期は **Notion → ローカルの一方向のみ**。ローカルやエージェントの変更を Notion に書き戻すコードは存在しないし、足してはならない。

`tasks` テーブルのフィールドは2系統に分かれる:

- **Notion由来**（同期で上書き）: `title`, `notion_status`, `priority`, `due_date`, `assignee`, `url`, `body`, `is_done_in_notion` 等
- **ローカル専用**（同期で保持）: `local_state`, `agent_notes`, `local_updated_at`, `seq`

`upsertFromNotion()` は既存行の `local_state` / `agent_notes` を決して触らない。これによりエージェントの進捗が再同期で消えない。新しいフィールドを足すときはこの分類のどちらに属するかを必ず判断すること。

### LocalState と「完了」の定義

`LocalState = inbox | in_progress | undeployed | deployed`（`src/types.ts`）。

- **`deployed` がローカルの完了状態**（旧名 `done`）。`undeployed` は旧 `blocked`。`migrate()` が旧名を自動移行する。
- タスクが「完了」かの判定は常に **`isDoneInNotion || localState === "deployed"`**。`completed_at` はこの done 状態への遷移時刻で、再オープンで `null` に戻る（`computeCompletedAt()`）。
- 状態名やこの判定式を変える場合、`db.ts` / `cli.ts` / `mcp-server.ts` / `tui.ts` の全箇所を揃えること。

### タスクNo（seq）

各タスクに人間参照用の不変連番 `seq`（表示は `#88`）を採番する。エージェントには「タスク88をやって」のように No で指示が来る前提。`store.resolve(ref)` が「数字文字列→No、それ以外→NotionID」で解決する。No・ID どちらでも引けるようにするのが規約。

### マイグレーション

スキーマ変更は `db.ts` の `migrate()` 内で行う。`CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` でのカラム存在チェック + `ALTER TABLE` という冪等パターン。マイグレーションフレームワークは使わない。既存DB（`data/localtask.db`）を壊さないよう、必ず冪等に書く。

### 本文取得の最適化

同期時、ページ本文（`body`）は「未取得」か「`notion_last_edited_time` が変化した」場合のみ再取得する。大量タスクの再同期を高速化するこの条件を崩さないこと。

## 設定（.env）

`requireNotionConfig()` が `NOTION_TOKEN` と `NOTION_DATA_SOURCE_ID` を必須チェックする。`NOTION_DATA_SOURCE_ID` は新API のデータソースID（DBではなくデータソース）。`.env.example` がテンプレート。

## スクリプト / 配布

`scripts/*.sh` は `npx`・cwd 依存を避けるラッパー。`_lib.sh` がプロジェクトルート解決と `node` の PATH 補完を担い、他3つが `source` する（launchd / MCPクライアントは最小PATHで起動するため）。

- `mcp.sh` — MCPサーバー登録用（`claude mcp add --scope user localtask "$PWD/scripts/mcp.sh"`）
- `localtask.sh` — どこからでもCLI/TUIを呼ぶ（`~/.local/bin/localtask` へシンボリックリンク想定）
- `run-tick.sh` — launchd から毎朝 `tick` を実行しログ追記（`data/tick.log`）
