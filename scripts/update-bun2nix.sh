#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
VERIFY_DESKTOP=0

usage() {
  cat <<'EOF'
Usage: update-bun2nix.sh [--verify]

Updates nix/bun.nix with the fixed-output hash for the nodeModules package.
Computes the hash locally first so Nix only needs to build nodeModules once.

Options:
  --verify  Build .#desktop after updating the nodeModules hash.
  -h, --help
            Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify)
      VERIFY_DESKTOP=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

VERSION="$(
  python - <<'PY' "${REPO_ROOT}/apps/server/package.json"
import json, sys
from pathlib import Path
print(json.loads(Path(sys.argv[1]).read_text())["version"])
PY
)"

cd "${REPO_ROOT}"

BUN_NIX="${REPO_ROOT}/nix/bun.nix"
workspace_dirs=(
  "apps/server"
  "packages/shared"
  "scripts"
)

scratch_root="$(mktemp -d)"
source_root="${scratch_root}/source"
hash_root="${scratch_root}/hash-root"
cache_root="${XDG_CACHE_HOME:-${HOME}/.cache}/t3code/update-bun2nix"
bun_home="${cache_root}/home"
bun_cache_dir="${cache_root}/bun-install-cache"

cleanup() {
  rm -rf "${scratch_root}"
}

trap cleanup EXIT

write_bun_nix() {
  local hash="$1"
  cat > "${BUN_NIX}" <<EOF
{
  version = "${VERSION}";
  hash = "${hash}";
}
EOF
}

mkdir -p "${source_root}"
mkdir -p "${bun_home}" "${bun_cache_dir}"

rsync -a \
  --exclude '.git/' \
  --exclude '.direnv/' \
  --exclude '.turbo/' \
  --exclude 'node_modules/' \
  --exclude 'apps/*/node_modules/' \
  --exclude 'packages/*/node_modules/' \
  --exclude 'dist/' \
  --exclude 'dist-electron/' \
  --exclude 'result' \
  --exclude 'flake.lock' \
  --exclude '*.tsbuildinfo' \
  --exclude '*.log' \
  "${REPO_ROOT}/" "${source_root}/"

(
  cd "${source_root}"
  export HOME="${bun_home}"
  export BUN_INSTALL_CACHE_DIR="${bun_cache_dir}"

  bun install --frozen-lockfile --linker=hoisted --ignore-scripts

  top_level_effect="node_modules/effect"
  if [[ -d "${top_level_effect}" ]]; then
    while IFS= read -r nested_effect; do
      [[ "${nested_effect}" == "${top_level_effect}" ]] && continue
      rm -rf "${nested_effect}"
      ln -s "$(realpath --relative-to="$(dirname "${nested_effect}")" "${top_level_effect}")" "${nested_effect}"
    done < <(find node_modules -path '*/node_modules/effect' -type d | sort)

    for workspace_dir in "${workspace_dirs[@]}"; do
      mkdir -p "${workspace_dir}/node_modules"
      ln -sfn \
        "$(realpath --relative-to="${workspace_dir}/node_modules" "${top_level_effect}")" \
        "${workspace_dir}/node_modules/effect"
    done
  fi

  mkdir -p "${hash_root}"
  cp -a node_modules "${hash_root}/node_modules"

  for workspace_dir in "${workspace_dirs[@]}"; do
    if [[ -d "${workspace_dir}/node_modules" ]]; then
      mkdir -p "${hash_root}/${workspace_dir}"
      cp -a "${workspace_dir}/node_modules" "${hash_root}/${workspace_dir}/node_modules"
    fi
  done
)

actual_hash="$(nix hash path --type sha256 --sri "${hash_root}")"
write_bun_nix "${actual_hash}"

nix build .#nodeModules --no-link

if [[ "${VERIFY_DESKTOP}" -eq 1 ]]; then
  nix build .#desktop --no-link
fi
