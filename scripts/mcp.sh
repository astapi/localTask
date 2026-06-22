#!/bin/bash
# MCPクライアント（Claude Code等）から起動されるラッパー。
# npx/cwd依存を避け、プロジェクトのローカルtsxを直接実行する。stdioはexecで引き継ぐ。
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  D="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$D/$SOURCE"
done
source "$(cd -P "$(dirname "$SOURCE")" && pwd)/_lib.sh"
cd "$PROJECT_DIR" || exit 1
exec ./node_modules/.bin/tsx src/mcp-server.ts
