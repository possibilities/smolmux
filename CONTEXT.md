# fmx glossary

**Agent** — one fx process together with the embedded terminal fmx renders
it in. Agents are numbered by fmx, keep their number across fmx restarts,
and disappear when their fx exits — never when fmx does: the Companion holds
the fx, and the next Runtime for the fmx Session attaches to it.
_Avoid_: pane, tab, window, session, instance.

**Runtime** — the one Companion-held fmx process and PTY for an fmx Session. It owns
the renderer, Multiplexer, sockets, Manifest reconciliation, and shared UI;
it ends when its final Client leaves, while every Agent remains held by the
Companion.
_Avoid_: server, daemon, host, backend.

**Client** — one thin interactive `fmx` invocation and its physical terminal,
attached to the fmx Session's Runtime. It relays terminal bytes and size, and alone
owns Detach; several Clients may watch and interact with the same shared UI.
_Avoid_: viewer, frontend, session, fmx instance.

**Sizing owner** — the Client that most recently connected or interacted by
focus, keyboard, mouse, paste, or resize. The Runtime renders once at its
dimensions; larger Clients have flat, fxnk-theme unused space and smaller
Clients crop the right and bottom until they interact and take ownership.
_Avoid_: leader, primary, active Client, controller.

**Detach** — disconnecting one Client from the Runtime without ending an
Agent. `keys.detach` is Client-local; closing its terminal has the same result.
The final Detach ends the Runtime, while the Companion continues to hold every
Agent.
_Avoid_: exit or close for an Agent, MCP tool, quit.

**Companion** — the zmx fork fmx bundles as `fmx-zmx`: a daemon that owns a
terminal process and its PTY — an fx Agent or the Runtime. fmx drives one over a
versioned Unix socket instead of owning the PTY itself, and never through the
`zmx` a human may have installed — a Companion keeps its own sessions in its
own directory.
_Avoid_: backend, host, server, zmx for the thing itself — though zmx is
still the right word for the wire protocol it speaks and the environment
variables that protocol defines.

**Companion pin** — `companion.json`: the exact fork commit the source
installer builds and the build string that Companion reports. The pin is an
installation unit; fmx refuses a Companion beside it or on `PATH` that reports
any other build, and runs one named by `FMX_ZMX_PATH` with a word about it,
because that override is how a checkout develops the two together.
_Avoid_: lock file, version file, dependency.

**Fx pin** — `fx.json`: the exact approved Fx Integration commit an fmx
source installation builds, plus the minimum fxnk contract fmx accepts. It
lands beside fmx as the real native executable
`fmx-fx`, separate from the `fx` AgentStart installs for direct use; a Runtime
resolves and probes it once, then every new Agent reuses that absolute path.
_Avoid_: bundled Fx, wrapper, AgentStart pin, moving latest.

**Local development gate** — `scripts/local-gate.sh` on the architecture of
the Mac running it. It is the only blocking merge authority; the hosted
four-platform Full CI result is later binary observability.
_Avoid_: release gate, partial verdict, best effort.

**Source installation** — `scripts/install.sh`, the shared consumer and
operator path that links fmx and builds both native pins from exact source.
Fmx has no binary release or publication path.
_Avoid_: release, bucket installer, artifact channel.

**fmx Session** — one independent fmx selected by `--name`, including
`default`. It owns one Agent roster, Runtime, Client set, Manifest, UI state,
and private sockets while sharing `config.toml`, Fx's profile and saved Fx
Conversations, repositories, and binaries with every other fmx Session. The
default uses `~/.config/fmx` (or `$XDG_CONFIG_HOME/fmx`); a named fmx Session
uses its `homes/<name>` child. A short digest of that internal state directory
labels its Companion sessions and stable ADE-feed and Runtime-bridge sockets.
_Avoid_: Home, profile, workspace, instance, Fx Conversation.

**Workplace association** — one explicit shared-configuration record that
maps exactly two distinct fmx Session selectors to opaque placement labels and
names one Workplace instance, Runtime extension, and reusable configuration.
Fmx treats both members uniformly, allows a Session in at most one
association, and never starts the other member. No association is the default.
_Avoid_: role mapping, Manager Session, Worker Session, peer launch.

