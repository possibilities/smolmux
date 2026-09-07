# smolmux

A terminal multiplexer driven over a socket. Declare Apps, arrange their
Sessions in Layout Panes, control Focus, send semantic input, and read screens
through one API.

Choose Companion-held PTYs that survive the Runtime, or local PTYs that end
with it. Local Apps can keep running, stop, or pause when hidden. Run a shared
headless Instance or embed smolmux directly in a foreground terminal.

```sh
git clone https://github.com/possibilities/smolmux.git
cd smolmux
scripts/install.sh --install
smolmux start                    # headless; prints its API socket
smolmux attach                   # ctrl-b d detaches this Client
# Or: smolmux start --foreground # direct terminal; no Companion needed for local Apps
```

**Start with [USAGE.md](USAGE.md)** for building applications and driving every
workflow through the API. The [API reference](docs/api.md), `smolmux api`, and
[JSON Schema](events.schema.json) describe the exact protocol.

[Source installation](docs/source-install.md) covers local-only installs and
platform requirements. Development uses `bun run typecheck`, `bun test`, and
`scripts/local-gate.sh`. [CONTEXT.md](CONTEXT.md) defines the vocabulary;
[ADRs](docs/adr/) record the decisions.
