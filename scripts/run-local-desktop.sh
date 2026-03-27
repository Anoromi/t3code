#!/usr/bin/env bash

set -euo pipefail

repo_root="$1"
shift || true

cd "$repo_root"

bun install --frozen-lockfile --linker=hoisted --ignore-scripts
bun run --cwd apps/web build
bun run build:desktop

exec bun run --cwd apps/desktop start -- "$@"
