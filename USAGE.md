# Using smolmux from an agent or application

Verified against smolmux **0.9.0**, API **2**.

smolmux is a terminal surface you program. You declare arbitrary commands,
choose who owns their PTYs, arrange their terminals in a Layout, and drive them
through input and screen capture. Your application owns its own meaning:
which command is a debugger, which tab is selected, what a completed task means,
and whether to restart a command that exits. smolmux supplies process ownership,
terminal emulation, geometry, Focus, and observable state.

Read this guide for workflows and decisions. Use [docs/api.md](docs/api.md) for
all methods, fields, events, errors and limits. `smolmux api` prints the live
contract as JSON Schema; [events.schema.json](events.schema.json) is the checked-in
request, response and event catalog. There is no smolmux MCP server: an
application can expose the socket API through its own MCP tools.

## Choose the lifetime first

An **App** is a stable, named command declaration. Its **Session** is one
execution, identified by a UUID, with one process, PTY and terminal emulator.
An App has at most one Session. A **Pane** is a geometric leaf showing that
App's current terminal, or a line of text. Removing a Pane from the Layout does
not remove the App declaration.

| Declaration | Hidden behavior | Reveal | Runtime ends |
| --- | --- | --- | --- |
| `pty: "companion", whenHidden: "keep"` | Runs normally | Same Session | Session survives and can be adopted |
| `pty: "local", whenHidden: "keep"` | Runs normally | Same Session | Process ends |
| `pty: "local", whenHidden: "stop"` | Process ends; emulator and history are freed | New Session and UUID | Process ends |
| `pty: "local", whenHidden: "pause"` | Process execution is suspended; memory, terminal and history remain | Same Session resumes | Process ends, even if paused |

`pty` is required; `whenHidden` defaults to `keep`. Companion Apps reject
`stop` and `pause`. Ownership is a declaration decision; to change it, remove
and recreate the App. `app.restart` can replace the command while retaining
ownership and hidden policy.

Use Companion ownership for work that must survive a renderer crash or a
foreground host closing. Use local/keep for tools whose background work matters
only during this Instance. Use local/stop for a stateless, expensive viewer
that reconstructs itself when opened. Use local/pause when startup is expensive
or interactive state matters and the application tolerates suspension.

Pause saves CPU execution, not memory. Files, locks, sockets and allocations
remain held; remote peers and external services continue running, and network
timeouts can expire. Already submitted kernel I/O can finish. It is unsuitable
for a tool that must answer heartbeats or release a shared lock while hidden.
A stopped process releases those resources but loses unsaved in-memory state.

The local owner controls the command's POSIX session, including ordinary shell
job-control groups. Jobs already stopped by their own job control remain stopped
on resume. Resume acknowledges continuation of processes smolmux stopped; a
program can later stop itself through its own job control. Commands that
daemonize with `setsid`, change privilege so they cannot be signalled, or deliberately escape observation are outside this ownership
guarantee. Run foreground commands that keep their descendants in the managed
session. This is process management, not a sandbox or containment boundary.
The helper reports failures rather than asserting that an unconfirmed pause or
termination succeeded.

## Choose the host

**Headless:** `smolmux start --name work` starts a Runtime in a Companion PTY and
prints the API socket. It needs the pinned Companion. `smolmux attach --name work`
connects a human terminal; several Clients can observe the same Stage. The
most recently interacting Client controls its size. Leaving the last Client
does not end the Runtime or its local Apps.

**Foreground:** `smolmux start --foreground --name dashboard` draws directly in
this terminal and exposes the same socket API. It can run entirely without
Companion when all Apps are local. It has one physical terminal, so another
Client cannot attach. Closing the terminal, signalling the Runtime, or ending
the embedding host ends local Sessions and releases Companion Sessions.

**Embedded:** a Bun application can call `startForeground` and use the returned
client. It needs a TTY and owns its terminal until the host closes. Treat it as
the terminal root of your application, not as a component inside a second
renderer. Errors in the controller should be handled with `finally` cleanup.

