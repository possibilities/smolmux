#!/usr/bin/env bash

set -euo pipefail

# Install the Companion an editable smolmux needs. A checkout run through `bun
# link` finds smolmux-zmx on PATH, so this builds the pinned one and places it
# there. Rerun after the pin
# moves; a Companion already reporting the pinned build is left alone.
#
#   scripts/install-companion.sh [--check] [--rebuild]
#
# SMOLMUX_COMPANION_INSTALL_DIR (default ~/.local/bin) is where it goes;
# SMOLMUX_COMPANION_CHECKOUT (default ~/workshops/zmax/fork) is where the pinned commit is
# built from, see scripts/build-companion.sh.

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  printf 'smolmux companion install: %s\n' "$*" >&2
  exit 1
}

check_only=0
rebuild=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) check_only=1 ;;
    --rebuild) rebuild=1 ;;
    -h|--help)
      printf 'usage: %s [--check] [--rebuild]\n' "$0"
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
  shift
done

install_dir="${SMOLMUX_COMPANION_INSTALL_DIR:-$HOME/.local/bin}"
installed="$install_dir/smolmux-zmx"
build="$(sed -n 's/^[[:space:]]*"build":[[:space:]]*"\([^"]*\)".*/\1/p' "$root_dir/companion.json" | head -n 1)"
[[ -n "$build" ]] || fail "companion.json has no build"

reported_build() {
  local scratch
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/smolmux-companion-check.XXXXXX")"
  ZMX_DIR="$scratch/zmx" "$1" version 2>/dev/null | awk 'NR == 1 && $1 == "zmx" { print $2 }' || true
  rm -rf "$scratch"
}

current=""
if [[ -x "$installed" && -f "$installed" ]]; then
  current="$(reported_build "$installed")"
fi
if [[ "$current" == "$build" && "$rebuild" -eq 0 ]]; then
  printf 'smolmux companion install: %s already reports %s\n' "$installed" "$build"
  exit 0
fi
if [[ "$check_only" -eq 1 ]]; then
  printf 'smolmux companion install: would build %s and place it at %s (currently %s)\n' \
    "$build" "$installed" "${current:-absent}"
  exit 0
fi

if [[ -e "$installed" && ! -f "$installed" ]]; then
  fail "$installed exists and is not a regular file"
fi
mkdir -p "$install_dir"
staged="$(mktemp "$install_dir/.smolmux-zmx.XXXXXX")"
cleanup() {
  rm -f "$staged"
}
trap cleanup EXIT

"$root_dir/scripts/build-companion.sh" --output "$staged"
chmod 0755 "$staged"
mv -f "$staged" "$installed"
trap - EXIT

[[ "$(reported_build "$installed")" == "$build" ]] || fail "$installed does not report $build after install"
printf 'smolmux companion install: %s is %s\n' "$installed" "$build"
case ":${PATH:-}:" in
  *":$install_dir:"*) ;;
  *) printf 'smolmux companion install: %s is not on PATH; smolmux finds smolmux-zmx there only when it is\n' "$install_dir" ;;
esac
