#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
VERSION="$(
  python - <<'PY' "${REPO_ROOT}/apps/server/package.json"
import json, sys
from pathlib import Path
print(json.loads(Path(sys.argv[1]).read_text())["version"])
PY
)"

cd "${REPO_ROOT}"

write_bun_nix() {
  local hash="$1"
  cat > "${REPO_ROOT}/nix/bun.nix" <<EOF
{
  version = "${VERSION}";
  hash = "${hash}";
}
EOF
}

write_bun_nix "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

output_file="$(mktemp)"
if nix build .#desktop --no-link >"${output_file}" 2>&1; then
  rm -f "${output_file}"
  exit 0
fi

actual_hash="$(sed -n 's/.*got:[[:space:]]*//p' "${output_file}" | tail -n 1)"
rm -f "${output_file}"

if [[ -z "${actual_hash}" ]]; then
  echo "Could not determine node_modules hash from nix build output." >&2
  exit 1
fi

write_bun_nix "${actual_hash}"
nix build .#desktop --no-link
