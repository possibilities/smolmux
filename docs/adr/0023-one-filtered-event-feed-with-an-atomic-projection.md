# One filtered event feed with an atomic projection

Status: accepted, 2026-09-05.

The existing duplex API socket already carries control, reads and events. Keep
it: another endpoint would add discovery and lifetime machinery without a
product need. The Companion and terminal transports remain separate protocols.

`event.subscribe` replaces the connection's literal exact/prefix filters at its
response boundary. `state.get` supplies a complete current projection and a
sequence watermark. A random Runtime lifetime ID distinguishes restart from
continued publication; generation is always one because a Runtime has no
replaceable producer within it. Neither is the stable Instance id naming the
socket and labelled Companion Sessions. The Companion protocol version does
not change.

State reads and event sequence allocation are synchronous with mutation. Each
snapshot detaches its mutable references before an asynchronous response can
let another mutation run. `sessions.changed` replaces the roster, including
creation and removal. `layout.changed` includes the Session rows whose size or
visibility it changed. Reachability remains `live` or `unreachable`; removal
never supplies a fabricated successful exit status.

A subscriber establishes its reader, subscribes, buffers events, and replaces
its projection at the snapshot watermark before applying newer state events.
`session.changed` is a transient Capture trigger; `session.exited` is a transient
exit-status notification. Neither can be discarded merely because it precedes
a snapshot watermark. Disconnect and lifetime/generation change invalidate
observation; reconnect subscribes and reads another snapshot, with no replay.

The projection budget is 2 MiB of serialized UTF-8 data. Failed adoption and
unidentified Companion Sessions are explicitly unavailable/incomplete. An
oversized snapshot has null state and an unavailable reason; an oversized
event becomes `state.invalidated`. Complete state consumers subscribe to `*`;
selective consumers must include invalidation events. This keeps the existing
4 MiB per-connection output budget, 1 MiB incoming frame budget, and 128 pending
requests, and adds a 128-connection cap. Slow consumers are disconnected.

`event-socket` is read-only discovery of the exact Instance selected by name
(default `default`) and configuration directory. It probes the event-capable
API and validates identity, same-user ownership, private modes and path type;
it never starts a Runtime or creates/unlinks paths. The short existing private
socket path keeps macOS path-length constraints intact.

Version 0.8.0 breaks the plural subscription method and standardizes the generic
JSON API error as `internal_error`. There is no alias or dual parser. The known
external caller migrates in the coordinated fleet change. A generated root
`events.schema.json` publishes the runtime contract and typed event catalog,
with drift and real-frame checks; no schema-catalog API is added.
