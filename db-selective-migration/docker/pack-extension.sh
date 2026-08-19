#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Create a deployable zip artifact for one Directus extension.

Usage:
  pack-extension.sh <extension-directory> [output.zip]

Example:
  pack-extension.sh ../directus-extensions-bb-dev/bis-test-file /tmp/bis-test-file.zip
EOF
}

die() {
  printf '[pack-extension] ERROR: %s\n' "$*" >&2
  exit 1
}

main() {
  local src="${1:-}"
  local out="${2:-}"

  [[ -n "$src" ]] || { usage; exit 1; }
  [[ -d "$src" ]] || die "directory not found: $src"

  local src_abs name
  src_abs="$(cd "$src" && pwd)"
  name="$(basename "$src_abs")"
  [[ -f "$src_abs/package.json" ]] || die "missing package.json in $src_abs"

  if [[ -z "$out" ]]; then
    out="${name}.zip"
  fi

  local out_abs
  if [[ "$out" = /* ]]; then
    out_abs="$out"
  else
    out_abs="$(pwd)/$out"
  fi

  local workdir
  workdir="$(mktemp -d)"
  trap 'rm -rf "$workdir"' RETURN

  mkdir -p "$workdir/$name"
  cp -a "$src_abs/." "$workdir/$name/"

  (
    cd "$workdir"
    zip -qr "$(basename "$out_abs")" "$name"
  )

  mkdir -p "$(dirname "$out_abs")"
  mv "$workdir/$(basename "$out_abs")" "$out_abs"
  printf '[pack-extension] created %s\n' "$out_abs"
}

main "$@"
