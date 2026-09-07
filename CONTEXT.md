# smolmux glossary

**Instance** — one running smolmux: a Runtime, its Apps, one Layout, and one
API socket. Named by `--name`, `default` unless told otherwise; several run
side by side and share nothing but `config.toml`. Its id is derived from that
file's directory and its name, never stored, and labels every Companion
session it creates; the directory is in it because the private socket is one
path per machine.
_Avoid_: home, profile, workspace, server.

**App** — a named command declaration in an Instance: argv, directory,
environment, PTY ownership, and behavior while hidden. It remains declared
when its process stops or exits; it has at most one current Session.
_Avoid_: pane, session, agent, job.

**Session** — one execution of an App, with a unique id, a process and PTY,
and the emulator smolmux renders. A Companion-held Session survives the
Runtime; a local Session belongs to it and ends with it.
_Avoid_: app, pane, agent, window, tab, instance, job.

**Visibility** — the caller's logical set of Apps that should be presented,
committed with the Layout and its Revision. Hidden policies follow this set;
`shown` separately reports whether the fitted Pane actually has cells.
_Avoid_: focus, shown, geometry.

**Hidden policy** — a local App's `whenHidden`: `keep` continues running,
`stop` ends its Session and starts fresh when visible, and `pause` suspends
and resumes the same Session. Companion Apps always keep running.
_Avoid_: lifecycle, suspension policy, agent state.

**Layout** — the tree of rows and columns whose leaves are Panes, applied
whole by `layout.apply`. Sizes live in the tree, so resizing a Pane is
applying a tree with a different size; there is no resize verb. smolmux fits it
to the Stage and re-fits on every change, so each Session hears its size once.
_Avoid_: window, grid, arrangement, split.

**Pane** — one leaf of the Layout: a rectangle showing one App’s terminal, or one
line of text. It has a size in columns or rows, or takes the remainder, and a
`min` it will not be squeezed below.
_Avoid_: panel, tile, slot, cell, viewport.

**Default Layout** — what a Runtime draws before any caller has applied one:
the first App, or the line `no apps` when there are none. It is the
Runtime's own and follows the roster; the first `layout.apply` takes
ownership, after which the Runtime composes no Layout however the roster
moves.
_Avoid_: fallback, empty state (that is the text it draws with no Apps),
initial layout.

**Revision** — the counter the Layout carries, moved on by every apply and
every divider drag. A caller passes back the revision its tree was built from
and a stale write is refused, so a human's drag is never silently undone by a
read-modify-write that crossed it.
_Avoid_: version, generation, etag, sequence.

**Stage** — the drawn area, at the sizing owner's dimensions for a headless
Runtime, or its physical terminal's dimensions for a foreground Runtime. Cells no Pane
covers stay the terminal's own canvas.
_Avoid_: screen, canvas, window, viewport.

**Focus** — the App leaf intended to receive the keyboard, named by `layout.apply`
and moved by nothing else. It remains intended while starting or squeezed,
but receives input only while shown; leaving the tree clears it.
_Avoid_: active pane, selection, current.

**Divider** — the one-cell boundary between siblings in a container, drawn in
the Ramp's divider step. Dragging one changes the sized Pane beside it and
publishes `layout.changed` with cause `drag`.
_Avoid_: border, splitter, gutter, handle.

**Capture** — an App's current Session screen as text with its cursor and title, read by
`app.capture` whether or not a Pane shows it, optionally with lines that
have scrolled off the top. It composes the emulator into a buffer of smolmux's own
rather than reading the frame a render pass drew, because a hidden Pane is
never drawn, and it reads history from that same emulator rather than from the
Companion. Paired with `session.changed`, it is the whole screen-reading
surface; there is no byte-level observation.
_Avoid_: screenshot, dump, scrape, snapshot.

**Runtime** — the smolmux process owning the App declarations, Sessions,
renderer, Stage, and API socket. It either renders headlessly in a Companion
PTY for attached Clients, or directly in its foreground terminal; closing a
foreground Runtime ends local Sessions and releases Companion Sessions.
_Avoid_: server, daemon, backend.

**Client** — one thin interactive `smolmux attach` and its physical terminal. It
relays terminal bytes and size, samples its own background so the Runtime can
follow it, and alone owns Detach. Several may watch and interact with the
same Stage, and `client.copy` puts text on every one's clipboard.
_Avoid_: viewer, frontend, session, smolmux instance.

**Sizing owner** — the Client that most recently connected or interacted by
focus, keyboard, mouse, paste, or resize. The Runtime renders once at its
dimensions; larger Clients have flat unused space and smaller Clients crop
until they interact and take ownership.
_Avoid_: leader, primary, active Client, controller.

**Detach** — disconnecting one Client without ending anything. `keys.detach`
is Client-local and closing the terminal has the same result. The Runtime and
every Session continue.
_Avoid_: exit, close, quit, stop.

**Companion** — the zmx fork smolmux bundles as `smolmux-zmx`: a daemon that owns a
terminal process and its PTY — a Session, or the Runtime itself. smolmux drives
one over a versioned Unix socket instead of owning the PTY, and never through
a `zmx` a human may have installed.
_Avoid_: backend, host, server, zmx for the thing itself — though zmx is
still the right word for the wire protocol and the environment variables it
defines.

**Companion pin** — `companion.json`: the exact fork commit the source
installer builds and the build string that Companion reports. The pin is an
installation unit; smolmux refuses a Companion beside it or on `PATH` that reports
any other build, and runs one named by `SMOLMUX_ZMX_PATH` with a word about it.
_Avoid_: lock file, version file, dependency.

**Adoption** — how a starting Runtime finds the Sessions its Companion still
holds: `list --json`, filtered to the sessions whose labels and name name this
Instance. Labels are applied before any client can see a session, so they are
the record and smolmux keeps no file of its own. An exited session's record is
consumed; one that cannot be read is left for the next start.
_Avoid_: reconciliation, restore, join, manifest.

**Transport** — what carries one Session's terminal between its emulator and its PTY owner: bytes out, bytes in, the size, and the two ways it ends — the
process ending, with a status, against the transport itself dropping, which
says nothing about the process. The seam a Session renders through, independent of process ownership;
Companion and local PTYs use it.
_Avoid_: connection (that is the socket underneath), PTY, backend.

**Restore** — what the Companion sends first on every attach: the Session's
whole terminal as it stands, between a `RestoreBegin` the emulator resets at
and a `Ready` after which bytes are live. A reconnect replays onto a clean
screen for the same reason a first attach does.
_Avoid_: replay, resync, history.

**Ramp** — the complete fixed indexed set every smolmux-owned surface uses after
selecting a dark or light theme: foreground, accent, secondary, dim, divider,
surface, and unused field. The canvas stays the terminal default. Dark is
`255/252/250/245/240` with surface/unused `236/235`; light is
`235/238/241/247/250` with `254/255`. Focus and error are direct ANSI slots
`4` and `1`, each with one job and never sampled from the host.
_Avoid_: host ramp, derived palette, theme colors.

**Local development gate** — `scripts/local-gate.sh` on the architecture of
the Mac running it. It is the only blocking merge authority; the hosted
four-platform CI result is later binary observability.
_Avoid_: release gate, partial verdict, best effort.

**Source installation** — `scripts/install.sh`, the shared consumer and
operator path that links smolmux, builds the local helper, and optionally builds
the Companion pin from exact source.
Smolmux has no binary release or publication path.
_Avoid_: release, bucket installer, artifact channel.