`instance.stop` (and CLI `smolmux stop`) has stronger semantics in both modes:
it ends **all** local and Companion Sessions before replying and shutting down.
If termination cannot be confirmed, the API fails and leaves the Instance
available for inspection and retry.

For a Client on a headless Instance, `ctrl-b d` detaches only that Client. Every
other key, including a prefix followed by a different key, reaches the focused
App. Foreground mode has no Detach connection; stop it through the API or its
own controlling application. smolmux does not claim tab switching or help keys.

## Install and discover

Requires Bun 1.4+, a C compiler for the local helper, and a supported macOS or
Linux system. Full installation also requires the Companion build prerequisites
listed in [source installation](docs/source-install.md).

```sh
scripts/install.sh --install                  # smolmux + both PTY owners
scripts/install.sh --install --local-only     # foreground local applications
smolmux doctor                               # full installation
smolmux doctor --local-only                   # local helper without Companion
smolmux --version
smolmux api
```

Keep this source checkout for the editable Bun link. Installed helper resolution
is `SMOLMUX_LOCAL_PTY_PATH`, then beside the installed smolmux binary, then
`smolmux-local-pty` on PATH. `SMOLMUX_LOCAL_CC` selects the build compiler.
Companion resolution and pinning are described in the installation guide.

After a Runtime starts, discover its socket with:

```sh
smolmux event-socket --name work
smolmux status --name work
```

Discovery never starts anything. An Instance's stable ID derives from the
configuration directory and its name. Its API socket is
`/tmp/smolmux-<uid>/<instance id>.api`; the directory is private (0700), the
socket is 0600, and an active API socket is the singleton authority. Use a
unique name and separate configuration directory for automated tests.

The configuration file contains only keys:

```toml
[keys]
prefix = "ctrl+b"
detach = "prefix+d"
```

It defaults to `~/.config/smolmux/config.toml`; `SMOLMUX_CONFIG_PATH` selects
another file and `XDG_CONFIG_HOME` selects another default directory.
`SMOLMUX_THEME=dark` or `light` fixes the palette. Otherwise the foreground
terminal or first attached Client supplies the terminal background, and live
terminal theme notifications update the complete palette.

## A first API workflow

Use the Bun client exports from a source dependency (for sibling checkouts,
`"smolmux": "file:../smolmux"` in package.json). `smolmux/client` exports
`ApiClient`; `smolmux/protocol` exports method types and schemas. Importing the
client does not start a renderer or require Companion. Connect once and keep
the socket open for the workflow.

Save this as `control.ts`, start a named headless Instance, and pass its socket:

```ts
import { ApiClient } from "smolmux/client"

const client = await ApiClient.connect(Bun.argv[2]!)
try {
  // Claim the Layout before declaring hidden stop/pause Apps. Otherwise the
  // Runtime's Default Layout intentionally selects the first declared App.
  await client.request("layout.apply", { root: null, visible: [], focus: null })
  const shell = await client.request("app.create", {
    name: "shell", pty: "local", whenHidden: "keep",
    argv: ["/bin/sh"], cwd: process.cwd(),
  })
  if (shell.state !== "running") throw new Error(shell.error ?? shell.state)
  await client.request("layout.apply", {
    root: { row: [{ text: "API controlled", size: 20 }, { app: "shell" }] },
    visible: ["shell"], focus: "shell",
  })
  await client.request("app.input", {
    name: "shell", sessionId: shell.session!.id,
    events: [{ text: "printf 'hello from the API\\n'" }, { key: "enter" }],
  })
  // Input acceptance means queued, not that the command has finished.
  // Capture now gives the bytes received so far; observe changes for completion.
  console.log(await client.request("app.capture", { name: "shell" }))
} finally {
  client.close() // disconnects control; it does not stop the Instance
}
```

```sh
smolmux start --name work
bun control.ts "$(smolmux event-socket --name work)"
smolmux attach --name work
```

The equivalent raw wire request is one complete UTF-8 JSON line:

