# smolmux glossary

**Instance** — one named running smolmux: a Runtime, its Apps, one Layout, and one API socket. Instances are independent even when they share configuration.
_Avoid_: home, profile, workspace, server.

**App** — a named command declaration in an Instance. It remains declared when its process exits and has at most one current Session.
_Avoid_: pane, session, agent, job.

**Session** — one execution of an App, with its own process, PTY, and terminal state. A Companion-held Session can outlive the Runtime; a local one cannot.
_Avoid_: app, pane, agent, window, tab, instance, job.

**Visibility** — the caller's logical set of Apps to present with a Layout. A visible App may still have no drawn cells.
_Avoid_: focus, shown, geometry.

**Hidden policy** — what happens to a local App's Session while the App is not visible: keep it running, stop it and start fresh on return, or pause and resume it. Companion Apps keep running.
_Avoid_: lifecycle, suspension policy, agent state.

**Layout** — a tree of rows and columns whose leaves are Panes. The caller applies it as a whole, and smolmux fits it to the Stage.
_Avoid_: window, grid, arrangement, split.

**Pane** — a Layout leaf showing an App's terminal or a line of text. It may have a fixed size, take the remainder, and specify a minimum size.
_Avoid_: panel, tile, slot, cell, viewport.

**Default Layout** — the Runtime-owned view before a caller applies a Layout: the first App, or `no apps` when none exist. It follows the App roster until the caller takes ownership.
_Avoid_: fallback, empty state, initial layout.

**Revision** — the Layout counter that changes when the tree is applied, a Divider moves, or Focus changes by click. A caller can use it to reject a stale Layout write.
_Avoid_: version, generation, etag, sequence.

**Stage** — the area in which a Runtime draws Panes. Its size comes from the physical terminal or, for a headless Runtime, the Sizing owner.
_Avoid_: screen, canvas, window, viewport.

**Focus** — the App leaf intended to receive keyboard input while shown. A Layout or permitted physical click may select it; targeted App input does not.
_Avoid_: active pane, selection, current.

**Divider** — the one-cell boundary between sibling Panes or containers that a Client can drag to change their fitted sizes.
_Avoid_: border, splitter, gutter, handle.

**Capture** — the current Session screen and optional scrollback read for an App, whether or not its Pane is drawn.
_Avoid_: screenshot, dump, scrape, snapshot.

**Runtime** — the smolmux process that owns App declarations, Sessions, the Stage, and the API socket. It can render headlessly or in a foreground terminal.
_Avoid_: server, daemon, backend.

**Stop operation** — one observable attempt to end an Instance and its Apps. Concurrent requests join it; a failed attempt remains readable and retryable.
_Avoid_: detach, shutdown request, graceful hint.

**Client** — one interactive terminal attached to a Runtime. Clients share a Stage, while each owns its own Detach.
_Avoid_: viewer, frontend, session, smolmux instance.

**Sizing owner** — the Client whose latest connection or interaction determines the shared Stage size. Other Clients may see unused space or a cropped view.
_Avoid_: leader, primary, active Client, controller.

**Detach** — disconnecting one Client while the Runtime and Sessions continue.
_Avoid_: exit, close, quit, stop.

**Companion** — the bundled zmx fork that owns a Session or headless Runtime and its PTY beyond a Runtime's lifetime.
_Avoid_: backend, host, server, zmx for the thing itself.

**Companion pin** — the exact Companion source commit and reported build identity used for a source installation.
_Avoid_: lock file, version file, dependency.

**Adoption** — how a starting Runtime recognizes Companion-held Sessions belonging to its Instance, using their names and labels rather than a saved manifest.
_Avoid_: reconciliation, restore, join, manifest.

**Transport** — the Session boundary that carries terminal input, output, and size between an emulator and a PTY owner, and distinguishes process exit from a lost connection.
_Avoid_: connection, PTY, backend.

**Restore** — the Companion's initial account of a Session's terminal state when a Runtime attaches or reconnects, before live bytes resume.
_Avoid_: replay, resync, history.

**Presentation** — the first complete frame a newly attached Client makes visible after the Runtime adjusts to that terminal.
_Avoid_: splash, loading screen, startup delay.

**Ramp** — the fixed set of indexed color roles used for smolmux-owned surfaces in a dark or light appearance.
_Avoid_: host ramp, derived palette, theme colors.
