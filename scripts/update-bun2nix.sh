#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
VERIFY_DESKTOP=0

usage() {
  cat <<'EOF'
Usage: update-bun2nix.sh [--verify]

Updates nix/bun.nix with the fixed-output hash for the nodeModules package.

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
original_bun_nix="$(mktemp)"
cp "${BUN_NIX}" "${original_bun_nix}"
restore_original_bun_nix=1

cleanup() {
  if [[ "${restore_original_bun_nix}" -eq 1 ]]; then
    cp "${original_bun_nix}" "${BUN_NIX}"
  fi
  rm -f "${original_bun_nix}"
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

write_bun_nix "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

output_file="$(mktemp)"
if nix build .#nodeModules --no-link >"${output_file}" 2>&1; then
  rm -f "${output_file}"
  if [[ "${VERIFY_DESKTOP}" -eq 1 ]]; then
    nix build .#desktop --no-link
  fi
  exit 0
fi

actual_hash="$(sed -n 's/.*got:[[:space:]]*//p' "${output_file}" | tail -n 1)"
rm -f "${output_file}"

if [[ -z "${actual_hash}" ]]; then
  echo "Could not determine node_modules hash from nix build output." >&2
  exit 1
fi

write_bun_nix "${actual_hash}"
restore_original_bun_nix=0
nix build .#nodeModules --no-link

if [[ "${VERIFY_DESKTOP}" -eq 1 ]]; then
  nix build .#desktop --no-link
fi
