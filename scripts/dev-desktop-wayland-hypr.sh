#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

workspace=""
hypr_args=()

while (($# > 0)); do
  case "$1" in
    --workspace)
      if (($# < 2)); then
        printf '%s\n' "Missing value for '--workspace'." >&2
        exit 1
      fi
      if [[ ! "$2" =~ ^[1-9][0-9]*$ ]]; then
        printf '%s\n' "Invalid '--workspace' value '$2': expected a positive integer." >&2
        exit 1
      fi
      workspace="$2"
      shift 2
      ;;
    *)
      hypr_args+=("$1")
      shift
      ;;
  esac
done

if [[ -z "$workspace" ]]; then
  workspace=$(node "$SCRIPT_DIR/hypr-worktree.ts" where "${hypr_args[@]}")
fi

exec node "$SCRIPT_DIR/hypr-worktree.ts" \
  spawn \
  --silent \
  --workspace "$workspace" \
  "${hypr_args[@]}" \
  -- \
  "T3CODE_HYPR_WORKSPACE=$workspace bun run dev:desktop:wayland"
