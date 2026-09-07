# Source installation

Smolmux publishes no binaries and has no release channel. A consumer installs a
checkout with the same repository-owned script used by its maintainers:

```sh
git clone https://github.com/possibilities/smolmux.git
cd smolmux
scripts/install.sh --check
scripts/install.sh --install
```

The installer runs a frozen Bun dependency install, links `smolmux` from the
checkout, builds the exact Companion commit in `companion.json` as `smolmux-zmx`,
builds `native/local-pty.c` as `smolmux-local-pty`, and runs `smolmux doctor`.
By default both native commands go to `~/.local/bin`
and Bun's editable link goes to `${BUN_INSTALL:-$HOME/.bun}/bin`.

The tested systems are macOS and Linux on arm64 and x86_64. Other operating
systems and architectures are unsupported. CI records a binary pass/fail
result for all four tested systems after every push to `main`; those hosted
results do not gate merging. Before merging, maintainers run
`scripts/local-gate.sh`, and only the result for the architecture of that Mac
is blocking.

Set `SMOLMUX_COMPANION_CHECKOUT` to reuse a local clone that contains the pinned
commit. Otherwise the installer fetches that exact commit.

smolmux installs no program to run inside a Session. What a Session runs is the
caller's, named by its `argv` and found on the environment's own `PATH`.


## Local-only and embedding

`./scripts/install.sh --install --local-only` skips Companion entirely. It needs
Bun 1.4+ and a C11 compiler (`cc`, or `SMOLMUX_LOCAL_CC`). Linux also needs PTY
headers/libutil; macOS uses the SDK's libutil and libproc. The full installation
additionally needs git and Zig for the pinned Companion. Use
`smolmux doctor --local-only` to check a foreground-only installation.

`SMOLMUX_INSTALL_BIN_DIR` selects the native binary directory. The local helper
is resolved from `SMOLMUX_LOCAL_PTY_PATH`, beside smolmux, or PATH, in that order.
Build just the helper with `scripts/build-local.sh /absolute/output/path`.

Bun consumers use the source exports `smolmux/client`, `smolmux/protocol`, and
`smolmux/foreground`. With sibling repositories, declare `"smolmux":
"file:../smolmux"`, then run `bun install`. Keep the checkout and dependencies
available. The foreground export requires a physical TTY and exclusive renderer
ownership; the client/protocol exports do not require a terminal or Companion.
See [USAGE.md](../USAGE.md) for complete examples.

API 2 is a coordinated breaking change. Stop old Instances with the old binary
before upgrading the consumer and smolmux together. There are no v1 method
aliases or migration of old Session identity labels. The Companion wire protocol
and pinned build are unchanged.
