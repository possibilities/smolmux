# The smolmux API

API version **2**, defined once in [src/protocol.ts](../src/protocol.ts).
`smolmux api` prints the machine-readable contract; [USAGE.md](../USAGE.md)
teaches practical workflows. [events.schema.json](../events.schema.json)
catalogs request, response and typed event frames.

## Connection and envelopes

`smolmux event-socket --name NAME` verifies and prints the selected live socket
without starting a Runtime. `start` and `status` also report the socket.
`NAME` defaults to `default`; the configuration directory also participates in
Instance identity. The socket is `/tmp/smolmux-<uid>/<instance id>.api`, mode
0600, in a private 0700 directory. Discovery refuses symlinks and unsafe ownership.
Both headless and foreground hosts expose this API.

One UTF-8 JSON object per line on a long-lived duplex Unix socket:

```json
{"v":2,"type":"request","id":"1","method":"app.list","params":{}}
{"v":2,"type":"response","id":"1","ok":true,"result":{"apps":[]}}
{"v":2,"type":"response","id":"2","ok":false,"error":{"code":"not_found","message":"no App named docs"}}
{"v":2,"type":"event","event":"theme.changed","data":{"instanceId":"runtime-lifetime","generation":1,"sequence":3,"theme":"dark"}}
```

IDs are nonempty strings of at most 128 characters. Correlate responses by ID;
requests can finish out of order. Await operations on which another depends.
Unknown envelope/parameter fields and old API versions are refused. Empty-method
params may be omitted or null. There are no v1 method aliases. Uncorrelatable
malformed requests may have a null response ID; a client must not wait forever.

## Common result shapes

An App declaration survives its Session exiting within this Runtime. It has
at most one Session. Layout leaves name Apps, not execution IDs.

```ts
type AppView = {
  name: string
  pty: "companion" | "local"
  whenHidden: "keep" | "stop" | "pause"
  cwd: string
  argv: string[] | null       // null after Companion Adoption
  created_at: number          // declaration creation time, milliseconds
  title: string
  cols: number
  rows: number
  visible: boolean            // logical Visibility
  shown: boolean              // fitted Pane has cells and a terminal
  state: "stopped" | "starting" | "running" | "pausing" | "paused" |
         "resuming" | "stopping" | "exited" | "unreachable" | "failed"
  session: null | {
    id: string                // execution UUID, new on every start/restart
    pid: number | null
    created_at: number        // execution creation time, milliseconds
    state: "live" | "paused" | "unreachable"
  }
  lastExit: null | {
    sessionId: string
    code: number | null
    signal: number | null
    reason: string
    cause: "natural" | "hidden" | "remove" | "restart" | "shutdown"
  }
  error: string | null
  labels: Record<string, string>
}
```

Environment values are never published. Size comes from the current Session,
or the declaration's initial/last stopped size. `title` is empty without a
current terminal. Labels include caller labels plus the public ownership
labels `owner`, `instance`, and `app`; Session UUID lives in `session.id`.

`InstanceStatus` contains `version`, Runtime `pid`, Instance `name`, stable
`instance_id`, `socket`, `stage:{cols,rows}`, `theme:"dark"|"light"`, `apps:AppView[]`,
`layout:LayoutView`, `host:"headless"|"foreground"`, and
`capabilities:{local:boolean,companion:boolean}`. Capabilities identify installed
Runtime implementations; a launch can still fail if its helper cannot be resolved.

## Methods

### `instance.status`

Params `{}`. Returns the complete `InstanceStatus` above.

### `instance.stop`

Params `{}`. Seals declarations synchronously, waits for queued App work,
terminates all local and Companion Sessions, then returns `{}` and shuts down.
`instance.stopping` precedes teardown and the response precedes socket close.
If termination is unconfirmed, returns `companion_error` naming survivors and
keeps the Instance available for retry. A later stop may finish it.

A foreground host ending by terminal loss or signal instead terminates locals
and releases Companion Sessions for later Adoption. Detaching a headless Client
ends neither the Runtime nor its Sessions.

### `app.create`

Params:

```ts
{
  name: string                // [a-z][a-z0-9_-]{0,31}, unique per Instance
  argv: string[]              // nonempty array of nonempty strings; executable first, direct exec
  cwd: string                 // absolute path
  env?: Record<string,string>
  pty: "companion" | "local"  // required
  whenHidden?: "keep" | "stop" | "pause" // default keep
  cols?: number               // default 80
  rows?: number               // default 24
  labels?: Record<string,string>
}
```