**Runtime extension** — one implementation-private child process supervised
by an associated Runtime after its ordinary terminal bootstrap. Its explicit
manifest under `runtime-extensions/` supplies an absolute argv, protocol
range, and required headless-liveness declaration: the child does not depend
on an Agent terminal being visible, but it never keeps the host Runtime alive
after the final physical Client leaves. Canonical bounded framed stdio carries
exact readiness, snapshots, presentation, and the recovery-card seam. A cold
associated Runtime fails closed before its first frame when this contract is
unavailable or incompatible, while a later child loss degrades only extension
functionality.
_Avoid_: plugin, MCP server, Runtime bridge, second Agent transport.

**Member snapshot** — the authoritative point-in-time view an associated
Runtime returns for its own fmx Session: its monotonic member revision,
selected stable Agent identity, and exact visible or Manifest-retained Agent
facts. Relevant changes coalesce into a level-triggered invalidation; the
extension pulls another complete snapshot, so neither ADE nor UI transitions
become a replay stream.
_Avoid_: event log, Observation stream, durable transition history.

**Recovery card** — the one bounded Runtime-extension-owned placeholder fmx
may keep visible and selectable for an unavailable managed slot. Fmx renders
only its causal title, message, and single action label, then forwards the
opaque correlated human action; it assigns no Conversation, Position, role,
restart, or resume meaning and exposes no MCP equivalent.
_Avoid_: arbitrary TUI injection, dialog, Agent row, policy fallback.

**Associated Runtime** — a Runtime whose cold-start snapshot accepted one
Workplace association and Runtime extension. It is not started at login and
does not start its peer. Like every Runtime, it ends after its final terminal
Client leaves; the Companion-held Agents survive, and the next ordinary Client
starts a new Runtime and extension which restore them from retained authority.
_Avoid_: service, hidden Client, OS supervisor, live configuration view.

**Manifest** — the fmx Session's `agents.json` (`~/.config/fmx/agents.json` for the
default, `~/.config/fmx/homes/<name>/agents.json` when named), its own record of
the Agents its Companion holds: one entry per Agent carrying its identity,
display number, directory, the fx it runs, and the last ADE lifecycle
checkpoint, written before the Companion is asked to start anything and
removed when the Agent ends. A claim, not the truth: the Companion's sessions
are the truth, and a start joins the two — attaching what both know, adopting
what only the Companion holds, dropping what only the Manifest remembers. It
keeps no prompt text.
_Avoid_: registry (that is the agent registry), state file (that is
`state.json`), Agent list.

**Transport** — what carries one Agent's terminal between fmx and the
Companion: bytes out, bytes in, the size, and the two ways it ends — fx
ending, with a status, against the transport itself dropping, which says
nothing about fx. The seam `FxAgent` renders through; the Companion's
socket is the only one fmx ships.
_Avoid_: connection (that is the socket underneath), PTY, backend.

**Restore** — what the Companion sends first on every attach: the Agent's
whole terminal as it stands, between a `RestoreBegin` the visible terminal
resets at and a `Ready` after which bytes are live. A reconnect replays onto
a clean screen for the same reason a first attach does. The Agent's last
reported agent status is seeded before its row can render; subagent status is
derived again from fx's control records and live locks, then driven by live ADE
snapshots.
_Avoid_: replay, resync, history.

**ADE feed** — the private, one-way, stable-per-fmx-Session Unix socket over which Fx
publishes ordered lifecycle events for every Agent and subagent. It is fmx's
sole Fx lifecycle source: each record carries the stable Manifest Agent
identity, Fx Conversation context, and a complete state-and-attention snapshot, so an
unknown additive event or the first record after a gap repairs live state;
Fx Conversation-name gaps additionally recover from Fx's durable display record.
_Avoid_: Observation stream, control socket, event bus, request/reply channel.

**Pane id** — the retained opaque control and Companion-label identity for an
Agent, `p_<agent id>`. fmx exposes it as `pane_id`, accepts it as a Target, and
keeps it in the Manifest beside the Companion session `fmx-<agent id>`; it no
longer addresses an Fx lifecycle protocol.
_Avoid_: agent id (that is the Manifest's 128-bit token; the number
exported as `FMX_AGENT_ID` is the display id).

