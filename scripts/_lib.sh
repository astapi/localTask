#!/bin/bash
# 共通: プロジェクトルートの解決と node の PATH 確保。
# 各ラッパーは `source "$(dirname "$0")/_lib.sh"` してから localtask_exec を呼ぶ。
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# launchd / MCP クライアントは最小PATHで起動するため、node を明示的に探して通す。
if ! command -v node >/dev/null 2>&1; then
  for d in \
    "$HOME/.anyenv/envs/nodenv/shims" \
    "$HOME/.nodenv/shims" \
    "$HOME/.local/share/mise/shims" \
    "$HOME/.volta/bin" \
    /opt/homebrew/bin \
    /usr/local/bin; do
    if [ -x "$d/node" ]; then
      PATH="$d:$PATH"
      break
    fi
  done
fi
export PATH
