# localtask

Notion のプロジェクト/タスクDBと **一方向（Notion → ローカル）** で同期する、ローカル完結のタスク管理ツール。
CLI で確認・操作でき、MCP サーバー経由で AI エージェント（Claude Code）からもタスクを読み書きできます。
残タスクのサマリは Slack に通知します。

## 特徴

- **Notion → ローカル同期（pull）**: Notion を正として SQLite に取り込み。ローカルやエージェントの変更は Notion に書き戻しません。
- **本文も同期**: 各タスクのページ本文をMarkdown風テキストに変換して保存（TUI詳細・MCPの `get_task` で参照可）。本文は変更されたページのみ再取得するため、2回目以降の同期は高速。
- **ローカル状態の保持**: `local_state`（inbox / in_progress / blocked / done）と `agent_notes` は同期で上書きされません。エージェントが進めた進捗が再同期で消えません。
- **Slack サマリ通知**: 期限超過 / 期限間近 / ブロック中 / 進行中 をまとめて通知。
- **MCP サーバー**: エージェントがローカルタスクを一覧・更新・メモ追記・再同期できます。
- **スケジュール実行向け `tick`**: 「同期 → サマリ → Slack 通知」を一括実行。

## セットアップ

```bash
npm install
cp .env.example .env   # 値を埋める
```

### .env の主な項目

| 変数 | 説明 |
|------|------|
| `NOTION_TOKEN` | Notion インテグレーションのトークン（https://www.notion.so/my-integrations で発行） |
| `NOTION_DATA_SOURCE_ID` | 同期対象データソースのID（新Notion API。下記参照） |
| `NOTION_FILTER_PROPERTY` / `NOTION_FILTER_VALUE` | select型プロパティでの絞り込み（例: `Project` = `Pody`）。値が空なら全件 |
| `NOTION_PROP_STATUS` 等 | あなたのDBの列名に合わせる（タイトル列は自動検出） |
| `DONE_STATUSES` | 完了とみなすステータス値（カンマ区切り） |
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook の URL |

> **接続必須**: Notion 側で、同期対象データベース（リンクドビューではなく**本体**）にインテグレーションを **Connections（コネクト）** から追加してください。これがないと「does not contain any data sources accessible by this API bot」エラーになります。
>
> **データソースID の調べ方**（新API 2025-09-03 以降、DBはデータソースを内包）:
> 接続後に `search` APIを叩くと、アクセス可能な `data_source` オブジェクトの `id` が返ります。リンクドDB（他DBのビュー）はデータソースを持たないため、必ず本体DBを接続すること。

## TUI（対話的に閲覧・操作・編集）

```bash
npm run ui            # または: npm run localtask -- ui
```

キーボードで一覧を操作できます:

| キー | 操作 |
|------|------|
| `↑`/`↓` または `j`/`k` | カーソル移動（`g`/`G` で先頭/末尾） |
| `Enter` / `→` | タスク詳細を開く（`Esc`/`←` で戻る） |
| `Tab` | フィルタ切替（未完了 / 未着手 / 進行中 / 未デプロイ / デプロイ済 / 全件） |
| `i` / `p` / `b` / `x` | 状態変更（進行中 / 未着手 / 未デプロイ / デプロイ済） |
| `u` | **直前の変更を取り消す（Undo）** — 操作ミスのやり直しに。連続Undo可 |
| `r` | リストを更新（状態変更で消えた分のフィルタを再適用） |
| `e` | メモを編集（全置換） |
| `a` | メモを追記（詳細画面のみ、タイムスタンプ付き） |
| `o` | Notion を既定ブラウザで開く |
| `s` | Notion から同期 |
| `/` | タイトル検索 |
| `q` / `Ctrl+C` | 終了 |

メモ編集・検索の**入力中**は: `Enter` 確定 / `Esc`・`Ctrl+C` キャンセル / `Ctrl+U` 全消去。
（入力中は生モードのまま自前入力するため、ターミナルが固まりません）

各行は `[ローカル状態] タイトル  ·Notionステータス` の形式です。先頭の `[未着手]/[進行中]/[未デプロイ]/[デプロイ済]` がローカル状態で、`i/p/b/x` を押すと**選択行のタグが即座に変化**します（**デプロイ済＝完了扱い**）。末尾の `·…`（薄字）は Notion 上のステータス（同期で更新、ローカル操作では変わりません）。

> 状態変更してもその行は**すぐには一覧から消えません**（誤操作対策）。`r`（更新）/ `Tab`（フィルタ切替）/ 同期 / 再起動のタイミングでフィルタが再適用され、デプロイ済は「未完了」ビューから外れます。

> 状態変更・メモはローカル専用フィールドなので Notion には書き戻されず、再同期しても保持されます。

