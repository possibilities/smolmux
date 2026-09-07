# smolmux agent notes

- smolmux is a terminal multiplexer driven over a socket. It starts arbitrary
  Apps in Companion-held or Runtime-owned local PTYs, draws them in a Layout a caller applies,
  and reports what changed. It knows nothing about what a Session runs — no
  agent, harness, task lifecycle, or model concept lives here, and none may be
  added. Generic App ownership and hidden policies belong here. A program that needs those reads screens through `app.capture`
  and owns them itself.
- `CONTEXT.md` is the glossary; use its terms in code, docs, and commits.
  `docs/adr/` holds the decisions, and a superseded record keeps the words it
  was written with rather than being rewritten.
- **The API is the product.** Every method, param, result, event, and error
  code is defined once in the contract table in `src/protocol.ts`, validated
  by the Runtime from that definition, printed by `smolmux api`, and described in
  `docs/api.md` in the same commit. `tests/vocabulary.test.ts` fails when
  `docs/api.md` omits a method; the rest is judgement, in the same commit.
- The CLI is `start`, `attach`, `stop`, `status`, `api`, `doctor`, `event-socket`, and the
  hidden `runtime` verb the Companion execs. Do not add a verb for anything
  the API owns. `smolmux` with no verb starts if needed and attaches.
- smolmux claims exactly one chord. The prefix (`ctrl+b`) is a latch the thin
  Client holds until the next key proves it is not Detach; every other key,
  the prefix included, reaches the focused Session unchanged. There is no
  help surface, no switching key, no toggle. `config.toml` holds `[keys]`
  with `prefix` and `detach` and nothing else — that grammar is deliberately
  shared with Herdr's, but do not mention Herdr in user-facing text.
- **Focus is the API's alone.** `PaneTerminalRenderable` overrides OpenTUI's
  focus so a left mouse-down forwards its mouse report and moves nothing;
  only `Stage.applyFocus` may grant it, through `takeFocus`. A keyboard that
  follows the pointer is one a program driving the Layout cannot reason
  about.
- Applying a Layout must mutate only what moved. Every Pane is absolutely
  positioned at the rectangle `layout.ts` computed, so one apply is one
  layout pass; a Pane whose rectangle is unchanged is not resized, so its
  emulator neither reflows nor tells its PTY anything and a Session that
  stays on screen never blinks. Keep it that way: the fast, clean transition
  is the feature.
- A Session's size authority is `Session.size`, seeded from the create
  request and updated only by `onTerminalResize`. Never read the
  renderable's own `width`/`height` for it: OpenTUI excludes an invisible
  renderable from the layout pass, so a Pane that has never been drawn
  reports one cell, and a transport opened at that size would tell its PTY
  the screen is 1×1.
- `app.capture` composes the emulator into a buffer of smolmux's own
  (`PaneTerminalRenderable.captureScreen`). OpenTUI's `screen()` reads the
  frame buffer a render pass fills, which a hidden Pane never gets, and
  `onScreenChange` fires per rendered frame and only while visible — neither
  is usable. Change detection is byte-driven and debounced instead.
- Scrollback is read from the emulator, never fetched from the Companion. The
  lines are already in this process, so a read costs one compose per page and
  no round trip, and it works for a Session whose transport is lost. Measured:
  a visible-only capture is 0.4 ms and the full 10,000 lines is 19 ms. The
  Companion's `History` frame would serialize its whole pagelist per call and
  need a fork change to bound, which is why smolmux does not use it.
- A Restore costs about one screenful of history, measured exactly `rows` at
  the current pin: the Companion clears the screen between replaying
  scrollback and redrawing the viewport, so the lines just above the viewport
  go. The viewport itself always survives. It bounds what `app.capture`
  can ever read back for a Session that has reattached, and
  `tests/companion-transport.test.ts` asserts the bound rather than the
  number so a Companion that fixes it still passes.
- Reading history scrolls the viewport and puts it back **in the same
  synchronous turn**. Nothing may await in between: the render loop cannot
  preempt a synchronous function, which is the only reason a frame can never
  be drawn at the wrong scroll position. The restore scrolls down by exactly
  what went up, because both ends clamp.
- Until a caller applies a Layout, the one on screen is the Runtime's own and
  follows the roster: the first App, or the empty state when there are
  none. The first `layout.apply` takes ownership and the Runtime never
  composes another. Without this a human attaching to an Instance nobody has
  arranged reads "no sessions" while three are running.