```json
{"v":2,"type":"request","id":"declare-1","method":"app.create","params":{"name":"shell","pty":"local","argv":["/bin/sh"],"cwd":"/tmp"}}
```

Use a unique request ID and correlate each response. Establish the reader before
sending requests. Requests can complete out of order: await dependent actions.
The client handles partial socket writes, response validation, bounded queues,
and deadlines. A shell writing isolated JSON lines is useful for diagnosis;
a persistent client is the practical application interface.

## Build a foreground application

This complete controller uses only local PTYs. It shows a shell and an expensive
viewer, hides the viewer after a short demonstration interval, and stops the
Instance when the shell exits. The interval is demonstration behavior; a real
application would call the same Layout operation from its own API or selection
state.

```ts
import { startForeground } from "smolmux/foreground"

const host = await startForeground({ name: "example" })
let hideTimer: ReturnType<typeof setTimeout> | undefined
try {
  const c = host.client
  await c.request("layout.apply", { root: null, visible: [], focus: null })
  await c.request("app.create", {
    name: "shell", pty: "local", argv: ["/bin/sh"], cwd: process.cwd(),
  })
  await c.request("app.create", {
    name: "viewer", pty: "local", whenHidden: "pause",
    argv: ["top"], cwd: process.cwd(),
  })
  await c.request("layout.apply", {
    root: { row: [{ app: "shell" }, { app: "viewer", size: 50 }] },
    visible: ["shell", "viewer"], focus: "shell",
  })
  // Application failures need their own diagnostic sink, not terminal stderr.
  const report = (error: unknown) => {
    void Bun.write("/tmp/example-controller.log", String(error)).catch(() => {})
  }
  hideTimer = setTimeout(() => {
    void c.request("layout.apply", {
      root: { app: "shell" }, visible: ["shell"], focus: "shell",
    }).catch(report)
  }, 5000)
  await c.observe(snapshot => {
    if (snapshot?.state?.apps.some(app => app.name === "shell" && app.state === "exited")) {
      void host.stop().catch(report)
    }
  })
  await host.closed
} finally {
  clearTimeout(hideTimer)
  // stop() is for ending the complete Instance, including Companion Apps.
  await host.stop().catch(() => {})
}
```

The returned object has `client`, `socketPath`, `closed`, and `stop()`.
`environment` and `localHelper` options support controlled embedding and tests.
It uses the same contract validation and socket as an external controller.
Do not print progress or diagnostics on the terminal while its renderer owns it.
Runtime diagnostics go to the Instance log described below.

## Visibility, fitting, Focus and tabs

`layout.apply` commits three intentions: `root`, the complete logical `visible`
set, and optional `focus`. Every App leaf in the tree must appear in `visible`.
Additional visible Apps may be omitted from your fitted tree. Neither duplicates
in `visible` nor duplicate App leaves are allowed. Text Panes need no App.

**Hidden** means absent from `visible`. **Shown** means its fitted Pane has cells
and a current terminal. A terminal can be visible but not shown when the Stage
is narrow, or while its Session starts. Hiding follows logical application
behavior: switching a tab, collapsing a tool, or replacing a region with a
modal. Terminal resizing alone must not change your logical visibility set.

For tabs, keep all declarations and show the selected App:

```ts
await client.request("layout.apply", {
  root: { app: "tab-two" }, visible: ["tab-two"], focus: "tab-two",
})
```

A hidden Companion or local/keep tab keeps working. A local/stop tab starts
fresh when selected. A local/pause tab resumes its existing execution. You can
mix policies among tabs, side panes, and stacked tools in one Instance.

Rows place children horizontally; columns place them vertically. `size` is cells
along the parent's axis, `min` is the floor, and omitted size shares the remaining
space. Dividers cost one cell. Squeezed-out Panes stay in `layout.get().panes`
in tree order with zero width or height. Use geometry, never array presence,
to decide whether mouse input is possible. Unchanged rectangles are not resized.

