#!/bin/bash
# launchd / cron から毎朝呼ばれる定期実行ラッパー。
# Notion同期 → 残タスクサマリ → Slack通知 を実行し、ログに追記する。
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  D="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$D/$SOURCE"
done
source "$(cd -P "$(dirname "$SOURCE")" && pwd)/_lib.sh"
cd "$PROJECT_DIR" || exit 1
mkdir -p "$PROJECT_DIR/data"
LOG_FILE="$PROJECT_DIR/data/tick.log"

{
  echo "===== $(date '+%Y-%m-%d %H:%M:%S') tick start ====="
  ./node_modules/.bin/tsx src/cli.ts tick
  echo "===== $(date '+%Y-%m-%d %H:%M:%S') tick end (exit=$?) ====="
  echo ""
} >> "$LOG_FILE" 2>&1