- The Layout carries a revision, moved on by every apply and every divider
  drag. `layout.apply` with an older revision is refused as a conflict so a
  human's drag is never silently undone; omitting it writes unconditionally.
  The guard holds in both directions: a drag whose tree moved under it
  re-baselines on what the apply wrote instead of putting the old tree back.
- A drag moves the boundary under the pointer, by the distance asked, and
  touches only the two Panes it lies between. Changing one adjacent child by
  the delta is not the same thing: an elastic sibling absorbs from the same
  pool, so the grabbed divider can sit still while a different one walks the
  other way. `dragDivider` measures each way of spending the drag against the
  real fit and takes the one that lands the boundary.
- A container's floor is whatever its subtree needs (`requiredLength`), so a
  container is never handed fewer cells than it can draw in. A band of the
  stage that nothing could appear in, with a divider under it, is worse than
  one Pane fewer.
- A squeezed-out Pane is reported at zero, never dropped: `panes` is in tree
  order and a caller zipping it against its own leaves must not misalign as
  the stage narrows.
- `Stage.apply` draws before it commits. A tree it cannot draw is rolled back,
  or every later refit would throw again for the life of the Runtime.
- A frame is refused before `JSON.parse` sees it when it nests too deep: the
  parser is recursive and its overflow is a `RangeError`, not a validation
  failure, so the caller would get no reply at all. Every refusal carries the
  id it read out of the raw line, because a response a caller cannot correlate
  is one it waits on forever.
- Both sides of the API socket queue their writes. A socket takes what it
  takes, and a frame written without handling a partial write is a request
  that never completes.
- smolmux's clear goes straight to the terminal, which OpenTUI's diff cannot see,
  so `Runtime.repaint` forces the next frame to draw in full. Without it a
  same-size resize or a same-theme retint leaves the cleared stage standing.
- **The API socket is the Instance singleton.** It is claimed under a lock
  before anything is adopted, so two Runtimes can never hold the same
  Sessions, and requests arriving during adoption wait rather than being told
  the Sessions do not exist. Its path is `/tmp/smolmux-<uid>/<instance id>.api`.
- **smolmux stores nothing.** The Companion applies a Session's labels before its
  loop accepts any client, so labels are the record: adoption is one
  `list --json` filtered by label and name. There is no Manifest, no claim to
  write before creating, no `markRunning` after, and no crash window between
  them. The Instance id is derived from the configuration directory and the
  name, so nothing smolmux could lose can cost an Instance its Sessions. The
  directory is part of it because the private socket is one path per machine:
  an id from the name alone would make every `default` Instance the same one,
  and a test run would fight the operator's own smolmux over one socket.
- An adopted Session's `argv` is null. The Companion reports a shell-quoted
  display string cut at 256 bytes; it is for reading, never for re-running.
- A headless Runtime renders into its Companion PTY with no terminal attached
  and never ends because the last Client left. A foreground Runtime renders
  directly into its sole terminal, with the same validated socket API, and needs
  no Companion for local Apps. Foreground terminal loss/signals kill locals and
  release Companion Sessions; instance.stop confirms termination of both owners.
  Do not restore --exit-on-last-client or a bootstrap marker.
- Theme: a headless Runtime asks nothing (`resolveFxnkTheme` with a zero
  timeout takes `SMOLMUX_THEME`, then `COLORFGBG`, then dark), and the first
  Client samples its own terminal before relaying anything, then sends the
  same CSI 997 notification a terminal would. The existing live-theme path
  does the rest: drain stale replies behind a DA1 fence, sample OSC 11 behind
  a second fence, discard a sample superseded by a newer notification, then
  replace the complete fixed token set in one render turn.
- Every color smolmux paints comes from `fxnkRamp` (`src/host-palette.ts`):
  fixed indexed roles `255/252/250/245/240` in dark and `235/238/241/247/250`
  in light, plus the surface/unused carve-outs `236/235` and `254/255`. Focus
  and error are direct ANSI slots `4` and `1`, never sampled from the host.
  The canvas stays the terminal default.
- A Runtime resize applies the new physical size to OpenTUI synchronously,
  then clears the whole physical screen before its next frame, inside one
  synchronized-output update. Input can arrive before OpenTUI's debounced
  SIGWINCH handler; applying size first prevents that interaction from
  painting one last frame at the previous owner's size. The clear is what
  leaves genuinely blank unused space on a larger observing Client.
