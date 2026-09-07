#!/usr/bin/env bash

set -euo pipefail

# Canonical source installation for smolmux and its native PTY owners.
# Consumers and fleet automation use this same entrypoint.

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="${1:-}"
local_only="${2:-}"
[[ -z "$local_only" || "$local_only" == --local-only ]] || { printf 'unknown installation option\n' >&2; exit 2; }

fail() {
  printf 'smolmux source install: %s\n' "$*" >&2
  exit 1
}

case "$mode" in
  --install|--check) ;;
  -h|--help)
    printf 'usage: %s --install|--check [--local-only]\n' "$0"
    exit 0
    ;;
  *) fail 'expected --install or --check' ;;
esac

install_dir="${SMOLMUX_INSTALL_BIN_DIR:-$HOME/.local/bin}"
companion_installed="$install_dir/smolmux-zmx"

printf '%s\n' \
  "smolmux source install:" \
  "  bun install --frozen-lockfile and link smolmux in $root_dir" \
  "  build the pinned Companion as $companion_installed" \
  "  verify the complete installation with smolmux doctor"

if [[ "$mode" == --check ]]; then
  if [[ "$local_only" != --local-only ]]; then
    SMOLMUX_COMPANION_INSTALL_DIR="$install_dir" "$root_dir/scripts/install-companion.sh" --check
  fi
  command -v "${SMOLMUX_LOCAL_CC:-cc}" >/dev/null || fail "C compiler required for local PTYs"
  exit 0
fi

commands=(bun "${SMOLMUX_LOCAL_CC:-cc}")
if [[ "$local_only" != --local-only ]]; then commands+=(git zig); fi
for command in "${commands[@]}"; do
  command -v "$command" >/dev/null 2>&1 || fail "required command not found: $command"
done

bun install --cwd "$root_dir" --frozen-lockfile \
  || fail 'frozen dependency installation failed'
(cd "$root_dir" && bun link) || fail 'bun link failed'
bun_bin="${BUN_INSTALL:-$HOME/.bun}/bin"
[[ -x "$bun_bin/smolmux" ]] || fail "bun link did not install an executable $bun_bin/smolmux"

mkdir -p "$install_dir"

"$root_dir/scripts/build-local.sh" "$install_dir/smolmux-local-pty"
if [[ "$local_only" != --local-only ]]; then
  SMOLMUX_COMPANION_INSTALL_DIR="$install_dir" "$root_dir/scripts/install-companion.sh"
fi
doctor_flags=(doctor)
if [[ "$local_only" == --local-only ]]; then doctor_flags+=(--local-only); fi

PATH="$install_dir:${PATH:-}" \
SMOLMUX_ZMX_PATH="$companion_installed" \
SMOLMUX_LOCAL_PTY_PATH="$install_dir/smolmux-local-pty" \
bun "$root_dir/src/index.ts" "${doctor_flags[@]}" \
  || fail 'smolmux doctor rejected the source installation'

if [[ "$local_only" == --local-only ]]; then
  printf 'smolmux source install: linked smolmux and built the local PTY helper\n'
else
  printf 'smolmux source install: linked smolmux and built the local PTY helper and pinned Companion\n'
fi
