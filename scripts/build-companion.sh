#!/usr/bin/env bash

set -euo pipefail

# Build the Companion this smolmux is pinned to. The pin (companion.json) names
# the fork commit and the build string a Companion built from it reports;
# this script builds exactly that commit and proves the binary reports it.
#
#   scripts/build-companion.sh --output PATH [--target TRIPLE]
#
# The source is the pinned commit itself, never a checkout's working tree:
# from SMOLMUX_COMPANION_CHECKOUT (default ~/source/neurosnap--zmx when it exists) through a
# detached worktree when that repository has the commit, else a shallow fetch
# of the commit from the pin's repository into a temporary directory. Zig of
# the fork's minimum series and git are required.

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  printf 'smolmux companion build: %s\n' "$*" >&2
  exit 1
}

output=""
target=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      [[ $# -ge 2 ]] || fail "--output needs a path"
      output="$2"
      shift 2
      ;;
    --target)
      [[ $# -ge 2 ]] || fail "--target needs a zig target triple"
      target="$2"
      shift 2
      ;;
    -h|--help)
      printf 'usage: %s --output PATH [--target TRIPLE]\n' "$0"
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done
[[ -n "$output" ]] || fail "--output is required"

for command in git zig; do
  command -v "$command" >/dev/null 2>&1 || fail "required command not found: $command"
done

pin_value() {
  sed -n 's/^[[:space:]]*"'"$1"'":[[:space:]]*"\([^"]*\)".*/\1/p' "$root_dir/companion.json" | head -n 1
}
repository="$(pin_value repository)"
commit="$(pin_value commit)"
build="$(pin_value build)"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "companion.json commit is not a full sha: $commit"
build_metadata="${build#*+}"
[[ "$build_metadata" =~ ^[A-Za-z0-9-]+\.[0-9a-f]{12}$ && "$build_metadata" == *".${commit:0:12}" ]] \
  || fail "companion.json build $build must name its fork and commit ${commit:0:12}"
[[ -n "$repository" ]] || fail "companion.json has no repository"

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/smolmux-companion.XXXXXX")"
source_repo=""
source_worktree=""
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$source_worktree" && -d "$source_worktree" ]]; then
    git -C "$source_repo" worktree remove --force "$source_worktree" >/dev/null 2>&1 || true
  fi
  rm -rf "$work_dir"
  exit "$status"
}
trap cleanup EXIT

# The source: the pinned commit, from wherever it already is.
checkout="${SMOLMUX_COMPANION_CHECKOUT:-}"
if [[ -z "$checkout" && -d "$HOME/source/neurosnap--zmx/.git" ]]; then
  checkout="$HOME/source/neurosnap--zmx"
fi
companion_source="$work_dir/source"
if [[ -n "$checkout" ]] && git -C "$checkout" cat-file -e "$commit^{commit}" 2>/dev/null; then
  source_repo="$checkout"
  source_worktree="$companion_source"
  git -C "$source_repo" worktree add --quiet --detach "$source_worktree" "$commit" \
    || fail "could not check out $commit from $checkout"
  printf 'smolmux companion build: building %s from %s\n' "${commit:0:12}" "$checkout"
else
  mkdir -p "$companion_source"
  git -C "$companion_source" init -q
  git -C "$companion_source" fetch -q --depth 1 "$repository" "$commit" \
    || fail "could not fetch $commit from $repository"
  git -C "$companion_source" checkout -q --detach FETCH_HEAD
  printf 'smolmux companion build: building %s fetched from %s\n' "${commit:0:12}" "$repository"
fi
[[ "$(git -C "$companion_source" rev-parse HEAD)" == "$commit" ]] || fail "the source is not at the pinned commit"

# The build string is the fork's own version plus metadata naming the commit;
# the fork's version comes from its build.zig.zon, so the two are checked
# against each other rather than trusted.
zon="$companion_source/build.zig.zon"
companion_version="$( (grep -m 1 -E '^[[:space:]]*\.version = "' "$zon" || true) | sed 's/^[[:space:]]*\.version = "\([^"]*\)",.*/\1/')"
[[ -n "$companion_version" ]] || fail "no .version in $zon"
[[ "$build" == "$companion_version+$build_metadata" ]] \
  || fail "companion.json build $build is not $companion_version+$build_metadata (the fork at the pin is version $companion_version)"
minimum_zig="$( (grep -m 1 -E '^[[:space:]]*\.minimum_zig_version = "' "$zon" || true) | sed 's/^[[:space:]]*\.minimum_zig_version = "\([^"]*\)",.*/\1/')"
[[ -n "$minimum_zig" ]] || fail "no .minimum_zig_version in $zon"
zig_series="${minimum_zig%.*}"
[[ "$(zig version)" == "$zig_series".* ]] || fail "the Companion builds with zig $zig_series.x (found $(zig version))"

prefix="$work_dir/out"
# The fork owns its metadata namespace. Smolmux checks its exact pinned version
# and commit, and always selects the isolated Companion directory policy.
build_args=(-Dcompanion -Doptimize=ReleaseFast "-Dversion=$build")
[[ -n "$target" ]] && build_args+=("-Dtarget=$target")
(cd "$companion_source" && zig build "${build_args[@]}" --prefix "$prefix") \
  || fail "zig build failed at $commit"

reported="$(ZMX_DIR="$work_dir/zmx-dir" "$prefix/bin/zmx" version 2>&1 | awk 'NR == 1 && $1 == "zmx" { print $2 }' || true)"
[[ "$reported" == "$build" ]] || fail "the built Companion reports '$reported', not $build"

mkdir -p "$(dirname "$output")"
cp "$prefix/bin/zmx" "$output"
chmod 0755 "$output"
printf 'smolmux companion build: %s -> %s\n' "$build" "$output"
