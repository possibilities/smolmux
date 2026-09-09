# 0028: Source-only installation

Status review 2026-09-08: partially superseded.
Source-only distribution remains accepted. [ADR 0016](0016-sessions-are-arbitrary-commands.md) removes the pinned Fx build named below; the current source installer builds the pinned Companion and runs doctor.

Identifier corrected 2026-09-08: formerly `0002-source-only-installation.md`. The old number
was shared by another decision; this record retains its original rationale.
See the [identifier history](README.md#identifier-history).

Status: accepted; supersedes [ADR 0001](0001-native-release-distribution.md).

Smolmux no longer publishes native archives, an installer payload, checksums,
release tags, or a latest-version pointer. Consumers clone the repository and
run `scripts/install.sh`, the same entrypoint used by fleet automation. That
script builds the exact pinned Fx and Companion sources and verifies the
result with `smolmux doctor`.

Only `scripts/local-gate.sh` on the maintainer's current Mac architecture is a
merge gate. Full CI still gives a binary pass/fail verdict on macOS and Linux,
each on arm64 and x86_64, but it runs after pushes to `main` and is
nonblocking observability.

This removes release infrastructure from a project with no binary consumers,
while retaining exact inputs, reproducible commands, and explicit tested and
unsupported platform boundaries.