```ts
await client.request("layout.apply", {
  root: { row: [
    { column: [{ text: "Tools", size: 2 }, { app: "files" }], size: 26, min: 20 },
    { app: "shell", min: 30 },
    { app: "metrics", size: 40, min: 20 },
  ] },
  visible: ["files", "shell", "metrics"], focus: "shell",
})
```

Only the API moves Focus. Human clicks and API mouse input forward reports
without moving the keyboard. Explicit input names its own target and does not
require Focus. A requested Focus remains associated with a leaf while it awaits
startup or is squeezed out; keyboard delivery resumes when it is shown. Leaving
the tree clears Focus. `focus: null` clears it explicitly.

A Layout can name an App before it is declared: its Pane stays empty and fills
when the declaration starts. The first `layout.apply` takes Layout ownership
permanently for that Runtime. Before it, the Default Layout follows the first
App, including an App retained after exit; it says `no apps` only when no
Apps are declared.

## Preserve human divider changes

Every apply and divider drag advances the Layout Revision. Resize refits
geometry without replacing the tree. Use the revision from the tree you read:

```ts
const before = await client.request("layout.get")
const updated = structuredClone(before.root)
// Change the relevant size in updated, preserving other returned size wishes.
await client.request("layout.apply", {
  root: updated, visible: before.visible, focus: before.focus,
  revision: before.revision,
})
```

A `conflict` means something changed after your read. Read again and recompute;
repeating the old tree with a new revision would overwrite the human's intent.
Listen for `layout.changed` with `cause: "drag"` to incorporate new size wishes
into your application's state. Omit revision only when intentionally replacing
the whole Layout unconditionally. A rejected or undrawable Layout changes no
hidden policies. Successful application schedules process changes; it does not
wait for every stop, start or pause to finish.

## Observe state instead of polling

The API gives complete state and lightweight screen-change notifications:

```ts
import { ApiClient } from "smolmux/client"

const client = await ApiClient.connect(socketPath, {
  onClose: () => { /* mark your surface unavailable; reconnect when appropriate */ },
  onEvent: event => {
    if (event.event !== "session.changed") return
    const { name, sessionId } = event.data
    void client.request("app.capture", { name, sessionId }).then(capture => {
      // Inspect capture.lines and capture.state. Store under this Session ID.
    }).catch(error => {
      // conflict/not_running means that execution was replaced or ended.
      // Route other failures to the controller's diagnostic sink.
    })
  },
})
await client.observe(snapshot => {
  if (!snapshot?.state || snapshot.availability !== "ready") {
    // Retain any partial rows as partial evidence; do not infer successful exits.
    return
  }
  // Replace your current App/Layout projection with snapshot.state.
})
```

For busy Apps, coalesce captures by Session ID: allow one capture in flight,
remember whether another change arrived, then capture once more. Do not spawn
a process or connection per event. Screen changes are byte-driven and debounced
around 100 ms, including for hidden Apps; they are not rendered-frame events.

`observe()` subscribes first, buffers events while requesting `state.get`, installs
the atomic snapshot and publication watermark, then applies newer state events.
Its `onEvent` still delivers transient `session.changed` and `session.exited`
independently of the watermark. Match their UUID to your App's current Session
or `lastExit`; a late event for an older execution must not change its replacement.
`apps.changed` owns declaration roster replacement/removal. Exit does not remove
an App declaration.

The stable `instance_id` names sockets and Adoption. The random feed `instanceId`
identifies a Runtime lifetime and changes after restart. `generation` is currently
1; `sequence` is a publication watermark. Gaps are normal under event filters;
there is no durable event replay. Disconnect invalidates observation. Reconnect,
subscribe, and resnapshot. The built-in client does not reconnect automatically.

Manual consumers can use `event.subscribe` with exact names, a literal trailing
`*` prefix, or `*`. Each subscription replaces this connection's filter set.
Use `*` for a complete projection; selective consumers must include `state.*`
and handle `state.invalidated` by taking another snapshot. A notification or
snapshot that exceeds its bound becomes unavailable, never silently truncated.

## Drive a terminal deliberately