#### 表示位置の調整（Warp等で上部が隠れる場合）

一部のターミナル（Warp など）では画面上部にオーバーレイが出て先頭行が隠れることがあります。既定で上部に3行の余白を空けて下寄せ表示しますが、環境変数で調整できます:

```bash
LOCALTASK_TUI_TOP=6 npm run ui   # 上部の余白を6行に
```

## CLI

```bash
npm run localtask -- sync          # Notionから同期
npm run localtask -- list          # 残タスク一覧
npm run localtask -- list --done   # 完了も含める
npm run localtask -- summary       # サマリ表示
npm run localtask -- notify        # Slackへサマリ送信
npm run localtask -- set <id> in_progress   # ローカル状態変更
npm run localtask -- note <id> "調査メモ"     # メモ追記
npm run localtask -- tick          # 同期→サマリ→Slack を一括（スケジュール用）
npm run localtask -- help
```

(`npm run sync` / `npm run summary` / `npm run tick` のショートカットもあります)

## MCP サーバー（エージェント連携）

提供ツール:

| ツール | 用途 |
|--------|------|
| `list_tasks` | タスク一覧（各タスクに `no`＝連番を含む） |
| `get_task` | タスク詳細取得（本文込み）。`no` か `id` で指定 |
| `get_summary` | 残タスクのサマリ取得 |
| `update_task_state` | ローカル状態を変更（`no`/`id`指定。進行中=in_progress / 未デプロイ=undeployed / デプロイ済(完了)=deployed） |
| `add_task_note` | 進捗・調査結果・ブロック理由をメモ追記（`no`/`id`指定） |
| `sync_from_notion` | Notionから最新を取り込み |

> **タスクNo**: 各タスクに短い連番（`#88` など）が付きます。採番後は不変。Claude Code には「**タスク88をやって**」のように No で伝えれば、`get_task` / `update_task_state` / `add_task_note` が `no` で解決します。タイトルやUUIDを伝える必要はありません。

### 登録方法

`scripts/mcp.sh` を MCP サーバーとして登録します（`npx` 依存やcwd依存を避けるラッパー）。

```bash
# 全プロジェクトから使う（推奨）
claude mcp add --scope user localtask "$PWD/scripts/mcp.sh"

# または、このリポジトリ限定で使うなら .mcp.json.example をコピーして編集
cp .mcp.json.example .mcp.json   # command を絶対パスに書き換える
```

登録後 `claude mcp list` で `✔ Connected`、Claude Code 内では `/mcp` で確認できます。

## 定期実行（スケジュール）

### A. Claude Code のスケジュール実行（エージェントに自動で進めてもらう）

Claude Code 内で `/schedule` を使い、例えば毎朝 9 時に以下のようなプロンプトを定期実行します:

> localtask MCP の `sync_from_notion` で同期し、`get_summary` で残タスクを確認。
> 自分（エージェント）が進められるタスクは着手して `update_task_state` を in_progress に、
> 進捗や結論は `add_task_note` に記録。最後に残タスクのサマリを報告して。

### B. macOS launchd で毎朝8:30に同期＋Slack通知（設定済み）

AIを使わず確実に「同期→残タスクをSlack通知」を回す構成。以下が導入済み:

- `scripts/run-tick.sh` … node を自動検出し `localtask tick` を実行してログ追記するラッパー
- `~/Library/LaunchAgents/com.localtask.tick.plist` … 毎日 8:30 に上記を起動

管理コマンド:

```bash
# 登録状態の確認
launchctl list | grep localtask

# 今すぐ手動実行（テスト）
launchctl kickstart -k gui/$(id -u)/com.localtask.tick
# または直接: bash scripts/run-tick.sh

# 一時停止 / 再開
launchctl unload ~/Library/LaunchAgents/com.localtask.tick.plist
launchctl load   ~/Library/LaunchAgents/com.localtask.tick.plist

# 実行ログ
tail -f data/tick.log
```

> 時刻変更は plist の `Hour` / `Minute` を編集 → `unload` → `load` で反映。
> Mac がスリープ中だと 8:30 ちょうどには動かないことがあります（次回起動時の取りこぼし実行が必要なら `StartCalendarInterval` に加えて運用を調整してください）。

## アーキテクチャ

```
Notion DB ──(pull)──▶ notion.ts ──▶ db.ts (SQLite) ──┬──▶ cli.ts（人が確認・操作）
                                                      ├──▶ mcp-server.ts（AIエージェント）
                                                      └──▶ summary.ts ──▶ slack.ts（通知）
```

- ローカル専用フィールド（`local_state` / `agent_notes`）は同期で保持。
- 同期方向は Notion → ローカルのみ。Notion を編集すれば次回同期で反映されます。
