# smolmux

**smolmux** /fʌks/ — A terminal multiplexer driven over a socket.

Start it, stop it, and attach a terminal to it from the command line.
Everything else — what runs, where it sits on screen, what has the keyboard —
is an API for programs. Each Session lives in a companion daemon, so it keeps
running when smolmux is not.

## Install

```sh
git clone https://github.com/possibilities/smolmux.git
cd smolmux
scripts/install.sh --install
```

This links `smolmux` from the checkout and builds its exact pinned Companion
source as `smolmux-zmx`. Smolmux publishes no binaries. See the
[source installation guide](docs/source-install.md) for requirements and the
tested platform boundary. `smolmux doctor` reports what an installation has.
The OpenTUI core and native packages are pinned together to the maintained
agentbrowse carry release: the renderer and its native library are one build.

## Use

```sh
smolmux start            # start the Instance without attaching; prints its API socket
smolmux                  # start it if needed, then attach this terminal
smolmux attach           # attach this terminal to a running Instance
smolmux status           # the Instance as JSON
smolmux stop             # end every Session and the Instance
smolmux api              # the API contract as JSON
smolmux doctor           # verify the Companion and its private directory
```

`--name NAME` selects an independent Instance; several run side by side and
share nothing but the config file.

`ctrl-b d` detaches this terminal, leaving every Session running. That is the
only chord smolmux claims: the prefix is a latch the attached terminal holds until
the next key proves it is not Detach, and every other key, the prefix
included, reaches the focused Session unchanged.

## Drive it

Everything past start, stop, and attach is the API: one JSON object per line
on the socket that `smolmux event-socket --name NAME` discovers without starting
anything (`default` when omitted). `start` and `status` also report it.

```
{"v":1,"type":"request","id":"1","method":"session.create","params":{"name":"reviewer","argv":["claude"],"cwd":"/Users/you/code/smolmux"}}
{"v":1,"type":"request","id":"2","method":"layout.apply","params":{"root":{"row":[{"session":"tray","size":26},{"session":"reviewer"}]},"focus":"reviewer"}}
{"v":1,"type":"request","id":"3","method":"event.subscribe"}
```

The methods are `instance.status`, `instance.stop`, `event.subscribe`, `state.get`,
`session.create`, `session.kill`, `session.list`, `session.capture`, `session.input`,
`layout.apply`, `layout.get`, and `client.copy`. The events are `session.exited`,
`session.changed`, `session.state`, `sessions.changed`, `state.invalidated`, `layout.changed`, `stage.changed`, `theme.changed`, and
`instance.stopping`. The full reference is [docs/api.md](docs/api.md), and
`smolmux api` prints the same contract as JSON Schema. The checked-in
[events.schema.json](events.schema.json) catalogs every event payload.

Subscribe with exact names, literal trailing-`*` prefixes, or `*`, then request
`state.get` and reconcile events by its sequence watermark. A new subscription
replaces the connection's filters. On disconnect invalidate observation and
resubscribe/resnapshot; transient Capture triggers and exit notifications are
independent of the snapshot watermark.

Use `session.input` for ordered keys, text, paste and mouse events. Input targets
a Session without moving human focus. `session.changed` tells you a screen
moved; `session.capture` reads it and says whether its transport is live.
Smolmux has no MCP surface or byte-level observation.

## The model

An **Instance** is one running smolmux: a Runtime, its Sessions, and one Layout.

A **Session** is a command in a Companion-held PTY, named by its caller. It
runs whether or not a Pane shows it, and it outlives the Runtime — the
Companion holds it, labelled with the Instance's id, and the next Runtime
adopts it. smolmux stores nothing of its own.

The **Layout** is a tree of rows and columns whose leaves are **Panes**, each
showing one Session or one line of text. Sizes live in the tree, so resizing
is applying a tree with a different size. Every boundary between siblings is
a divider a human can drag, and a drag moves the Layout's revision on, so a
caller writing from a stale read is refused rather than undoing the gesture.

The **Stage** is the drawn area. Several terminals can attach at once; the
**sizing owner** — whichever interacted most recently — sets the size, larger
ones have flat unused space, and smaller ones crop.

## Configure

One shared file, `~/.config/smolmux/config.toml` (or `SMOLMUX_CONFIG_PATH`), read by
every Instance. It holds the two keys smolmux claims and nothing else:

```toml
[keys]
prefix = "ctrl+b"
detach = "prefix+d"
```

`SMOLMUX_THEME` fixes the palette to `dark` or `light`; otherwise smolmux asks the
attached terminal for its background and follows it.

A Session ends only when its process does. `smolmux-zmx list`, `attach`, and
`kill` reach one by hand.

## Development

```sh
bun install --frozen-lockfile
bun link                      # ~/.bun/bin/smolmux runs this checkout
bun test && bun run typecheck
scripts/install-companion.sh  # the pinned companion, into ~/.local/bin
scripts/local-gate.sh         # the only merge gate: this Mac architecture
```

`AGENTS.md` is the working contract, `CONTEXT.md` the glossary, and
`docs/adr/` the decisions behind them.

## Design

Built the way Derek Sivers is [building his house](https://sive.rs/fit):
defer the decision, add only what proves necessary, pave where the grass
is worn.