`app.input` accepts semantic events, encoded by that Session's emulator for
its current terminal modes:

```ts
await client.request("app.input", {
  name: "editor", sessionId: executionId,
  events: [
    { key: "escape" },
    { text: ":write" },
    { key: "enter" },
  ],
})
await client.request("app.input", {
  name: "shell", events: [{ paste: "a long literal block\nwith newlines" }],
})
```

`text` is typing, one key per character. `paste` is one paste and is bracketed
when the application requested that mode. A paste is not a command submission;
send Enter separately when the target expects it. Named keys include arrows,
Enter, Escape, Tab, Backspace, Delete, Home, End, PageUp/PageDown, Space and
F1–F24, spelled lowercase. Keys can carry `ctrl`, `alt`, `shift`, `super` and
`action: "press" | "repeat" | "release"`.

Mouse coordinates are zero-based cells within the target Pane, not Stage
coordinates. Its current fitted geometry must be nonzero. Scroll uses
`{mouse:{action:"scroll",x:0,y:0,scroll:{direction:"down",delta:3}}}`.
Do not send raw ANSI bytes through text; the emulator owns encoding.

Input works on hidden keep-running Apps, and is refused while an App is
stopped, paused, transitioning or unreachable. No deferred user input is
replayed on resume or restart. Use `sessionId` when an action was derived from
a particular capture, so an App name reused for a fresh execution cannot
receive stale keystrokes. A successful reply means accepted into the transport
queue, not executed. On timeout or disconnect, inspect state and screen before
retrying a mutating command: the outcome may already have happened.

## Read screens and history

`app.capture({name, sessionId?, scrollback?})` returns `lines`, `screen_start`,
`cols`, `rows`, `cursor`, `title`, `state` and the Session UUID. Lines have trailing
blanks trimmed. With history, `lines.slice(screen_start)` is the current viewport;
the cursor remains viewport-relative. Request up to 10,000 history lines.

Capture works off-screen, paused, and with a lost Companion transport. An
`unreachable` capture is last-known evidence, not a fresh response from the
process. Stop-on-hide, natural exit and remove release the emulator; capture
then returns `not_running` or `not_found`. Save any content you need before
ending that execution; smolmux is not an archive.

History comes from the emulator with no Companion round trip. Measured on the
current implementation, a visible screen takes about 0.4 ms and 10,000 lines
about 20 ms. Older lines may have fallen out of bounded history. Identical blank
pages can collapse at page overlaps. Companion Restore loses approximately one
screenful immediately above the viewport per reattach at the pinned build;
the viewport itself survives. Local Apps have no Restore or recovery history.

## Exit, restart, failure and recovery

The common App states are `stopped`, `starting`, `running`, `pausing`, `paused`,
`resuming`, `stopping`, `exited`, `unreachable` and `failed`. Read `error` on
failed Apps and `lastExit` for the most recent execution's UUID, nullable code
and signal, reason, and cause. Observe state after Layout changes to know when
input or capture becomes available.

Natural exit leaves `state: "exited"` with no Session. Repeated show/hide does
not restart it. Your application chooses whether and when to call
`app.restart({name})`. Restart ends the current execution before creating a new
one and respects hidden policy: a hidden stop/pause App remains stopped until
visible. A launch failure remains declared as `failed`, including when create
returned successfully with that state; inspect the result, not just transport
success. `app.remove` ends any current Session and removes the declaration.

Exit `cause` distinguishes `natural`, `hidden`, `remove`, `restart`, and
`shutdown`. A downstream supervisor should not restart an App merely because
it received `session.exited`; doing so for `hidden` fights the chosen policy.
Never infer a natural process result from code alone: code/signal may be null,
while reason always explains what the owner knows.

Companion transport loss triggers bounded reattachment attempts. A reachable
process restores its emulator; a confirmed ended process becomes exited; one
that cannot be reached remains unreachable for inspection and next Adoption.
The Runtime does not replay uncertain input.

