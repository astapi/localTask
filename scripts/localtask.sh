#!/bin/bash
# どのディレクトリからでも localtask CLI/TUI を実行するラッパー。
# 例: ~/.local/bin/localtask -> このスクリプト へのシンボリックリンク
# シンボリックリンク経由でも実体の場所を解決する
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  D="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$D/$SOURCE"
done
source "$(cd -P "$(dirname "$SOURCE")" && pwd)/_lib.sh"
cd "$PROJECT_DIR" || exit 1
exec ./node_modules/.bin/tsx src/cli.ts "$@"