**Ramp** — the complete fixed indexed set every fmx-owned surface uses after
selecting an fxnk dark or light theme: foreground, accent, secondary, dim,
divider, surface, and unused field (`fxnkRamp` in `src/host-palette.ts`). The
canvas stays the terminal default. Dark is `255/252/250/245/240` with
surface/unused `236/235`; light is `235/238/241/247/250` with `254/255`.
Focus and error are direct ANSI slots `4` and `1`, each with one job and never
sampled from the host. A state is a glyph and a weight, never a hue.
_Avoid_: host ramp, derived palette, modal colors.

**Tray** — the collapsible left column that carries the Agent list: hidden
while no agent runs or when toggled away, resizable by its divider, its width
and visibility remembered across runs.
_Avoid_: sidebar, panel.

**Agent picker** — the alternate Agent-navigation surface selected by
`--agent-picker`: one full-width outlined control above the active terminal
and a downward-opening list of switchable Agents. It replaces the Tray for
that shared Runtime, shows no subagent rows, and owns focus while its list is
open. With `--hide-single-agent-picker`, the complete control is absent until
at least two Agents exist.
_Avoid_: session dropdown, header, top bar, alternate Tray.

**Agent list** — the Tray's tree of running Agents: Project, then
branch, then one row per agent carrying its status icon and its name — the
native Fx Conversation name once fx reports one, the short compatibility
`session_id` until then.
An agent whose Git context git has no answer for hangs straight off its
project, one rung shallower, rather than under a stand-in branch.
Depth is carried by indentation alone, with no connecting glyphs.
Clicking an agent row switches to that agent; project and branch rows are
not selectable. The switch happens on mouse-down and tray text itself is
not selectable, so pointer navigation never waits for release. Project and
branch labels are the Ramp's foreground and agent names its dim step; the
status icon carries its state by shape and weight, never hue — blocked bold
in the foreground, done in the accent step, the rest dim. The fxnk theme is
resolved before the first frame, so every row, fill, and divider uses one
coherent set immediately. The selected agent's stable Agent identity is
machine state, restored before the first frame so detach and reattach do not
move focus back to agent one.
_Avoid_: agent panel, tab bar, session picker.

**Subagent row** — a non-selectable Agent list row for an fx subagent whose
filesystem control record names a visible Agent's Fx Conversation as its parent.
It uses the agent-row status icon and nests recursively beneath that parent;
its state comes from the control record and the subagent's own session lock.
_Avoid_: child pane, sub-agent.

**Path** — the active agent and its ancestors. The active row takes the
Ramp's surface fill and its ancestors are set in bold; nothing else marks
them, so two faint backgrounds never have to be told apart.
_Avoid_: selection, breadcrumb.

**Project root** — a directory named by `project_roots`. The shared
configuration must name at least one before any fmx Session's TUI can start, and the
first is each Runtime's working directory. Personal roots belong in
`config.toml`, never in a shipped default.
_Avoid_: workspace root, start default, scan directory.

**Agent start level** — the model and reasoning effort a new Agent starts
with, passed to that Fx alone through `FX_MODEL` and `FX_EFFORT`. Fmx retains
the internal environment seam but no longer owns or exposes a model catalog.
_Avoid_: profile, preset, provider setting.

**Worktree** — a checkout fmx cuts for an Agent start, branched from what the
chosen Project has checked out. Its branch and its directory share one name,
`<project>-<ordinal>`, and the ordinal counts against the main repository, so
starting from inside `fmx-1` produces `fmx-2` rather than `fmx-1-1`. A
Project with no commit to branch from cannot produce one.
_Avoid_: branch, checkout, clone.

**Project** — a directory an agent can be started in, which is to say a
directory inside a git repository whose branch can be named. A Project root
and its children qualify or they are not offered, a named directory that does
not is refused, and a repository with nothing committed yet is a Project — its
unborn HEAD still names the branch the Agent list draws — that simply cannot
offer a Worktree. A HEAD naming neither a ref nor a commit names no branch,
so it is not a Project at all.
_Avoid_: workspace, folder, tracked directory.

