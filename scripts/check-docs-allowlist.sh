#!/usr/bin/env bash
# Fail if docs/ contains paths outside docs/contributing/ and docs/electron-desktop/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCS="$ROOT/docs"

if [[ ! -d "$DOCS" ]]; then
  echo "docs/ missing — nothing to check"
  exit 0
fi

violations=()
while IFS= read -r -d '' file; do
  rel="${file#"$DOCS"/}"
  case "$rel" in
    contributing/*|electron-desktop/*) ;;
    *) violations+=("$rel") ;;
  esac
done < <(find "$DOCS" -type f -print0)

if ((${#violations[@]} > 0)); then
  echo "docs/ allowlist violation — only docs/contributing/ and docs/electron-desktop/ are permitted:"
  printf '  %s\n' "${violations[@]}"
  exit 1
fi

echo "docs/ allowlist OK"