Returns `AppView`. A duplicate name is `conflict`; invalid policy is
`invalid_params`. Companion Apps require keep. Keep Apps start immediately.
Local stop/pause Apps initially hidden defer startup until visible. The Default
Layout selects the first App unless a caller already applied its own Layout.

The process gets the Runtime environment with `SMOLMUX_*`, `ZMX_*`, `TMUX*`,
`HERDR_*` removed, then caller env applied. Explicit env can forward those
variables to a hosted controller. `argv` is not shell source. Label keys/values
match `[A-Za-z0-9_.-]+`; `owner`, `instance`, `app`, `session`, `kind` are reserved.

Initial dimensions are each 1–4096 and their product at most 262144. A Pane's
later geometry sizes the Session; hiding retains that size. Process startup
failure leaves the declaration in `failed` with `error`; create can therefore
succeed at declaration with a failed App result. Inspect state.

### `app.remove`

Params `{name}`. Confirms termination of the current Session, if any, and
removes the declaration; returns `{}`. Unknown App is `not_found`. A failed
termination preserves the declaration and reports an error. It does not rewrite
a caller-owned Layout; that App leaf becomes empty.

### `app.restart`

Params `{name, command?:{argv,cwd,env?}}`. Supplied command replaces argv, cwd and env (omitted env clears the previous overrides). Ends the current execution and requests
a new one with a new UUID, respecting the hidden policy. Returns `AppView`.
A hidden stop/pause App stays stopped until revealed. Natural exits never
restart automatically. A new launch failure remains `failed` with `error`.

Omitted command reuses the original declaration. An adopted Companion App has
no original argv/environment, so restart requires command or returns
`invalid_params`. Ownership, hidden policy and caller labels remain fixed.

### `app.list`

Params `{}`. Returns `{apps:AppView[]}` in declaration order, including
sessionless stopped, exited and failed Apps.

### `app.capture`

Params `{name, sessionId?:UUID, scrollback?:number}`. `scrollback` is 0–10000,
default zero. Returns:

```ts
{
  name: string
  sessionId: string
  lines: string[]
  screen_start: number
  cols: number
  rows: number
  cursor: {x:number,y:number,visible:boolean}
  title: string
  state: "running" | "paused" | "unreachable"
}
```

Reads the current emulator, even hidden, paused or with a lost Companion
transport. `unreachable` means last-known screen, not fresh process evidence.
No current Session is `not_running`; a supplied UUID that names another
execution is `conflict`. Unknown App is `not_found`.

Lines have trailing blanks trimmed; history precedes the viewport, which is
`lines.slice(screen_start)`. Cursor coordinates are viewport-relative. History
is read synchronously from the emulator with no Companion round trip. Bounded
older history can be gone, identical blank pages may collapse at overlaps,
and the pinned Companion Restore loses roughly one screenful above the viewport
per reattach. The viewport survives. Stop, remove and natural exit release
history entirely. Captures are not durable archives.

### `app.input`

Params `{name, sessionId?:UUID, events:InputEvent[]}`. Returns `{}` after accepting
semantic input into the transport. Input requires App state `running`; paused,
stopped, transitioning, failed and unreachable Apps refuse with `not_running`.
A replacement UUID is `conflict`. Input never changes human Focus.

Each event is exactly one of:

- `{key:string,ctrl?:boolean,alt?:boolean,shift?:boolean,super?:boolean,action?:"press"|"repeat"|"release"}`. Default action press. Key is one character or lowercase `enter`, `escape`, `tab`, `backspace`, `delete`, `insert`, `home`, `end`, `pageup`, `pagedown`, `up`, `down`, `left`, `right`, `space`, `f1`–`f24`.
- `{text:string}`: one key press per character, like typing.
- `{paste:string}`: one paste, bracketed when the Session enabled that mode.
- `{mouse:{action:"down"|"up"|"move"|"drag"|"scroll",button?:"left"|"middle"|"right",x:number,y:number,ctrl?:boolean,alt?:boolean,shift?:boolean,super?:boolean,scroll?:{direction:"up"|"down"|"left"|"right",delta:number}}}`. Button defaults left; scroll action requires direction and integer delta 1–100. Other actions must omit scroll.

