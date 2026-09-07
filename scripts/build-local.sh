#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="${1:?usage: scripts/build-local.sh OUTPUT}"
mkdir -p "$(dirname "$output")"
compiler="${SMOLMUX_LOCAL_CC:-cc}"
flags=(-std=c11 -O2 -Wall -Wextra -Werror "$root_dir/native/local-pty.c" -o "$output")
if [[ "$(uname -s)" == Linux ]]; then flags+=(-lutil); fi
"$compiler" "${flags[@]}"
