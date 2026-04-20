#!/usr/bin/env bash

set -euo pipefail

repo_root="$1"
shift || true

cd "$repo_root"

# `nix develop` commonly launches child commands with `TERM=dumb` and
# `IN_NIX_SHELL=impure`. The desktop app should not inherit prompt state from
# that wrapper shell because embedded PTY shells then start with broken prompt
# rendering and readline behavior.
if [ -z "${TERM:-}" ] || [ "${TERM:-}" = "dumb" ]; then
  export TERM="xterm-256color"
fi

unset IN_NIX_SHELL PS1 PS2 PS3 PS4 PROMPT PROMPT_COMMAND RPROMPT RPS1 SPROMPT

exec node scripts/local-desktop-launch.ts --repo-root "$repo_root" -- "$@"