Mouse uses zero-based cells inside the target Pane. It requires nonzero fitted
geometry; hidden/squeezed targets return `not_found`. Keys/text/paste work on
hidden running Apps. Semantic events are encoded for current emulator modes;
there is no raw-byte input method. Batches preserve event order and validate
before delivery. Transport failure can still make delivery partial/uncertain.
Never automatically replay input on reconnect or restart. Success is acceptance,
not proof the process acted. Inspect the screen before retrying uncertain work.

### `layout.apply`

Params `{root:LayoutNode|null, visible:string[], focus?:string|null, revision?:number}`.
Returns `LayoutView`. `visible` is required, unique and includes every App leaf.
Extra visible names support caller-side fitting or future declarations. App leaves
must be unique. Unknown Apps may be named before they are declared.

```json
{"root":{"row":[{"column":[{"text":"Tools","size":2},{"app":"files"}],"size":26,"min":20},{"app":"shell","min":30}]},"visible":["files","shell"],"focus":"shell","revision":7}
```

A node is `{row:LayoutNode[]}`, `{column:LayoutNode[]}`, `{app:string}` or
`{text:string}`. Every node may carry `size` and `min`, positive cells along its
parent's axis. Text is at most 200 characters. Omitted size shares remaining
space; min defaults to one, subject to subtree requirements. Containers need
at least one child. Boundaries cost one divider cell.

The tree draws before commit. Validation/drawing/revision failure changes no
Visibility or hidden policy. A successful commit starts asynchronous policy
reconciliation, observable through App states/events. Geometry fitting and
physical resizing never change logical Visibility. Stop-on-hide frees the
Session; reveal starts a fresh UUID. Pause retains the Session until resume.

Focus names an App leaf or is cleared with null. Omitted focus keeps the
previous intention if its leaf remains in the tree. A missing execution or
squeezed leaf retains the intention but cannot take physical keyboard input.
A name absent from the tree becomes null. Clicks never change Focus.

Revision advances on every apply and divider drag. A supplied revision unequal
to the current revision returns `conflict`; omit for unconditional replacement.
Resize refits without moving Revision. Preserve returned tree sizes after drags.
Only moved rectangles are resized.

Before the first apply, the Runtime's Default Layout follows the first declared
App, or `no apps` when none exist. First apply permanently gives ownership to
the caller for this Runtime, including when its root is null.

### `layout.get`

Params `{}`. Returns:

```ts
type LayoutView = {
  revision: number
  root: LayoutNode | null
  visible: string[]
  focus: string | null
  stage: {cols:number,rows:number}
  panes: {
    app:string|null; text:string|null;
    x:number; y:number; cols:number; rows:number; focused:boolean
  }[]
}
```

Every fitted leaf stays in tree order. A squeezed-out Pane is reported with
zero width or height, never dropped. `focused` describes fitted Focus geometry;
App `shown` additionally requires a current terminal.

### `client.copy`

Params `{text:string}` (1–65536 characters). Returns `{written:boolean}`.
Writes OSC 52 to the foreground terminal or all attached Clients; terminal
policy decides whether the clipboard is updated. Nothing is retained for a
future Client. There is no read method.

### `event.subscribe`

Params `{events?:string[]}`, default `["*"]`; omitted/null params mean `{}`.
Returns `{subscribed:true,events:string[]}`. Accepts 1–32 entries, each 1–128
characters, matching `^(?:\*|[a-z][a-z0-9._:/-]*\*?)$`. Duplicates are removed.
Exact names, a literal trailing-`*` prefix, and `*` are supported. Unknown
well-formed names are valid; there is no regex/glob interpretation.

Each request replaces this connection's filters. Its successful response is
the replacement boundary: prior queued events can precede it, later events
use the new filters. Invalid filters preserve the old subscription. Disconnect
unsubscribes; other API requests remain available on the same socket.

### `state.get`

Params `{}`. Returns `{instanceId,generation,sequence,availability,reason,state}`.
`instanceId` is a random Runtime lifetime identity, distinct from stable
`InstanceStatus.instance_id`; `generation` is currently 1; sequence is the
publication watermark. `state` is a detached complete InstanceStatus or null.
Availability is `ready`, `incomplete`, or `unavailable`; reason is string or null.