- A terminal Client conceals its physical cursor before asynchronous
  preflight, prepends RIS and concealment to the first actual Restore bytes
  in the same write, and emits nothing at all for an empty cold-Runtime
  Restore so the shell surface stays intact. Every failure path must end
  synchronized output and reveal the cursor.
- `keys.detach` is intercepted by the thin Client and disconnects only that
  Client. There is deliberately no Detach method: a program does not own a
  physical terminal connection. Detaching never ends a Session or the
  Runtime.
- Everything that carries a Session's terminal goes through
  `SessionTransport` (`src/session-transport.ts`). Companion and local transports
  carry terminal bytes; Apps own policy and Sessions own one execution/emulator.
  The local helper has inherited pipes, no socket or service, and owns the command's
  POSIX session, including shell job-control groups. Its liveness descriptor ends
  locals on Runtime SIGKILL even while paused. Never signal outside managed scope.
  The Bun PTY fixture remains test-only.
- A lost transport is not an exit. `Sessions.recover` re-attaches a live
  session (replaying onto the reset emulator), removes one that ended exactly
  as an Exit would, and leaves one it cannot reach after a few tries in the
  roster as `unreachable`, where the next start's adoption finds it. Adoption
  runs the same recovery: one refused attach is not proof, because a daemon
  mid-reap answers a moment later.
- **Nothing a Runtime says goes to stderr.** For a headless Runtime that is
  the Companion PTY OpenTUI draws into, so a diagnostic written there lands
  across every attached Client's screen. Failures with no caller to tell go to
  `instanceLogger` (`/tmp/smolmux-<uid>/<instance id>.log`, mode 0600), and that
  includes the Companion's own listener handler — call
  `setListenerErrorHandler` or its `console.error` default paints the screen.
- Every `void`-discarded promise needs a `.catch` that reaches the log.
  OpenTUI installs an `unhandledRejection` handler that is `console.error`,
  so a rejection nobody catches is a stack trace across the alternate screen.
- `instance.stop` seals the roster synchronously before it kills anything.
  Without that an `app.create` already queued behind another one starts its
  process after the kills went out, is never killed, and reappears on the next
  start because labels are the record.
- `Runtime.start` re-checks `shuttingDown` after every await. A signal during
  adoption destroys the Stage and the renderer; drawing into them afterwards
  is a use-after-free in the layout tree, because OpenTUI's `add` guards only
  the child, never the parent.
- Every Companion command has a deadline (`COMPANION_COMMAND_TIMEOUT_MS`).
  Without one a wedged `list` leaves a Runtime that bound its socket, told
  `smolmux start` it was ready, and answers no request. The timeout cancels the
  child's pipes as well as killing it, or the open read handle keeps the
  process alive.
- The Companion connection bounds both pre-listener output and pending input
  at 32 MiB or 4096 frames. Pending input has a 30-second drain deadline and
  a one-second close grace. A failed flush stays failed after queue cleanup;
  closing a transport must never make dropped input look delivered. Recovery
  replays the screen, never input whose effect may already have happened.
- A connection's outbound queue is capped. A subscriber that stops reading
  without closing is dropped, because a peer that cannot keep up with its own
  events is not one worth holding the Runtime's heap for.
- `session.exited` carries `code` and `signal` as nullable with a `reason`
  that always says something. Nothing in smolmux acts on the exact status, so a
  Companion that cannot read one (a migrated PTY, say) degrades honestly
  rather than breaking a consumer.
- Companion Exit byte 3 bit 0 means status unknown; zero is the legacy known
  status. Decode unknown code and signal as null on both the live wire and
  discovery records, preserving reason through Transport and App exit events.
- A child's environment is smolmux's own with `SMOLMUX_*`, `ZMX_*`, `TMUX*`, and
  `HERDR_*` removed, plus the caller's `env`. A Session must never be able to
  tell it is inside smolmux, or report against an outer pane.
- `smolmux-mcp` is gone, along with the Runtime bridge, ADE, work control,
  subagents, the Manifest, the Tray, the picker, Projects, and Worktrees. Do
  not reintroduce any of them. The `.ade.sock`, `.bus`, `.ctl`, and `.obs`
  paths are unlinked as residue when the API socket binds.
