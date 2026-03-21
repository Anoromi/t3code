#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

exec node "$SCRIPT_DIR/hypr-worktree.ts" spawn "$@" -- 'bun run dev:desktop:wayland'