Snapshot construction and sequence allocation are synchronous with publication.
Every event advances the sequence, even when filters exclude it; gaps are
normal. No durable event replay exists. No terminal content appears in snapshots.
Unidentified Companion inventory makes Adoption incomplete; failed/pending
Adoption is unavailable. Known unreachable Apps alone do not make the inventory
incomplete. A stopping Instance is unavailable. Above the projection bound,
state is null with a reason; it is never truncated.

Subscribe first, buffer events, request state.get, then replace state at its
watermark and apply newer state events from the same lifetime/generation.
Transient Session notifications are delivered independently of snapshot
watermarks, but must be matched by Session UUID before affecting a replacement.
`apps.changed` owns roster removal. On disconnect invalidate state; reconnect,
subscribe and resnapshot. Resnapshot after `state.invalidated`.

`ApiClient.observe(onState, filters?)` performs this handshake, applies projected
updates and calls onState(null) on disconnect. Its onEvent callback separately
delivers transient events. Default filters are `*`; complete observers should
keep that. Selective observers need `state.*` to detect invalidation.

## Events

Every event data includes `{instanceId:string,generation:1,sequence:number}`.

| Event | Kind | Additional data |
| --- | --- | --- |
| `apps.changed` | current state | `apps:AppView[]`, `availability`, `reason`: complete/partial declaration roster |
| `app.state` | current state | `app:AppView`: replace this complete App view |
| `layout.changed` | current state | `layout:LayoutView`, `apps:AppView[]`, `cause:"apply"|"drag"|"resize"` |
| `stage.changed` | current state | `cols`, `rows` |
| `theme.changed` | current state | `theme:"dark"|"light"` |
| `state.invalidated` | current state | `reason`: replace observation with another snapshot |
| `instance.stopping` | current state | no additional data |
| `session.changed` | transient | `name`, `sessionId`, `title`: output/title reached the emulator; debounced about 100 ms, including hidden terminals |
| `session.exited` | transient | `name`, `sessionId`, nullable `code` and `signal`, `reason`, `cause:"natural"|"hidden"|"remove"|"restart"|"shutdown"` |

An exit retains the declaration unless remove also succeeds. Code and signal
are null when the owner cannot read them. Reason always carries information;
cause records why smolmux requested termination, or natural when it did not.
A notification is not permission to restart an intentionally hidden App.

## Errors

| Code | Meaning |
| --- | --- |
| `invalid_request` | Malformed/unsupported envelope or connection-specific operation |
| `unknown_method` | Method is not in this API |
| `invalid_params` | Contract violation, bad policy, duplicate leaf, reserved label, unavailable adopted command |
| `not_found` | Unknown App, or mouse target has no fitted Pane |
| `conflict` | Existing App name, stale Revision/Session guard, removal underway, or Instance shutting down |
| `not_running` | No Session to capture or App state cannot accept input |
| `unsupported` | Requested PTY owner is unavailable in this Runtime |
| `process_error` | Local process operation failed |
| `companion_error` | Companion operation or Instance termination failed |
| `internal_error` | Unexpected failure, invalid response, connection/deadline failure in the client |

Failures carry a human-readable message. Launch errors may instead be represented
by a successfully declared App in failed state. On deadline/disconnect, mutating
outcome is unknown; obtain current state before retrying.

## Limits

- Request frames: 1 MiB UTF-8, nesting bounded before JSON parsing; Layout depth limit 32.
- API connections: 128; concurrent requests per connection: 128.
- API queued writes: 4 MiB per peer; slow subscribers are disconnected.
- Projection/event payload: 2 MiB; oversized event becomes state.invalidated.
- Client pending requests: 128; queued writes: 4 MiB; default request deadline: 60 seconds.
- Observation startup buffer: 4096 events or 4 MiB; overflow disconnects.
- Input: 1–256 events; text: 1–4096 characters; paste: 1–65536 characters.
- Capture scrollback: 0–10000 lines.
- Session transport queues: 32 MiB or 4096 frames; input drain deadline 30 seconds.
- Local startup/control acknowledgment: 5-second client deadline; suspension settlement: 3 seconds; termination escalation: TERM/CONT then KILL after 1 second, bounded cleanup confirmation.

The Companion wire protocol is separate from this API and was not bumped for
API 2. smolmux provides neither domain-specific agent management, MCP, raw-byte
observation/input, nor a disk manifest. Your controller owns application meaning,
configuration persistence and restart decisions.