- Every file smolmux owns lives under `/tmp/smolmux-<uid>`, created 0700 and refused
  when it is not ours or is open to others — the same check the Companion's
  own directory gets, made before anything is bound into it. A socket in a
  world-writable directory is one another user can take the moment the
  Runtime that held it exits and unlinks it.
- The Companion's directory is under `/tmp/smolmux-<uid>/zmx`, not the config
  directory: macOS caps a socket path near 104 bytes, and sessions do not
  survive a reboot, so neither need their exit records. smolmux sets `ZMX_DIR` on
  every command it runs.
- The Companion is resolved `SMOLMUX_ZMX_PATH`, then `smolmux-zmx` beside the
  installed binary, then `smolmux-zmx` on PATH, and its build (`smolmux-zmx version`,
  first line) is compared to `companion.json`. Beside smolmux or on PATH, a
  mismatch is fatal; under the override it is one stderr line, because the
  override is the development loop. `smolmux doctor` runs the same resolution and
  check without binding anything.
- Moving the pin is a source-installation act: land the fork change on
  `integration`, push, then use `~/code/zmax/scripts/pin-companion.sh --apply`
  to move `companion.json` to the commit and `<fork version>+fmx.<12 hex>`.
  The pinned build is always made by
  `scripts/build-companion.sh`, reached by `scripts/install.sh` and
  `scripts/install-companion.sh`; one build path, one set of flags.
- Smolmux publishes no binaries, archives, installer payload, latest pointer, or
  release tag. `scripts/install.sh` is the consumer and operator path. The
  tested systems are macOS and Linux on arm64 and x86_64. Only
  `scripts/local-gate.sh` on the current Mac architecture blocks a merge.
- Bumping `PROTOCOL_VERSION` in `src/zmx-protocol.ts` (mirrored by the fork's
  `src/ipc.zig`) is a pair-wide event with survivors: daemons started by the
  previous Companion keep running the old protocol, and every running Session
  on the machine becomes unreachable at once. Before the first bump, build a
  **drain** (record each Session's Companion build and leave survivors on
  screen as unreachable, keeping the previous `smolmux-zmx` beside the new one)
  or a **carry** (speak every protocol version a survivor may hold), and say
  which in an ADR. Drain is the cheaper first answer. Until one exists, the
  protocol version does not move. Note that `src/protocol.ts` is smolmux's own
  API version and is unrelated.

- The event feed uses a random Runtime lifetime `instanceId`, distinct from the
  stable Instance id used for sockets and adoption. `event.subscribe` replaces
  connection-local literal filters; `state.get` reads the complete projection
  synchronously with its publication watermark. `session.changed` and
  `session.exited` are transient notifications and never discarded by snapshot
  watermarks. `apps.changed` owns declaration roster replacement/removal. Generate
  `events.schema.json` from `src/event-schema.ts` whenever the contract changes.

- App declarations outlive natural exits within a Runtime. Session UUIDs change
  on every fresh execution; exit/change notifications carry the UUID and App name.
  Natural exit never automatically restarts an App. Intentional exit cause is
  hidden/remove/restart/shutdown. Adoption reconstructs only surviving Companion
  Apps; strip reserved labels and never reconstruct argv/env from display strings.
- Layout visible is the complete logical set, distinct from fitted shown. Every
  App leaf must be visible and unique. Squeezing, dragging and physical resize do
  not run hidden policies. Commit the drawable Layout before scheduling policies.
  Requested Focus survives a leaf awaiting execution or squeezed off-screen.
- Per-App work serializes create/restart/remove/visibility transitions. Stop frees
  emulator/history; pause retains them and rejects user input until resumed.
  Terminal replies generated during suspension are bounded and resume afterwards;
  user input is never replayed. local/stop and local/pause initially hidden defer
  startup. Companion Apps require keep. Failed launches remain declared as failed.
- Companion kill ACK is not completion. Confirm exit/absence before replacement
  can reuse the deterministic Companion name. Preserve the release barrier after
  Exit removes the emulator, and retain a successfully started execution when
  shutdown termination fails. Cleanup detaches terminal consumers
  and destroys Stage even when process termination reports failure.
- USAGE.md is the agent-facing workflow guide. Update it, docs/api.md, generated
  events.schema.json and the relevant examples whenever behavior changes. README
  stays a short entry point. New APIs must ship with meaningful policy/race tests.