**Git context** — the Worktree root and branch fmx reads from the Agent
directory it owns rather than treating lifecycle context as repository
authority. Every Agent start is held to one, so an Agent without a context is a
checkout that went away under a running one: its Agent list row hangs
straight off its project, with no rung standing in for the branch that is not
there.
_Avoid_: repo info, workspace, untracked.

**Agent record** — what Fx's ADE snapshots report about one Agent: state,
attention, and Fx Conversation identity. On Restore it begins at the Manifest's last
ADE checkpoint; any later record replaces that state even when the transition
event itself was dropped. Which Agent a human is looking at is fmx's own
knowledge and lives in the Multiplexer.
_Avoid_: session state, pane state.

**Seen** — whether the human has had an agent in front of them since its
state last changed, tracked as a registry-local state version per agent
rather than a clock. An idle agent that is not seen is **done** — finished and
unacknowledged — which is the only difference between the `✓` and `○` icons.
_Avoid_: read, acknowledged, unread.

**Fx Conversation name** — the native display name fx persists for a Conversation and
changes through `/rename`. Fx may infer it from the first admitted prompt, in
which case the name is a lowercase hyphenated slug, and reports committed
changes over ADE as `SessionMetadataChanged`; fmx only reads that authority,
shows the name, and uses exact matches as control targets.
Duplicate names remain ambiguous. The Fx compatibility storage and event
schema call the field `title` and retain `session_id` for identity.
_Avoid_: fmx Session name, label.

**MCP server** — the separate `fmx-mcp` stdio executable and sole supported
agent automation interface. It resolves the caller's Runtime for each tool
call and exposes Orientation, Agent creation and focus, Tray configuration,
and Fx-native semantic work control; it neither owns a Runtime nor keeps one
alive.
_Avoid_: CLI, daemon, Runtime, direct Runtime-bridge client.

**Runtime bridge** — the implementation-private, mode-0600, stable-per-fmx-Session
Unix socket at `/tmp/fmx-<uid>/<home id>.bus` over which the MCP server sends
one correlated request to a running Runtime and receives one response. Each
tool call opens a fresh bounded connection; the bridge carries no observation
stream, subscription, history, or public integration contract, and it neither
counts as a terminal Client nor keeps the Runtime alive.
_Avoid_: Bus, public API, MCP server, control socket, ADE feed, event stream.

**Work control** — the authenticated per-Agent Fx socket through which fmx asks
Fx to snapshot, queue, steer, interrupt, update, delete, or resume semantic
work. Fx owns admission, ordering, pause state, and every returned snapshot;
fmx transports those operations and never types prompts into the Agent's
terminal. Fx normally removes the endpoint it bound; when definitive Agent
death prevents that, fmx removes only the exact socket derived from the
Runtime and stable Agent identity before forgetting the Manifest claim.
_Avoid_: prompt injection, send, terminal paste, fmx queue.

**Turn id** — Fx's opaque positive decimal-string identity for one active or
queued unit of work. MCP returns and accepts it as a string so its native
unsigned 64-bit value is never rounded by JSON tooling.
_Avoid_: queue index, display id, integer position.

**Orientation** — what the MCP server's `get_orientation` tool answers: the
selected fmx Session, the caller's own Agent as `you`, every
Agent, the Tray's rows as drawn, and whatever surface is open. A read, which
never marks anything Seen.
_Avoid_: status, state dump, introspection.

**Target** — how an MCP tool names an Agent: its stable Agent id or Pane id,
its display id, `current` for the caller's own, `active` for the one on screen,
`next` or `previous` relative to it, or an exact Fx Conversation name, with a
compatibility `session_id` prefix as the fallback.
_Avoid_: selector, handle, address.

**UI gallery** — the developer-only TUI that browses fmx-owned OpenTUI
components and blocks. Each component has executable states that mount the real
renderables under deterministic fakes; the selected fixed fxnk set — dark,
light, or the default-dark no-signal case — applies to the whole gallery
independently of the selected component and state. Useful states can accept
their real keys and mouse controls inside an isolated exact-size renderer.
`gallery:check` renders and asserts every state under every theme headlessly.
_Avoid_: Storybook (there is no Storybook runtime), screenshot suite.
