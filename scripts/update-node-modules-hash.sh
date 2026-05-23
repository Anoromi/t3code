#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
bun_file="$repo_root/nix/bun.nix"
fake_hash="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

current_hash="$(sed -nE 's/^[[:space:]]*hash = "([^"]+)";$/\1/p' "$bun_file" | head -n1)"
if [[ -z "$current_hash" ]]; then
  echo "update-node-modules-hash: could not find hash in $bun_file" >&2
  exit 1
fi

replace_hash() {
  local hash="$1"
  UPDATE_HASH="$hash" perl -0pi -e 's/hash = "sha256-[^"]+";/qq{hash = "$ENV{UPDATE_HASH}";}/e' "$bun_file"
}

replace_hash "$fake_hash"

set +e
build_output="$(cd "$repo_root" && nix build .#nodeModules --no-link 2>&1)"
build_status=$?
set -e

new_hash="$(printf '%s\n' "$build_output" | sed -nE 's/^[[:space:]]*got:[[:space:]]*(sha256-[^[:space:]]+)$/\1/p' | tail -n1)"
if [[ -z "$new_hash" ]]; then
  replace_hash "$current_hash"
  printf '%s\n' "$build_output" >&2
  if [[ $build_status -eq 0 ]]; then
    echo "update-node-modules-hash: build unexpectedly succeeded with fake hash" >&2
  else
    echo "update-node-modules-hash: could not parse got hash from nix output" >&2
  fi
  exit 1
fi

replace_hash "$new_hash"
echo "$new_hash"