After Runtime loss, local Sessions and declarations are gone. Redeclare local
Apps from your application's own configuration and reapply the Layout. Companion
Sessions are adopted through their labels; no smolmux manifest exists. Only
surviving Sessions carry a declaration across Runtime loss. Sessionless exited
Companion Apps are not persisted either.

Adoption cannot recover the original argv or environment. Adopted Apps report
`argv: null`; restarting requires an explicit command:

```ts
await client.request("app.restart", {
  name: "build", command: {
    argv: ["/bin/sh", "-c", "exec make watch"], cwd: projectDirectory,
    env: { PROJECT_MODE: "development" },
  },
})
```

Use labels to identify declarations your controller owns. Names are unique per
Instance; `app.create` on an existing name returns `conflict`. On an ambiguous
create result, list Apps and verify ownership before proceeding. Do not delete
an App with unexpected labels to make a retry succeed.

The new API and identity labels replace the earlier Session-only contract.
There are no v1 aliases or Adoption migration for old labels. Upgrade smolmux
and its consumer together after stopping old Instances. The separate Companion
wire protocol has not changed.

## Environment, clipboard and diagnosis

Children receive the Runtime environment with `SMOLMUX_*`, `ZMX_*`, `TMUX*` and
`HERDR_*` removed, then the declaration's explicit `env`. Environment values are
never returned by the API. `argv` is an array executed directly: use an explicit
shell only when shell syntax is intended, and never concatenate untrusted input
into shell source. `cwd` must be absolute.

A controller hosted inside a Companion App may need to restart this exact
Runtime after a crash. Explicitly forward its configuration, theme and helper
selectors (`SMOLMUX_CONFIG_PATH`, `SMOLMUX_THEME`, `SMOLMUX_ZMX_DIR`,
`SMOLMUX_ZMX_PATH`, `SMOLMUX_LOCAL_PTY_PATH`) rather than relying on inheritance.
Ordinary Apps generally need none of them. Your own application-specific socket
or context variables can be passed normally.

`client.copy({text})` writes OSC 52 to the foreground terminal or all attached
Clients, including a Client over SSH. It does not retain clipboard content for
future Clients or read the clipboard. `written: true` means the sequence was
written; terminal policy controls whether it updates the user's clipboard.

Runtime diagnostics are private files at
`/tmp/smolmux-<uid>/<instance id>.log`, mode 0600. Nothing writes diagnostics over
the rendered terminal. Check that log, `smolmux status`, `smolmux doctor`, and the
App's `error`, state and lastExit when diagnosing a failure.

| Error | Next action |
| --- | --- |
| `invalid_request`, `unknown_method`, `invalid_params` | Compare the envelope/params with `smolmux api`; use API 2 |
| `not_found` | Refresh declarations; the App may have been removed |
| `not_running` | Inspect state; reveal/resume or explicitly restart as appropriate |
| `conflict` | Refresh Revision or Session UUID; recompute the action |
| `unsupported` | Choose a supported owner/host capability |
| `process_error`, `companion_error` | Inspect App state and Instance log; termination may need retry |
| `internal_error` or disconnected client | Treat mutation outcome as unknown and resnapshot |

The contract bounds requests, capture history, connection queues and subscribers.
Do not make unlimited requests or hold a non-reading subscriber. See the
[reference limits](docs/api.md#limits). Tests that create Instances must stop
and reap them: Companion Sessions intentionally survive their parent process.
For implementation invariants and tests, start at [AGENTS.md](AGENTS.md),
[src/protocol.ts](src/protocol.ts), [src/apps.ts](src/apps.ts),
[src/host.ts](src/host.ts), and [tests/apps.test.ts](tests/apps.test.ts).

## Upgrade the application and API together

Version 0.9.0 uses API 2 and App/Session UUID labels. API 1 methods and old
Session labels are not accepted or adopted; there are no compatibility aliases.
Stop old Instances with their existing applications/binaries before installing
the new source, then start fresh. Upgrade agentmux to 0.32.0 together with
smolmux 0.9.0, including its sibling source dependency. The Companion pin and
wire protocol do not change in this release.
