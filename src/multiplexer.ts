import {
  bold,
  BoxRenderable,
  type CliRenderer,
  CliRenderEvents,
  type EmbeddedTerminalDataSource,
  fg,
  type KeyEvent,
  type MouseEvent,
  type Selection,
  StyledText,
  type TextChunk,
  TextRenderable,
} from "@opentui/core"
import { homedir } from "node:os"
import { basename, isAbsolute, normalize, resolve } from "node:path"
import {
  type AgentAttention,
  AgentRegistry,
  type DisplayState,
  displayStateFor,
  shortSessionId,
} from "./agent-registry.ts"
import { AgentPicker, type AgentPickerNavigationEntry } from "./agent-picker.ts"
import {
  AGENTWORKPLACE_CONTRACT_VERSION,
  RUNTIME_EXTENSION_SCHEMA_ID,
  runtimeExtensionMessageSchema,
} from "./agentworkplace-contracts.ts"
import type { AdeEventSource, AdeRecord } from "./ade-events.ts"
import { VERSION } from "./cli.ts"
import { DEFAULT_WORKTREE_ROOT, type AgentDefaults } from "./config.ts"
import {
  ControlFailure,
  type ControlMethod,
  type AgentInfo,
  type ControlSurface,
  optionalBoolean,
  optionalInteger,
  optionalString,
  parseTarget,
  requiredString,
  type TrayRow,
  type Snapshot,
  type SubagentInfo,
  type Surface,
  type Target,
} from "./control-protocol.ts"
import { CursorReportAdapter } from "./cursor-report-adapter.ts"
import {
  createFxEnvironment,
  type FxAdeBinding,
  type FxStartLevel,
} from "./fx-environment.ts"
import {
  identityFor,
  isAgentId,
  mintIdentity,
  type AgentManifest,
  type ManifestEntry,
} from "./agent-manifest.ts"
import {
  FxWorkControlClient,
  FxWorkControlError,
  mintFxWorkControlBinding,
  removeFxWorkControlResidue,
  type FxWorkControlBinding,
  type FxWorkControlMethod,
  type FxWorkControlRequester,
  type FxWorkControlResult,
} from "./fx-work-control.ts"
import {
  AgentEndedError,
  AgentStartConflictError,
  AgentUnreachableError,
  type AgentExit,
  type AgentStart,
  type AgentTransport,
  type AgentTransportFactory,
  stringEnvironment,
  type TerminalSize,
} from "./agent-transport.ts"
import { FxTerminalRenderable } from "./fx-terminal.ts"
import {
  indexRuntimeMemberCorrelations,
  type RuntimeMemberCorrelation,
  type RuntimeMemberCorrelationSource,
} from "./runtime-member-correlation.ts"
import {
  type FxnkThemeResolution,
  fxnkRamp,
  type Ramp,
  themeModeReport,
} from "./host-palette.ts"
import {
  ACTION_FIELDS,
  actionForKey,
  isCancelKey,
  keyIdentity,
  keyMatchesCombo,
  parseKeyCombo,
  type KeyAction,
  type KeyActionName,
  type Keybindings,
  type ResolvedBinding,
} from "./keybindings.ts"
import {
  isRepositoryDirectory,
  readGitContext,
  projectNameFor,
  type GitContext,
} from "./git-context.ts"
import { isSessionId } from "./fx-sessions.ts"
import { expandTilde, scanProjectRoots } from "./projects.ts"
import {
  RecoveryCard,
  type RecoveryCardActionCorrelation,
  type RecoveryCardSpec,
  parseRecoveryCard,
} from "./recovery-card.ts"
import { type RecoveryCardListRow, SessionList, stateIcon } from "./session-list.ts"
import { SessionNames } from "./session-names.ts"
import { buildTree, type SessionEntry } from "./session-tree.ts"
import { type SubagentEntry, SubagentObserver } from "./subagents.ts"
import { OscTitleParser, sanitizeTitle } from "./title-parser.ts"
import { createWorktree, planWorktree, readHeadCommit, readWorktreeContext } from "./worktree.ts"

/** The tray the embedded terminal sits beside; exported so tests can
 * address the terminal by its real screen column rather than a guess. */
export const TRAY_DEFAULT_WIDTH = 26
// The tray carries a project → branch → agent tree whose rows are names, and a
// name is the thing worth reading: half the stage is the useful ceiling, and
// the floor rises with it so a drag cannot leave a column too narrow to read a
// branch in. Both scale together — the range moved, not just its top.
const TRAY_MIN_WIDTH = 24
const TRAY_MAX_SCREEN_FRACTION = 1 / 2
const HELP_MODAL_TITLE = " keys "
const ERROR_MODAL_TITLE = " error "

const CTRL_D_KEY = parseKeyCombo("ctrl+d")!
const HELP_CLOSE_KEY = parseKeyCombo("?")!
const MODIFIER_ONLY_KEYS = new Set([
  "leftshift",
  "leftctrl",
  "leftalt",
  "leftsuper",
  "lefthyper",
  "leftmeta",
  "rightshift",
  "rightctrl",
  "rightalt",
  "rightsuper",
  "righthyper",
  "rightmeta",
  "iso_level3_shift",
  "iso_level5_shift",
])
/** A run beneath a stored mark proves the mark is wrong; one bad record does not. */
const STALE_SEQUENCE_LIMIT = 3
/** How many times, and how far apart, a lost transport is reached for before the Agent is let go of. */
const RECOVERY_ATTEMPTS = 3
const RECOVERY_INTERVAL_MS = 250
/** Restore the selected Agent alone, then bound inactive replay pressure. */
const RESTORE_CONCURRENCY = 4
export const EXIT_CONFIRMATION_TIMEOUT_MS = 2_000
const MAX_SCROLLBACK_BYTES = 10_000_000

type MultiplexerOptions = {
  fxPath: string
  cwd: string
  keybindings: Keybindings
  /** The Home's record of its Agents; every start and end is written through it. */
  manifest: AgentManifest
  /** Public name of this independent fmx; absent is the existing default. */
  fmxName?: string
  /** Where Agents are started and reached. */
  transport: AgentTransportFactory
  /** Agents the join found running: attached, in display order, before anything else. */
  survivors?: readonly ManifestEntry[]
  adeSocket?: AdeEventSource | null
  initialTrayWidth?: number
  onTrayWidthChange?: (width: number) => void
  initialTrayHidden?: boolean
  onTrayHiddenChange?: (hidden: boolean) => void
  /** Replace the Tray with the full-width top Agent picker for this Runtime. */
  agentPicker?: boolean
  /** In picker mode, return its three rows to the terminal while exactly one Agent exists. */
  hideSingleAgentPicker?: boolean
  /** Stable identity to focus before the first restored frame. */
  initialActiveAgentId?: string
  onActiveAgentChange?: (agentId: string | null) => void
  /** Where a requested new worktree is checked out. */
  worktreeRoot?: string
  home?: string
  /** Where fmx-mcp reaches this Runtime. */
  runtimeSocketPath?: string
  /** Configured discovery roots used when MCP creation has no caller or directory. */
  projectRoots?: readonly string[]
  /** Exact current fmx Session's independent launch defaults. */
  agentDefaults?: AgentDefaults
  /** The per-Fx semantic work requester; replaceable only for deterministic tests. */
  fxWorkControl?: FxWorkControlRequester
  /** Opaque human recovery actions forwarded by the Runtime-extension supervisor. */
  onRecoveryCardAction?: (correlation: RecoveryCardActionCorrelation) => void
  /** One exact durable ensure/launch correlation view per member snapshot. */
  runtimeMemberCorrelationSource?: RuntimeMemberCorrelationSource
  /**
   * Persist exact managed-lifecycle finalization before a definitive Agent
   * end is allowed to remove its Manifest claim and Work-control binding.
   * Rejecting keeps those durable identities for startup recovery.
   */
  beforeDefinitiveAgentForget?: (
    entry: ManifestEntry,
    exit: AgentExit | null,
  ) => void | Promise<void>
  /** Resolved before the first frame: FX_THEME -> OSC 11 -> COLORFGBG -> dark. */
  initialTheme?: FxnkThemeResolution
}

export type AgentCreateRequest = {
  directory: string
  worktree?: boolean
  focus?: boolean
  startLevel?: FxStartLevel | null
}

/**
 * Implementation-private projection inputs for a lifecycle-owned Agent.
 * Its stable identity and Work-control bearer authority are supplied by the
 * lifecycle composition; fmx derives the Companion and pane names from the
 * Agent id and never mints replacements during replay.
 */
export type ManagedAgentClaim = {
  agentId: string
  cwd: string
  fxPath: string
  fxArgs: string[] | null
  workControl: FxWorkControlBinding
  createdAt?: number
  focus?: boolean
}

/** Provider-independent exact Fx invocation handed to the transport seam. */
export type ManagedAgentInvocation = Pick<
  AgentStart,
  "command" | "cwd" | "env"
>

export type ManagedAgentStartResult = {
  sessionName: string
  paneId: string
}

export type RuntimeMemberAgentSnapshot = {
  agent_id: string
  pane_id: string
  display_id: number
  created_at_ms: number
  lifecycle: "creating" | "running" | "unreachable"
  state: DisplayState
  attention: AgentAttention | null
  directory: string
  worktree: boolean
  fx_conversation: { conversation_id: string; name: string | null } | null
  correlation: RuntimeMemberCorrelation | null
}

export type RuntimeMemberSnapshot = {
  revision: string
  selected_agent_id: string | null
  agents: RuntimeMemberAgentSnapshot[]
}

function runtimeMemberIdentity(entries: readonly ManifestEntry[]): string {
  return JSON.stringify(entries.map((entry) => [
    entry.agentId,
    entry.paneId,
    entry.displayId,
    entry.createdAt,
    entry.cwd,
  ]))
}

export type RuntimeExtensionSurface = {
  /** Emits semantic revisions; the framed-link supervisor coalesces them into one pending wire level. */
  subscribeInvalidation(listener: (revision: string) => void): () => void
  snapshot(): Promise<RuntimeMemberSnapshot>
  present(agentId: string, focus: boolean): void
  publishRecoveryCard(card: RecoveryCardSpec): void
  clearRecoveryCard(slotId: string, cardRevision: string): void
}

export class RuntimeExtensionSurfaceError extends Error {
  constructor(
    readonly code:
      | "busy"
      | "invalid_card"
      | "not_found"
      | "shutting_down"
      | "snapshot_unavailable"
      | "stale"
      | "starting_up",
    message: string,
  ) {
    super(message)
    this.name = "RuntimeExtensionSurfaceError"
  }
}

const DEFAULT_THEME: FxnkThemeResolution = {
  theme: "dark",
  background: null,
  source: "default",
  explicit: false,
}

type AgentStatus = "starting" | "running" | "exited"
type ModalKind = "help" | "spawn-error"

type AgentEvents = {
  onTitleChange: (agent: FxAgent) => void
  onExit: (agent: FxAgent, exit: AgentExit) => void
  /** The transport went away under a running fx; nothing is known until asked. */
  onLost: (agent: FxAgent, error: Error) => void
}

/** RIS. Everything — screen, scrollback, modes — so a restore lands on nothing. */
const TERMINAL_RESET = new Uint8Array([0x1b, 0x63])

/**
 * One Agent as fmx shows it: the visible terminal and what fx has said its
 * title is. The process and its PTY are the transport's; this owns only the
 * rendering side and the bytes between the two.
 */
class FxAgent {
  readonly terminal: FxTerminalRenderable
  /** The number fmx's UI knows it by: the Manifest's display id. */
  readonly id: number
  /** Retained stable control and Companion-label identity. */
  readonly paneId: string
  private readonly fallbackLabel: string
  label: string
  status: AgentStatus = "starting"

  private transport: AgentTransport | null = null
  private detached = false
  /** The terminal's size as last laid out, for a transport attached later. */
  private size: TerminalSize = { cols: 80, rows: 24 }
  private cursorReportAdapter = new CursorReportAdapter()
  private readonly titleParser: OscTitleParser

  constructor(
    renderer: CliRenderer,
    readonly entry: ManifestEntry,
    readonly cwd: string,
    private hostTheme: FxnkThemeResolution,
    private readonly events: AgentEvents,
  ) {
    this.id = entry.displayId
    this.paneId = entry.paneId
    const workspace = basename(cwd) || "workspace"
    this.fallbackLabel = sanitizeTitle(workspace) || "fx"
    this.label = this.fallbackLabel
    this.titleParser = new OscTitleParser({
      onTitle: (title) => {
        this.label = title || this.fallbackLabel
        this.events.onTitleChange(this)
      },
    })

    this.terminal = new FxTerminalRenderable(renderer, {
      id: `fx-${this.id}`,
      cols: 80,
      rows: 24,
      width: "100%",
      height: "100%",
      visible: false,
      maxScrollback: MAX_SCROLLBACK_BYTES,
      onData: (data, source) => this.writeInput(data, source),
      onTerminalResize: (cols, rows) => this.resizePty(cols, rows),
    })
    this.terminal.applyHostTheme(hostTheme)
  }

  /** What a transport should be opened at: the terminal's size once it has one. */
  currentSize(): TerminalSize {
    return {
      cols: Math.max(1, this.terminal.width || this.size.cols),
      rows: Math.max(1, this.terminal.height || this.size.rows),
    }
  }

  /**
   * Take a transport, first or replacement. Bound before anything else so
   * the restore it answers the attach with has somewhere to land; the
   * terminal resets at its `RestoreBegin`, so a replacement replays onto a
   * clean screen rather than over the one the lost transport left.
   */
  adopt(transport: AgentTransport): void {
    if (this.detached || this.status === "exited") {
      transport.detach()
      return
    }
    this.transport?.detach()
    this.transport = transport
    transport.bind({
      output: (bytes) => this.acceptOutput(bytes),
      restoreBegin: () => this.resetTerminal(),
      ready: () => {},
      exit: (status) => this.recordExit(status),
      lost: (error) => {
        if (this.transport !== transport) return
        this.transport = null
        this.events.onLost(this, error)
      },
    })
    // The transport was opened at the size the terminal had when it was
    // asked for; the layout pass has usually run since, and its resize
    // found no transport to tell. A size that has not changed is a no-op
    // at the PTY.
    transport.resize(this.currentSize())
    if (this.status === "starting") this.status = "running"
  }

  /** Whether a transport is carrying this agent right now. */
  get connected(): boolean {
    return this.transport !== null
  }

  updateHostTheme(resolution: FxnkThemeResolution): void {
    const changed =
      resolution.theme !== this.hostTheme.theme || resolution.background !== this.hostTheme.background
    this.hostTheme = resolution
    this.terminal.applyHostTheme(resolution)
    if (changed && !resolution.explicit) {
      this.writeInput(themeModeReport(resolution.theme), "response")
    }
  }

  /** Let go of fx without ending it, and take the terminal down. */
  destroy(): void {
    this.detach()
    this.terminal.blur()
    this.terminal.destroy()
  }

  /** Stop watching fx. It keeps running; the Companion holds it. */
  detach(): void {
    this.detached = true
    this.transport?.detach()
    this.transport = null
  }

  private acceptOutput(data: Uint8Array): void {
    this.titleParser.push(data)
    const terminalData = this.cursorReportAdapter.toTerminal(data)
    if (terminalData.byteLength > 0) this.terminal.write(terminalData)
  }

  /**
   * What the transport replays is the whole terminal, so the one here must
   * hold nothing first: not the screen, not the scrollback, not a cursor
   * query half-translated when the last transport dropped. The resolved
   * terminal-default background goes back on afterwards — the replay restores
   * what fx set, not fmx's terminal state.
   */
  private resetTerminal(): void {
    this.cursorReportAdapter = new CursorReportAdapter()
    this.terminal.write(TERMINAL_RESET)
    this.terminal.applyHostTheme(this.hostTheme)
  }

  private writeInput(data: Uint8Array, source: EmbeddedTerminalDataSource): void {
    const transport = this.transport
    if (!transport || this.status === "exited") return
    const ptyData = source === "response" ? this.cursorReportAdapter.toPty(data) : data
    transport.write(ptyData)
  }

  private resizePty(cols: number, rows: number): void {
    this.size = { cols: Math.max(1, cols), rows: Math.max(1, rows) }
    this.transport?.resize(this.size)
  }

  private recordExit(status: AgentExit): void {
    if (this.status === "exited") return
    const trailingTerminalData = this.cursorReportAdapter.flushTerminalBytes()
    if (trailingTerminalData.byteLength > 0) this.terminal.write(trailingTerminalData)
    this.status = "exited"
    this.transport?.detach()
    this.transport = null
    this.events.onExit(this, status)
  }
}

export class Multiplexer {
  private readonly stage: BoxRenderable
  private readonly body: BoxRenderable
  private readonly tray: BoxRenderable
  private readonly divider: BoxRenderable
  private readonly content: BoxRenderable
  private readonly emptyState: TextRenderable
  private recoveryCard: RecoveryCard | null = null
  private recoveryCardSpec: RecoveryCardSpec | null = null
  private recoveryCardSelected = false
  private recoveryCardReturnAgentId: string | null = null
  private readonly adeSocket: AdeEventSource | null
  private adeSubscribed = false
  private readonly registry = new AgentRegistry()
  private readonly sessionNames: SessionNames
  private readonly adeSequences = new Map<string, number>()
  /** Instances whose last accepted process generation ended orderly. */
  private readonly adeStoppedInstances = new Set<string>()
  /** Consecutive records refused as non-increasing, per Fx instance. */
  private readonly adeStaleRecords = new Map<string, number>()
  /** Managed finalization which shutdown must not strand before Manifest removal. */
  private readonly definitiveAgentFinalizations = new Set<Promise<void>>()
  /** Exact Agent identities whose terminal durable finalization still owns their claim. */
  private readonly definitiveAgentFinalizationsById = new Map<string, Promise<void>>()
  /** A projected managed claim is not startable until this exact write lands. */
  private readonly managedAgentClaimSaves = new Map<string, Promise<void>>()
  /** One exact managed start effect may be in flight for each stable Agent. */
  private readonly managedAgentStarts = new Map<
    string,
    { invocationKey: string; operation: Promise<ManagedAgentStartResult> }
  >()
  private readonly sessionList: SessionList
  private readonly agentPicker: AgentPicker
  private readonly pickerMode: boolean
  private readonly hideSingleAgentPicker: boolean
  /** Hold restored navigation mutations in the model until one final publish. */
  private navigationPublicationHeld: boolean
  private readonly subagents: SubagentObserver
  private readonly seenSeq = new Map<number, number>()
  /** Per-directory git context, read once and reused by every agent there. */
  private readonly gitContexts = new Map<string, GitContext | null>()
  /** In-flight reads stay shared too, so lifecycle notices for a fast exit
   * resolve against the same answer and keep their arrival order. */
  private readonly gitContextLoads = new Map<string, Promise<GitContext | null>>()
  private trayWidth = TRAY_DEFAULT_WIDTH
  /** Hidden by the toggle key; orthogonal to the empty state, which hides the
   * tray because there is nothing to list. */
  private trayHidden = false
  private dividerDragging = false
  private dragStartWidth = TRAY_DEFAULT_WIDTH
  private readonly modalBackdrop: BoxRenderable
  private readonly modal: BoxRenderable
  private readonly modalText: TextRenderable
  private readonly keybindings: Keybindings
  private readonly agents: FxAgent[] = []
  private activeIndex = -1
  private prefixArmed = false
  private modalKind: ModalKind | null = null
  private spawnErrorLines: string[] = []
  private spawnErrorHeading = "fx did not start"
  private theme: FxnkThemeResolution = DEFAULT_THEME
  private shuttingDown = false
  private exitConfirmationTimer: ReturnType<typeof setTimeout> | null = null
  private exitConfirmationKey: "ctrl+c" | "ctrl+d" | null = null
  private readonly swallowedReleases = new Set<string>()
  private readonly fxWorkControl: FxWorkControlRequester
  private creationTail: Promise<void> = Promise.resolve()
  private extensionRevision = 1n
  private extensionProjectionKey = ""
  private extensionProjectionReady = false
  private readonly extensionInvalidationListeners = new Set<(revision: string) => void>()
  private readonly definitivelyEndedAgentIds = new Set<string>()
  /** The small Runtime surface fmx-mcp drives. */
  readonly control: ControlSurface = {
    handle: (method, params, signal) => this.handleControl(method, params, signal),
  }
  /** Capability-limited implementation-private Runtime-extension surface. */
  readonly extension: RuntimeExtensionSurface = {
    subscribeInvalidation: (listener) => this.subscribeExtensionInvalidation(listener),
    snapshot: () => this.runtimeMemberSnapshot(),
    present: (agentId, focus) => this.presentAgent(agentId, focus),
    publishRecoveryCard: (card) => this.publishRecoveryCard(card),
    clearRecoveryCard: (slotId, cardRevision) => this.clearRecoveryCard(slotId, cardRevision),
  }
  private readonly donePromise: Promise<void>
  private resolveDone!: () => void
  private readonly keypressHandler = (key: KeyEvent) => this.onKeyPress(key)
  private readonly keyreleaseHandler = (key: KeyEvent) => this.onKeyRelease(key)
  private readonly selectionHandler = (selection: Selection) => this.onSelection(selection)
  private readonly resizeHandler = () => this.applyLayout()
  private readonly adeHandler = (record: AdeRecord) => this.acceptAdeRecord(record)

  constructor(
    private readonly renderer: CliRenderer,
    private readonly options: MultiplexerOptions,
  ) {
    this.donePromise = new Promise((resolveDone) => {
      this.resolveDone = resolveDone
    })
    this.fxWorkControl = options.fxWorkControl ?? new FxWorkControlClient()
    this.theme = options.initialTheme ?? DEFAULT_THEME
    const initialRamp = fxnkRamp(this.theme.theme)
    // The physical Client is cleared to the unused-field color before each
    // owner-sized frame. A transparent renderer would leave that clear visible
    // anywhere no child draws — around the splash text on first paint and in
    // stale tray cells after the last Agent disappears. The renderer's base is
    // the terminal-default canvas, chosen before any frame is exposed.
    this.renderer.setBackgroundColor(initialRamp.background)
    this.keybindings = options.keybindings
    this.pickerMode = options.agentPicker ?? false
    this.hideSingleAgentPicker = this.pickerMode && (options.hideSingleAgentPicker ?? false)
    this.trayWidth = options.initialTrayWidth ?? TRAY_DEFAULT_WIDTH
    this.trayHidden = options.initialTrayHidden ?? false
    this.sessionNames = new SessionNames({ home: options.home })
    this.subagents = new SubagentObserver({
      home: options.home,
      onChange: () => {
        this.refreshAgentNavigation()
      },
    })
    const [helpWidth, helpHeight] = helpModalSize(this.keybindings, this.pickerMode)

    this.stage = new BoxRenderable(renderer, {
      id: "fmx-stage",
      width: "100%",
      height: "100%",
      flexDirection: "column",
    })
    this.body = new BoxRenderable(renderer, {
      id: "fmx-body",
      width: "100%",
      height: 0,
      flexGrow: 1,
      flexShrink: 1,
      flexDirection: "row",
    })
    this.tray = new BoxRenderable(renderer, {
      id: "fmx-tray",
      width: this.trayWidth,
      height: "100%",
      flexShrink: 0,
      visible: false,
    })
    this.divider = new BoxRenderable(renderer, {
      id: "fmx-divider",
      width: 1,
      height: "100%",
      flexShrink: 0,
      border: ["left"],
      borderStyle: "single",
      borderColor: initialRamp.divider,
      visible: false,
      onMouseDown: (event) => this.beginDividerDrag(event),
      onMouseDrag: (event) => this.continueDividerDrag(event),
      onMouseUp: () => this.endDividerDrag(),
      onMouseDragEnd: () => this.endDividerDrag(),
    })
    this.content = new BoxRenderable(renderer, {
      id: "fmx-content",
      flexGrow: 1,
      flexShrink: 1,
      height: "100%",
      alignItems: "center",
      justifyContent: "center",
    })
    this.emptyState = new TextRenderable(renderer, {
      id: "fmx-empty-state",
      content: emptyStateContent(),
      fg: initialRamp.dim,
      selectable: false,
    })
    this.content.add(this.emptyState)

    this.adeSocket = options.adeSocket ?? null
    this.sessionList = new SessionList(
      renderer,
      (agentId) => this.selectAgent(agentId),
      (slotId) => this.selectRecoveryCard(slotId),
    )
    this.sessionList.applyTheme(this.theme.theme)
    this.navigationPublicationHeld = (options.survivors?.length ?? 0) > 0
    this.sessionList.root.visible = !this.navigationPublicationHeld
    this.tray.add(this.sessionList.root)

    this.agentPicker = new AgentPicker(renderer, {
      theme: this.theme.theme,
      onSelect: (agentId) => this.selectAgent(agentId),
      onSelectRecoveryCard: (slotId) => this.selectRecoveryCard(slotId),
      onOpenChange: (open) => {
        this.cancelPrefix()
        if (open) this.activeAgent()?.terminal.blur()
        else if (!this.shuttingDown) this.restoreFocus()
      },
    })
    this.agentPicker.setPublished(!this.navigationPublicationHeld)
    this.body.add(this.tray)
    this.body.add(this.divider)
    this.body.add(this.content)
    this.stage.add(this.agentPicker)
    this.stage.add(this.body)

    this.modalBackdrop = new BoxRenderable(renderer, {
      id: "fmx-modal-backdrop",
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      backgroundColor: initialRamp.backdrop,
      zIndex: 100,
      visible: false,
      onMouseDown: () => this.hideModal(),
    })
    this.modal = new BoxRenderable(renderer, {
      id: "fmx-modal",
      position: "absolute",
      left: "50%",
      top: "50%",
      width: helpWidth,
      height: helpHeight,
      marginLeft: -Math.floor(helpWidth / 2),
      marginTop: -Math.floor(helpHeight / 2),
      paddingX: 1,
      border: true,
      borderStyle: "single",
      borderColor: initialRamp.focus,
      backgroundColor: initialRamp.background,
      title: HELP_MODAL_TITLE,
      titleAlignment: "left",
      visible: false,
      onMouseDown: (event) => event.stopPropagation(),
    })
    this.modalText = new TextRenderable(renderer, {
      id: "fmx-modal-text",
      content: styledHelpContent(this.keybindings, initialRamp, this.pickerMode),
      fg: initialRamp.foreground,
      bg: initialRamp.background,
      selectable: false,
    })
    this.modal.add(this.modalText)
    this.modalBackdrop.add(this.modal)
    this.applyModalTheme()

    this.renderer.root.add(this.stage)
    this.renderer.root.add(this.modalBackdrop)
    this.renderer.keyInput.on("keypress", this.keypressHandler)
    this.renderer.keyInput.on("keyrelease", this.keyreleaseHandler)
    this.renderer.on(CliRenderEvents.SELECTION, this.selectionHandler)
    this.renderer.on(CliRenderEvents.RESIZE, this.resizeHandler)
    this.applyLayout()
    this.refreshTerminalTitle()
  }

  /**
   * Bring up what the join found running before anything new can be asked
   * for, in the order the Agents were numbered. Each attach is its own:
   * one that fails is reported and the rest still come up.
   */
  async start(): Promise<void> {
    if (this.shuttingDown) return
    this.subagents.start()
    const survivors = [...(this.options.survivors ?? [])].sort((a, b) => a.displayId - b.displayId)
    const restoring = survivors.map((entry) => this.prepareRestoredAgent(entry))
    // AdeSocket may already hold records accepted during the Companion join.
    // Subscribe only after their stable Manifest identities exist so replay
    // can fold them instead of discarding them as unknown instances.
    this.subscribeAde()
    if (restoring.length === 0) {
      this.publishExtensionSurface()
      return
    }

    const savedIndex = restoring.findIndex(
      (agent) => agent.entry.agentId === this.options.initialActiveAgentId,
    )
    this.switchTo(savedIndex === -1 ? 0 : savedIndex)

    // Reach the selected terminal first, while keeping the tray itself in
    // display-id order. It is the surface the renderer is about to expose.
    const active = this.activeAgent()!
    await this.attachRestoredAgent(active)
    if (this.shuttingDown) return
    await forEachConcurrent(
      restoring.filter((agent) => agent !== active),
      RESTORE_CONCURRENCY,
      async (agent) => {
        if (!this.shuttingDown) await this.attachRestoredAgent(agent)
      },
    )
    // Git, fx's display metadata, and subagent control records are durable
    // authorities, not copies in fmx. An older Manifest may not carry every
    // session identity, so install the final parent set after attach has had a
    // chance to supply it, then query both filesystem authorities together.
    await Promise.all([
      Promise.all(restoring.map((agent) => this.loadGitContext(agent.cwd))),
      this.syncSubagentParents(),
    ])
    if (this.shuttingDown) return
    this.navigationPublicationHeld = false
    this.sessionList.root.visible = true
    this.agentPicker.setPublished(true)
    this.refreshAgentNavigation()
    this.publishExtensionSurface()
  }

  setTheme(resolution: FxnkThemeResolution): void {
    if (this.shuttingDown) return
    this.theme = resolution
    const ramp = fxnkRamp(resolution.theme)
    this.renderer.setBackgroundColor(ramp.background)
    this.agentPicker.applyTheme(resolution.theme)
    this.recoveryCard?.applyTheme(resolution.theme)
    this.applyModalTheme()
    this.applyDividerTheme()
    this.refreshEmptyState()
    for (const agent of this.agents) agent.updateHostTheme(resolution)
    this.renderer.requestRender()
  }

  waitUntilDone(): Promise<void> {
    return this.donePromise
  }

  async shutdown(exitCode = 0): Promise<void> {
    if (this.shuttingDown) return this.donePromise
    this.shuttingDown = true
    this.extensionInvalidationListeners.clear()
    this.cancelPrefix()
    if (this.exitConfirmationTimer !== null) clearTimeout(this.exitConfirmationTimer)
    this.exitConfirmationTimer = null
    this.exitConfirmationKey = null
    this.agentPicker.close()
    this.hideModal()
    this.subagents.stop()

    try {
      // Let go, never end: fx and its terminal are the Companion's, and the
      // next fmx for this Home finds them where this one left them.
      for (const agent of this.agents) agent.detach()
      this.renderer.keyInput.off("keypress", this.keypressHandler)
      this.renderer.keyInput.off("keyrelease", this.keyreleaseHandler)
      this.renderer.off(CliRenderEvents.SELECTION, this.selectionHandler)
      this.renderer.off(CliRenderEvents.RESIZE, this.resizeHandler)
      this.renderer.clearSelection()
      for (const agent of this.agents) agent.destroy()
      await Promise.all([...this.definitiveAgentFinalizations])
    } finally {
      this.agents.length = 0
      this.renderer.destroy()
      process.exitCode = exitCode
      this.resolveDone()
    }
  }

  /** Create one Agent through the Manifest and Companion lifecycle. */
  async createAgent(request: AgentCreateRequest): Promise<AgentInfo> {
    const origin = await readGitContext(request.directory)
    if (!origin) throw new NotARepositoryError(request.directory)
    this.gitContexts.set(request.directory, origin)
    let directory = request.directory
    if (request.worktree) {
      try {
        directory = await this.cutWorktree(request.directory)
      } catch (error) {
        throw new WorktreeError(errorMessage(error))
      }
      const cut = await readGitContext(directory)
      if (cut) this.gitContexts.set(directory, cut)
    }
    if (this.shuttingDown) throw new ControlFailure("shutting_down", "fmx is shutting down")
    const agent = await this.createFxAgent(
      directory,
      request.focus ?? false,
      request.startLevel ?? null,
    )
    if (!agent) throw new ControlFailure("shutting_down", "fmx is shutting down")
    return this.agentInfo(agent)
  }

  /**
   * Durably claim and project one lifecycle-owned Agent. Replaying the exact
   * claim retries a failed Manifest write and returns the same display row;
   * a different claim for that stable identity fails closed.
   */
  async projectManagedAgent(claim: ManagedAgentClaim): Promise<ManifestEntry> {
    if (this.shuttingDown) {
      throw new ControlFailure("shutting_down", "fmx is shutting down")
    }
    assertManagedClaim(claim)
    this.assertManagedAgentNotFinalizing(claim.agentId)
    if (this.options.runtimeSocketPath) {
      const expected = mintFxWorkControlBinding(
        this.options.runtimeSocketPath,
        claim.agentId,
        claim.workControl.token,
      )
      if (claim.workControl.socketPath !== expected.socketPath) {
        throw new Error(`managed Agent ${claim.agentId} has a foreign Work-control path`)
      }
    }
    const identity = identityFor(claim.agentId)
    const existing = this.options.manifest.get(claim.agentId)
    const { result: entry, saved } = this.options.manifest.ensureClaim({
      identity,
      cwd: claim.cwd,
      fxPath: claim.fxPath,
      fxArgs: claim.fxArgs,
      createdAt: existing?.createdAt ?? claim.createdAt ?? Date.now(),
      workControl: claim.workControl,
    })
    this.managedAgentClaimSaves.set(entry.agentId, saved)
    const clearSaved = () => {
      if (this.managedAgentClaimSaves.get(entry.agentId) === saved) {
        this.managedAgentClaimSaves.delete(entry.agentId)
      }
    }
    // A failed write remains the start barrier until an exact projection
    // replay replaces it with a new save. Dropping a rejected barrier would
    // expose the in-memory-only claim again.
    void saved.then(clearSaved, () => {})
    if (!this.agents.some((candidate) => candidate.entry.agentId === entry.agentId)) {
      this.addAgent(entry, entry.cwd, claim.focus ?? false)
    }
    await saved
    this.assertManagedAgentNotFinalizing(entry.agentId)
    return this.options.manifest.get(entry.agentId) ?? entry
  }

  /**
   * Idempotently start or recover the exact preclaimed Companion session.
   * The transport is not adopted until the existing Manifest entry is
   * durably `running`; a failed write leaves the process available for the
   * next exact replay without starting a second one.
   */
  async startManagedAgent(
    agentId: string,
    invocation: ManagedAgentInvocation,
  ): Promise<ManagedAgentStartResult> {
    if (this.shuttingDown) {
      throw new ControlFailure("shutting_down", "fmx is shutting down")
    }
    this.assertManagedAgentNotFinalizing(agentId)
    await this.managedAgentClaimSaves.get(agentId)
    this.assertManagedAgentNotFinalizing(agentId)
    const entry = this.options.manifest.get(agentId)
    if (!entry) throw new Error(`managed Agent is not claimed: ${agentId}`)
    assertManagedInvocation(entry, invocation)
    const agent = this.agents.find((candidate) => candidate.entry.agentId === agentId)
    if (!agent) throw new Error(`managed Agent is not projected: ${agentId}`)
    if (agent.connected) {
      return { sessionName: entry.zmxName, paneId: entry.paneId }
    }

    const invocationKey = managedInvocationKey(invocation)
    const active = this.managedAgentStarts.get(agentId)
    if (active) {
      if (active.invocationKey !== invocationKey) {
        throw new Error(`conflicting managed Fx invocation for agent: ${agentId}`)
      }
      return active.operation
    }

    const operation = this.runManagedAgentStart(agent, invocation)
    this.managedAgentStarts.set(agentId, { invocationKey, operation })
    const clear = () => {
      if (this.managedAgentStarts.get(agentId)?.operation === operation) {
        this.managedAgentStarts.delete(agentId)
      }
    }
    void operation.then(clear, clear)
    return operation
  }

  /**
   * Remove only an inert managed projection after the lifecycle Runtime has
   * proven a never-started cancellation. This is not a process-stop surface.
   */
  async removeManagedAgentProjection(agentId: string): Promise<void> {
    const agent = this.agents.find((candidate) => candidate.entry.agentId === agentId)
    if (!agent) return
    if (agent.connected || this.managedAgentStarts.has(agentId)) {
      throw new Error(`managed Agent ${agentId} is not an inert projection`)
    }
    this.removeAgent(agent)
  }

  /** Refresh extension membership only after the Runtime removed its claim. */
  refreshManagedAgentProjection(agentId: string): void {
    if (this.options.manifest.get(agentId) !== null) {
      throw new Error(`managed Agent ${agentId} is still claimed during projection refresh`)
    }
    this.refreshExtensionRevision()
  }

  private async runManagedAgentStart(
    agent: FxAgent,
    invocation: ManagedAgentInvocation,
  ): Promise<ManagedAgentStartResult> {
    const entry = this.options.manifest.get(agent.entry.agentId)
    if (!entry) throw new Error(`managed Agent is not claimed: ${agent.entry.agentId}`)
    const size = agent.currentSize()
    let transport: AgentTransport | null = null
    try {
      transport = entry.phase === "running"
        ? await this.options.transport.attach(entry, size, { foreignAsConflict: true })
        : await this.options.transport.start({
          entry,
          command: [...invocation.command],
          cwd: invocation.cwd,
          env: { ...invocation.env },
          size,
          recoverExisting: true,
        })
      // Queue this write even when an earlier failed write already changed
      // the in-memory phase. Replay must repair the durable snapshot before
      // any risky fmx adoption or renderer operation.
      const running = await this.options.manifest.markRunning(entry.agentId)
      if (this.shuttingDown || !this.agents.includes(agent)) {
        throw new ControlFailure("shutting_down", "fmx is shutting down")
      }
      agent.adopt(transport)
      this.refreshAgentNavigation()
      return { sessionName: running.zmxName, paneId: running.paneId }
    } catch (error) {
      transport?.detach()
      if (error instanceof AgentStartConflictError) {
        // A foreign process may have taken both the Companion name and the
        // filesystem endpoint. Remove only fmx's stale claim; neither that
        // session nor the persisted Work-control path is ours to touch.
        await this.options.manifest.remove(entry.agentId)
        if (!this.shuttingDown) this.removeAgent(agent)
        this.refreshExtensionRevision()
      } else if (error instanceof AgentEndedError) {
        // This is the same definitive proof used by restored attach and live
        // Exit. Managed finalization owns receipt retention and safe residue
        // cleanup before the Manifest identity is forgotten.
        this.markAgentDefinitivelyEnded(entry.agentId)
        if (!this.shuttingDown) this.removeAgent(agent)
        await this.trackDefinitiveAgentFinalization(entry, error.exit)
      }
      throw error
    }
  }

  /**
   * Start an fx. `focus` false leaves the screen where it is unless nothing is
   * on it yet. The Manifest is written first and the Companion asked second,
   * so a crash in between leaves a claim the next start can reconcile.
   */
  private async createFxAgent(
    cwd: string,
    focus = true,
    startLevel: FxStartLevel | null = null,
  ): Promise<FxAgent | null> {
    if (this.shuttingDown) return null
    this.cancelExitConfirmation()
    const identity = mintIdentity()
    const workControl = this.options.runtimeSocketPath
      ? mintFxWorkControlBinding(this.options.runtimeSocketPath, identity.agentId)
      : null
    const resolvedStartLevel = resolveStartLevel(startLevel, this.options.agentDefaults)
    const fxArgs = this.options.agentDefaults?.stateDir === undefined
      ? []
      : ["--state-dir", this.options.agentDefaults.stateDir]
    const { result: entry, saved } = this.options.manifest.claim({
      cwd,
      fxPath: this.options.fxPath,
      fxArgs,
      createdAt: Date.now(),
      identity,
      workControl,
    })
    const agent = this.addAgent(entry, cwd, focus)
    let transport: AgentTransport
    try {
      await saved
      if (this.shuttingDown) throw new ControlFailure("shutting_down", "fmx is shutting down")
      transport = await this.options.transport.start({
        entry,
        // The claim's, not the option's: what the Manifest says was started is what is started.
        command: [entry.fxPath, ...(entry.fxArgs ?? [])],
        cwd,
        env: stringEnvironment(
          createFxEnvironment(
            process.env,
            entry.displayId,
            cwd,
            this.options.runtimeSocketPath ?? null,
            resolvedStartLevel,
            this.adeBinding(entry.agentId),
            entry.workControl,
          ),
        ),
        size: agent.currentSize(),
      })
    } catch (error) {
      if (error instanceof AgentUnreachableError) {
        // fx is running; only the way to it failed. It is recovered like a
        // lost transport, never removed — the Manifest says so first.
        await this.options.manifest.markRunning(entry.agentId).catch(() => {})
        this.refreshExtensionRevision()
        void this.recoverAgent(agent, error)
        return agent
      }
      this.markAgentDefinitivelyEnded(entry.agentId)
      this.removeAgent(agent)
      // A write that fails here is the same disk that failed above; the
      // reason the start failed is the one to show.
      await this.forgetAgent(entry).catch(() => {})
      throw error
    }
    // fx is running whatever happens from here; the record says so before
    // anything else, because this is the acknowledgement a crash loses. A
    // write that fails leaves `creating` on disk, which the join resolves.
    await this.options.manifest.markRunning(entry.agentId).catch(() => {})
    if (this.shuttingDown || !this.agents.includes(agent)) {
      transport.detach()
      return null
    }
    agent.adopt(transport)
    this.refreshAgentNavigation()
    return agent
  }

  /**
   * Attach to an Agent the Companion held between runs. The last ADE
   * truth is seeded before the renderer can expose this row; it stays true
   * until fx reports something newer.
   */
  private prepareRestoredAgent(entry: ManifestEntry): FxAgent {
    const agent = this.addAgent(entry, entry.cwd, false, false)
    const checkpoint = entry.agentStatus
    const record = this.registry.seed(agent.paneId, {
      sessionId: entry.fxSessionId,
      state: checkpoint?.state ?? "unknown",
      attention: checkpoint?.attention ?? null,
    })
    this.seenSeq.set(
      agent.id,
      checkpoint?.seen === false ? Math.max(0, record.stateSeq - 1) : record.stateSeq,
    )
    if (entry.fxSessionId) this.sessionNames.recover(entry.fxSessionId)
    this.refreshAgentNavigation()
    return agent
  }

  private async attachRestoredAgent(agent: FxAgent): Promise<void> {
    const entry = agent.entry
    try {
      const transport = await this.options.transport.attach(entry, agent.currentSize())
      if (this.shuttingDown || !this.agents.includes(agent)) {
        transport.detach()
        return
      }
      agent.adopt(transport)
      this.refreshAgentNavigation()
    } catch (error) {
      if (error instanceof AgentEndedError) this.markAgentDefinitivelyEnded(entry.agentId)
      this.removeAgent(agent)
      if (error instanceof AgentEndedError) {
        await this.trackDefinitiveAgentFinalization(entry, error.exit)
        return
      }
      // Unreachable is not ended: the claim stays for the next start.
      this.showError(`agent ${entry.displayId} could not be restored`, error)
    }
  }

  /** Put an Agent on screen under its Manifest identity; nothing is attached yet. */
  private addAgent(
    entry: ManifestEntry,
    cwd: string,
    focus: boolean,
    selectIfEmpty = true,
  ): FxAgent {
    const agent = new FxAgent(this.renderer, entry, cwd, this.theme, {
      onTitleChange: (candidate) => {
        if (this.activeAgent() === candidate) this.refreshTerminalTitle()
      },
      onExit: (candidate, exit) => this.handleAgentExit(candidate, exit),
      onLost: (candidate, error) => {
        this.refreshExtensionRevision()
        void this.recoverAgent(candidate, error)
      },
    })
    this.agents.push(agent)
    this.content.add(agent.terminal)
    this.refreshAgentChrome()
    if (focus || (selectIfEmpty && this.activeIndex === -1 && !this.recoveryCardSelected)) {
      this.switchTo(this.agents.length - 1)
    }
    this.loadGitContext(cwd)
    this.refreshAgentNavigation()
    return agent
  }

  /**
   * Fx ended: remove it from the live projection immediately, then forget
   * its durable identities only after managed finalization succeeds.
   */
  private handleAgentExit(agent: FxAgent, exit: AgentExit | null): void {
    // The claim goes even mid-shutdown: the record is being consumed
    // regardless, and an entry without one is an exit the next start
    // cannot explain.
    this.markAgentDefinitivelyEnded(agent.entry.agentId)
    if (!this.shuttingDown) this.removeAgent(agent)
    this.queueDefinitiveAgentFinalization(agent.entry, exit)
  }

  private queueDefinitiveAgentFinalization(
    entry: ManifestEntry,
    exit: AgentExit | null,
  ): void {
    void this.trackDefinitiveAgentFinalization(entry, exit)
  }

  private trackDefinitiveAgentFinalization(
    entry: ManifestEntry,
    exit: AgentExit | null,
  ): Promise<void> {
    this.markAgentDefinitivelyEnded(entry.agentId)
    const active = this.definitiveAgentFinalizationsById.get(entry.agentId)
    if (active) return active
    // Install the identity gate before invoking an external finalizer: it may
    // synchronously re-enter the managed projection surface before its first
    // await otherwise.
    const operation = Promise.resolve().then(() => this.finalizeDefinitiveAgentExit(entry, exit))
    this.definitiveAgentFinalizationsById.set(entry.agentId, operation)
    this.definitiveAgentFinalizations.add(operation)
    const clear = () => {
      this.definitiveAgentFinalizations.delete(operation)
      if (this.definitiveAgentFinalizationsById.get(entry.agentId) === operation) {
        this.definitiveAgentFinalizationsById.delete(entry.agentId)
      }
    }
    void operation.then(clear, clear)
    return operation
  }

  private assertManagedAgentNotFinalizing(agentId: string): void {
    if (
      this.definitiveAgentFinalizationsById.has(agentId) ||
      this.definitivelyEndedAgentIds.has(agentId)
    ) {
      throw new Error(`managed Agent is being definitively finalized: ${agentId}`)
    }
  }

  private async finalizeDefinitiveAgentExit(
    entry: ManifestEntry,
    exit: AgentExit | null,
  ): Promise<void> {
    try {
      const durableEntry = this.options.manifest.get(entry.agentId) ?? entry
      await this.options.beforeDefinitiveAgentForget?.(
        structuredClone(durableEntry),
        exit === null ? null : { ...exit },
      )
      await this.forgetAgent(durableEntry)
    } catch (error) {
      // The Agent is definitively gone from the live projection, but its
      // durable identity must survive when managed finalization did not.
      // Startup reconciliation replays the same hook before removal.
      if (!this.shuttingDown) this.showError(`could not finalize agent ${entry.displayId}`, error)
    }
  }

  /**
   * The transport dropped under a running fx. Reach for it again: a live
   * session is re-attached and replays onto a reset terminal; one that
   * ended is removed exactly as an Exit would have; one that cannot be
   * reached after a few tries is let go of on screen but kept in the
   * Manifest, where the next start's join will find it.
   */
  private async recoverAgent(agent: FxAgent, lost: Error): Promise<void> {
    let error: unknown = lost
    for (let attempt = 0; attempt < RECOVERY_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RECOVERY_INTERVAL_MS))
      if (this.shuttingDown || !this.agents.includes(agent)) return
      try {
        const transport = await this.options.transport.attach(agent.entry, agent.currentSize())
        if (this.shuttingDown || !this.agents.includes(agent)) {
          transport.detach()
          return
        }
        agent.adopt(transport)
        this.refreshAgentNavigation()
        return
      } catch (caught) {
        if (caught instanceof AgentEndedError) {
          this.handleAgentExit(agent, caught.exit)
          return
        }
        error = caught
      }
    }
    if (this.shuttingDown || !this.removeAgent(agent)) return
    this.showError(`lost agent ${agent.id}`, error)
  }

  private removeAgent(agent: FxAgent): boolean {
    const index = this.agents.indexOf(agent)
    if (index === -1) return false
    const wasActive = this.activeAgent() === agent
    this.content.remove(agent.terminal)
    agent.destroy()
    this.agents.splice(index, 1)
    this.registry.forget(agent.paneId)
    this.adeSequences.delete(agent.entry.agentId)
    this.adeStoppedInstances.delete(agent.entry.agentId)
    this.adeStaleRecords.delete(agent.entry.agentId)
    this.seenSeq.delete(agent.id)
    this.refreshAgentChrome()
    if (this.agents.length === 0) {
      if (this.recoveryCard) this.selectRecoveryCard(this.recoveryCardSpec!.slot_id)
      else {
        this.activeIndex = -1
        this.options.onActiveAgentChange?.(null)
        this.refreshTerminalTitle()
        this.refreshAgentNavigation()
      }
    } else if (wasActive) {
      this.activeIndex = -1
      this.switchTo(Math.min(index, this.agents.length - 1))
    } else if (index < this.activeIndex) {
      this.activeIndex -= 1
      this.refreshAgentNavigation()
    }
    return true
  }

  private async forgetAgent(entry: ManifestEntry): Promise<void> {
    await removeFxWorkControlResidue(entry.workControl, this.options.runtimeSocketPath ?? null)
    await this.options.manifest.remove(entry.agentId)
    this.definitivelyEndedAgentIds.delete(entry.agentId)
    this.refreshExtensionRevision()
  }

  private switchTo(index: number, focus = true): void {
    this.renderer.clearSelection()
    if (this.agents.length === 0) {
      this.activeIndex = -1
      this.options.onActiveAgentChange?.(null)
      this.refreshTerminalTitle()
      return
    }
    if (this.recoveryCardSelected) {
      this.recoveryCardSelected = false
      this.recoveryCard?.setSelected(false)
      if (this.recoveryCard) this.recoveryCard.visible = false
    }
    const normalized = ((index % this.agents.length) + this.agents.length) % this.agents.length
    const previous = this.activeAgent()
    if (previous) {
      previous.terminal.setHostSelectionEnabled(false)
      previous.terminal.blur()
      previous.terminal.visible = false
    }

    this.activeIndex = normalized
    const active = this.agents[normalized]!
    this.options.onActiveAgentChange?.(active.entry.agentId)
    active.terminal.visible = true
    active.terminal.setHostSelectionEnabled(true)
    // A surface drawn over fx keeps the keys; it hands them back when it
    // closes, so an agent shown behind it must not take them now.
    if (focus && !this.modalKind && !this.agentPicker.open) this.restoreFocus()
    this.markSeen(active)
    this.refreshTerminalTitle()
    this.refreshAgentNavigation()
  }

  private activeAgent(): FxAgent | null {
    return this.agents[this.activeIndex] ?? null
  }

  private cycleSelectableSurface(delta: -1 | 1): void {
    const hasCard = this.recoveryCard !== null
    const count = this.agents.length + (hasCard ? 1 : 0)
    if (count === 0) return
    const current = this.recoveryCardSelected ? this.agents.length : this.activeIndex
    const next = ((current + delta) % count + count) % count
    if (hasCard && next === this.agents.length) {
      this.selectRecoveryCard(this.recoveryCardSpec!.slot_id)
      return
    }
    this.switchTo(next)
  }

  private refreshAgentNavigation(): void {
    this.refreshExtensionRevision()
    if (this.navigationPublicationHeld) return
    void this.syncSubagentParents()
    const entries = this.sessionEntries()
    const rows: Array<ReturnType<typeof buildTree>[number] | RecoveryCardListRow> = buildTree(entries)
    if (this.recoveryCardSpec) rows.unshift(this.recoveryCardListRow(this.recoveryCardSpec))
    this.sessionList.render(rows, this.trayWidth)
    const pickerEntries: AgentPickerNavigationEntry[] = [...entries]
    if (this.recoveryCardSpec) {
      pickerEntries.push({
        kind: "recovery-card",
        slotId: this.recoveryCardSpec.slot_id,
        title: this.recoveryCardSpec.title,
        active: this.recoveryCardSelected,
      })
    }
    this.agentPicker.setEntries(pickerEntries)
  }

  private recoveryCardListRow(card: RecoveryCardSpec): RecoveryCardListRow {
    return {
      kind: "recovery-card",
      depth: 0,
      label: card.title,
      slotId: card.slot_id,
      agentId: null,
      state: "unknown",
      attention: null,
      active: this.recoveryCardSelected,
      onPath: this.recoveryCardSelected,
    }
  }

  private subscribeExtensionInvalidation(listener: (revision: string) => void): () => void {
    if (this.shuttingDown) {
      throw new RuntimeExtensionSurfaceError("shutting_down", "fmx is shutting down")
    }
    this.assertExtensionReady()
    this.extensionInvalidationListeners.add(listener)
    try {
      listener(this.extensionRevision.toString())
    } catch (error) {
      this.extensionInvalidationListeners.delete(listener)
      throw error
    }
    return () => this.extensionInvalidationListeners.delete(listener)
  }

  private publishExtensionSurface(): void {
    if (this.extensionProjectionReady || this.shuttingDown) return
    this.extensionProjectionKey = this.runtimeMemberProjectionKey()
    this.extensionProjectionReady = true
  }

  private assertExtensionReady(): void {
    if (!this.extensionProjectionReady) {
      throw new RuntimeExtensionSurfaceError("starting_up", "fmx startup is not complete")
    }
  }

  private markAgentDefinitivelyEnded(agentId: string): void {
    if (this.definitivelyEndedAgentIds.has(agentId)) return
    this.definitivelyEndedAgentIds.add(agentId)
    this.refreshExtensionRevision()
  }

  private refreshExtensionRevision(): void {
    if (!this.extensionProjectionReady || this.shuttingDown) return
    const projection = this.runtimeMemberProjectionKey()
    if (projection === this.extensionProjectionKey) return
    this.extensionProjectionKey = projection
    this.extensionRevision += 1n
    const revision = this.extensionRevision.toString()
    for (const listener of this.extensionInvalidationListeners) {
      try {
        listener(revision)
      } catch {
        // One extension callback cannot interrupt Agent/UI state mutation.
      }
    }
  }

  /** A cheap semantic projection makes broad UI refresh calls harmless. */
  private runtimeMemberProjectionKey(): string {
    const activeAgentId = this.activeAgent()?.entry.agentId ?? null
    const liveById = new Map(this.agents.map((agent) => [agent.entry.agentId, agent]))
    return JSON.stringify({
      selected_agent_id: activeAgentId,
      agents: this.runtimeManifestEntries().map((entry) => {
        const live = liveById.get(entry.agentId) ?? null
        const record = live ? this.registry.get(live.paneId) : null
        const sessionId = live ? this.sessionIdOf(live) : entry.fxSessionId
        const git = this.gitContexts.get(entry.cwd) ?? null
        return {
          agent_id: entry.agentId,
          display_id: entry.displayId,
          created_at_ms: entry.createdAt,
          directory: entry.cwd,
          lifecycle: this.runtimeLifecycle(entry, live),
          state: live
            ? displayStateFor(record, this.seenSeq.get(live.id) ?? 0)
            : displayStateForCheckpoint(entry),
          attention: live ? record?.attention ?? null : entry.agentStatus?.attention ?? null,
          conversation_id: sessionId,
          conversation_name: sessionId ? this.sessionNames.nameFor(sessionId) : null,
          git: git ? [git.root, git.mainRoot] : null,
        }
      }),
    })
  }

  private runtimeManifestEntries(): ManifestEntry[] {
    return this.options.manifest.entries
      .filter((entry) => !this.definitivelyEndedAgentIds.has(entry.agentId))
      .sort((left, right) => left.displayId - right.displayId)
  }

  private runtimeLifecycle(
    entry: ManifestEntry,
    live: FxAgent | null,
  ): RuntimeMemberAgentSnapshot["lifecycle"] {
    if (!live) return "unreachable"
    if (live.connected) return "running"
    return entry.phase === "creating" ? "creating" : "unreachable"
  }

  private async runtimeMemberSnapshot(): Promise<RuntimeMemberSnapshot> {
    if (this.shuttingDown) {
      throw new RuntimeExtensionSurfaceError("shutting_down", "fmx is shutting down")
    }
    this.assertExtensionReady()

    // New Agents can arrive while a required Git query is in flight. Repeat
    // until every member in one synchronous capture has exact Worktree facts.
    let entries: ManifestEntry[] = []
    for (let attempt = 0; attempt < 4; attempt += 1) {
      entries = this.runtimeManifestEntries()
      const missing = [...new Set(
        entries.filter((entry) => !this.gitContexts.has(entry.cwd)).map((entry) => entry.cwd),
      )]
      if (missing.length === 0) break
      const contexts = await Promise.all(missing.map((cwd) => this.loadGitContext(cwd)))
      const failed = contexts.findIndex((context) => context === null)
      if (failed !== -1) {
        throw new RuntimeExtensionSurfaceError(
          "snapshot_unavailable",
          `Git context is unavailable for ${missing[failed]}`,
        )
      }
      if (attempt === 3) {
        throw new RuntimeExtensionSurfaceError(
          "snapshot_unavailable",
          "Agent membership kept changing while the snapshot was prepared",
        )
      }
    }

    entries = this.runtimeManifestEntries()
    if (entries.some((entry) => !this.gitContexts.has(entry.cwd))) {
      throw new RuntimeExtensionSurfaceError(
        "snapshot_unavailable",
        "an Agent has no exact Git context",
      )
    }

    let correlations: ReadonlyMap<string, RuntimeMemberCorrelation> = new Map()
    const correlationSource = this.options.runtimeMemberCorrelationSource
    if (correlationSource) {
      const membership = runtimeMemberIdentity(entries)
      try {
        correlations = indexRuntimeMemberCorrelations(await correlationSource.snapshot())
      } catch (error) {
        const unavailable = new RuntimeExtensionSurfaceError(
          "snapshot_unavailable",
          "Runtime member correlation is unavailable",
        )
        unavailable.cause = error
        throw unavailable
      }
      const currentEntries = this.runtimeManifestEntries()
      if (runtimeMemberIdentity(currentEntries) !== membership) {
        throw new RuntimeExtensionSurfaceError(
          "snapshot_unavailable",
          "Agent membership changed while Runtime member correlation was read",
        )
      }
      entries = currentEntries
    }
    for (const entry of entries) {
      // A live metadata event can precede Fx's atomic display-file write.
      // Snapshot reads may fill an absent name, but are not a recovery event
      // that can erase already-accepted ADE authority during that window.
      if (
        entry.fxSessionId &&
        this.sessionNames.nameFor(entry.fxSessionId) === null
      ) {
        this.sessionNames.recover(entry.fxSessionId)
      }
    }
    this.refreshExtensionRevision()
    const liveById = new Map(this.agents.map((agent) => [agent.entry.agentId, agent]))
    const snapshot: RuntimeMemberSnapshot = {
      revision: this.extensionRevision.toString(),
      selected_agent_id: this.activeAgent()?.entry.agentId ?? null,
      agents: entries.map((entry) => this.runtimeMemberAgentSnapshot(
        entry,
        liveById.get(entry.agentId) ?? null,
        correlations.get(entry.agentId) ?? null,
      )),
    }
    this.validateRuntimeMemberSnapshot(snapshot)
    return snapshot
  }

  private validateRuntimeMemberSnapshot(snapshot: RuntimeMemberSnapshot): void {
    const result = runtimeExtensionMessageSchema.safeParse({
      schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
      schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
      message_type: "snapshot_result",
      request_id: "fmx-snapshot-validation",
      fmx_session: this.options.fmxName ?? "default",
      ...snapshot,
    })
    if (result.success) return
    const issue = result.error.issues[0]
    const at = issue?.path.length ? ` at ${issue.path.join(".")}` : ""
    throw new RuntimeExtensionSurfaceError(
      "snapshot_unavailable",
      `Runtime member snapshot violates the v1 contract: ${issue?.message ?? "invalid snapshot"}${at}`,
    )
  }

  private runtimeMemberAgentSnapshot(
    entry: ManifestEntry,
    live: FxAgent | null,
    correlation: RuntimeMemberCorrelation | null,
  ): RuntimeMemberAgentSnapshot {
    const git = this.gitContexts.get(entry.cwd)
    if (!git) {
      throw new RuntimeExtensionSurfaceError(
        "snapshot_unavailable",
        `Git context is unavailable for Agent ${entry.displayId}`,
      )
    }
    const record = live ? this.registry.get(live.paneId) : null
    const state = live
      ? displayStateFor(record, this.seenSeq.get(live.id) ?? 0)
      : displayStateForCheckpoint(entry)
    const attention = live ? record?.attention ?? null : entry.agentStatus?.attention ?? null
    if ((state === "blocked") !== (attention !== null)) {
      throw new RuntimeExtensionSurfaceError(
        "snapshot_unavailable",
        `Agent ${entry.displayId} has inconsistent attention state`,
      )
    }
    if (!Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0) {
      throw new RuntimeExtensionSurfaceError(
        "snapshot_unavailable",
        `Agent ${entry.displayId} has an invalid creation time`,
      )
    }
    if (!isAbsolute(entry.cwd) || normalize(entry.cwd) !== entry.cwd || entry.cwd === "/") {
      throw new RuntimeExtensionSurfaceError(
        "snapshot_unavailable",
        `Agent ${entry.displayId} has an invalid directory`,
      )
    }
    const sessionId = live ? this.sessionIdOf(live) : entry.fxSessionId
    if (sessionId !== null && !isSessionId(sessionId)) {
      throw new RuntimeExtensionSurfaceError(
        "snapshot_unavailable",
        `Agent ${entry.displayId} has an invalid Fx Conversation identity`,
      )
    }
    return {
      agent_id: entry.agentId,
      pane_id: entry.paneId,
      display_id: entry.displayId,
      created_at_ms: entry.createdAt,
      lifecycle: this.runtimeLifecycle(entry, live),
      state,
      attention,
      directory: entry.cwd,
      worktree: git.root !== git.mainRoot,
      fx_conversation: sessionId === null
        ? null
        : { conversation_id: sessionId, name: this.sessionNames.nameFor(sessionId) },
      correlation,
    }
  }

  private presentAgent(agentId: string, focus: boolean): void {
    if (this.shuttingDown) {
      throw new RuntimeExtensionSurfaceError("shutting_down", "fmx is shutting down")
    }
    this.assertExtensionReady()
    const agent = this.agents.find((candidate) => candidate.entry.agentId === agentId)
    if (!agent) {
      throw new RuntimeExtensionSurfaceError("not_found", `no switchable Agent ${agentId}`)
    }
    if (focus && (this.modalKind || this.agentPicker.open)) {
      throw new RuntimeExtensionSurfaceError("busy", "something is already open")
    }
    this.selectAgent(agent.id, focus)
  }

  private publishRecoveryCard(value: RecoveryCardSpec): void {
    if (this.shuttingDown) {
      throw new RuntimeExtensionSurfaceError("shutting_down", "fmx is shutting down")
    }
    this.assertExtensionReady()
    let card: RecoveryCardSpec
    try {
      card = parseRecoveryCard(value)
    } catch (error) {
      throw new RuntimeExtensionSurfaceError("invalid_card", errorMessage(error))
    }

    if (this.recoveryCard) {
      this.recoveryCard.setCard(card)
    } else {
      this.recoveryCard = new RecoveryCard(this.renderer, {
        card,
        selected: false,
        theme: this.theme.theme,
        visible: false,
        onAction: (correlation) => this.options.onRecoveryCardAction?.(correlation),
      })
      this.content.add(this.recoveryCard)
    }
    this.recoveryCardSpec = card
    if (this.agents.length === 0 || (this.activeIndex === -1 && !this.recoveryCardSelected)) {
      this.selectRecoveryCard(card.slot_id)
      return
    }
    this.refreshAgentChrome()
  }

  private clearRecoveryCard(slotId: string, cardRevision: string): void {
    if (this.shuttingDown) {
      throw new RuntimeExtensionSurfaceError("shutting_down", "fmx is shutting down")
    }
    this.assertExtensionReady()
    const spec = this.recoveryCardSpec
    if (!this.recoveryCard || !spec || spec.slot_id !== slotId) {
      throw new RuntimeExtensionSurfaceError("not_found", `no recovery card for unavailable slot ${slotId}`)
    }
    if (spec.card_revision !== cardRevision) {
      throw new RuntimeExtensionSurfaceError(
        "stale",
        `recovery card ${slotId} is at revision ${spec.card_revision}, not ${cardRevision}`,
      )
    }

    const selected = this.recoveryCardSelected
    const returnAgentId = this.recoveryCardReturnAgentId
    const card = this.recoveryCard
    this.content.remove(card)
    card.destroyRecursively()
    this.recoveryCard = null
    this.recoveryCardSpec = null
    this.recoveryCardSelected = false
    this.recoveryCardReturnAgentId = null

    if (selected && this.agents.length > 0) {
      const retained = returnAgentId === null
        ? -1
        : this.agents.findIndex((agent) => agent.entry.agentId === returnAgentId)
      this.switchTo(retained >= 0 ? retained : this.agents.length - 1)
      this.refreshAgentChrome()
      return
    }
    if (selected) {
      this.activeIndex = -1
      this.options.onActiveAgentChange?.(null)
      this.refreshTerminalTitle()
    }
    this.refreshAgentChrome()
  }

  private selectRecoveryCard(slotId: string): void {
    const card = this.recoveryCard
    const spec = this.recoveryCardSpec
    if (!card || !spec || spec.slot_id !== slotId) return
    this.cancelExitConfirmation()
    if (this.recoveryCardSelected) {
      card.setSelected(true)
      card.visible = true
      return
    }

    const previous = this.activeAgent()
    if (previous) {
      this.recoveryCardReturnAgentId = previous.entry.agentId
      previous.terminal.setHostSelectionEnabled(false)
      previous.terminal.blur()
      previous.terminal.visible = false
    }
    this.activeIndex = -1
    this.recoveryCardSelected = true
    card.setSelected(true)
    card.visible = true
    this.options.onActiveAgentChange?.(null)
    this.refreshTerminalTitle()
    this.refreshAgentChrome()
  }

  private syncSubagentParents(): Promise<void> {
    return this.subagents.setParents(
      this.agents.flatMap((agent) => {
        const sessionId = this.sessionIdOf(agent)
        return sessionId ? [sessionId] : []
      }),
    )
  }

  private setTrayHidden(hidden: boolean): void {
    if (hidden === this.trayHidden) return
    this.trayHidden = hidden
    this.refreshAgentChrome()
    this.options.onTrayHiddenChange?.(this.trayHidden)
  }

  private restoreFocus(): void {
    if (this.modalKind || this.agentPicker.open) return
    this.activeAgent()?.terminal.focus()
  }

  private refreshAgentChrome(): void {
    const hasAgents = this.agents.length > 0
    const hasRecoveryCard = this.recoveryCard !== null
    const hasSelectableSurface = hasAgents || hasRecoveryCard
    const showTray = hasSelectableSurface && !this.pickerMode && !this.trayHidden
    const showPicker = hasSelectableSurface
      && this.pickerMode
      && (!this.hideSingleAgentPicker || hasRecoveryCard || this.agents.length > 1)
    this.tray.visible = showTray
    this.divider.visible = showTray
    this.agentPicker.visible = showPicker
    if (!showPicker) this.agentPicker.close()
    if (this.recoveryCard) this.recoveryCard.visible = this.recoveryCardSelected
    this.emptyState.visible = !hasSelectableSurface
    if (!hasSelectableSurface) this.refreshEmptyState()
    this.applyLayout()
  }

  private refreshEmptyState(): void {
    const confirmingExit = this.exitConfirmationTimer !== null
    const palette = fxnkRamp(this.theme.theme)
    this.emptyState.content = confirmingExit
      ? `press ${this.exitConfirmationKey ?? "ctrl+c"} again to exit`
      : emptyStateContent()
    this.emptyState.fg = confirmingExit ? palette.foreground : palette.dim
  }

  private requestExitConfirmation(key: "ctrl+c" | "ctrl+d"): void {
    if (this.exitConfirmationTimer !== null) {
      clearTimeout(this.exitConfirmationTimer)
      this.exitConfirmationTimer = null
      this.exitConfirmationKey = null
      void this.shutdown()
      return
    }

    this.exitConfirmationKey = key
    this.exitConfirmationTimer = setTimeout(() => {
      this.exitConfirmationTimer = null
      this.exitConfirmationKey = null
      if (!this.shuttingDown && this.agents.length === 0) this.refreshEmptyState()
    }, EXIT_CONFIRMATION_TIMEOUT_MS)
    this.refreshEmptyState()
  }

  private cancelExitConfirmation(): void {
    if (this.exitConfirmationTimer !== null) clearTimeout(this.exitConfirmationTimer)
    this.exitConfirmationTimer = null
    this.exitConfirmationKey = null
    this.refreshEmptyState()
  }

  private sessionEntries(): SessionEntry[] {
    return this.agents.map((agent, index) => {
      const record = this.registry.get(agent.paneId)
      const sessionId = this.sessionIdOf(agent)
      const git = this.gitContexts.get(agent.cwd) ?? null
      return {
        agentId: agent.id,
        project: projectNameFor(git, agent.cwd),
        branch: git?.branch ?? null,
        sessionId: shortSessionId(sessionId),
        name: sessionId ? this.sessionNames.nameFor(sessionId) : null,
        state: displayStateFor(record, this.seenSeq.get(agent.id) ?? 0),
        attention: record?.attention ?? null,
        active: index === this.activeIndex,
        subagents: sessionId ? this.subagents.childrenOf(sessionId) : [],
      }
    })
  }

  /**
   * fx never reports where it is working, so fmx reads it from the directory
   * it spawned the agent in. A live start renders without a branch rung
   * until the answer arrives, which is why this refreshes rather than
   * blocking. Restored Agents await these reads behind the first-paint
   * preparation barrier.
   *
   * Only an answer is remembered. A read that fails — git slow enough to trip
   * its timeout while a start joins several at once, say — leaves nothing
   * behind, so the next call asks again instead of pinning that directory to
   * "no branch" for the life of the Runtime.
   */
  private loadGitContext(cwd: string): Promise<GitContext | null> {
    const pending = this.gitContextLoads.get(cwd)
    if (pending) return pending
    if (this.gitContexts.has(cwd)) return Promise.resolve(this.gitContexts.get(cwd) ?? null)
    const load = readGitContext(cwd).then((context) => {
      if (!this.shuttingDown && context) {
        this.gitContexts.set(cwd, context)
        this.refreshAgentNavigation()
      }
      return context
    }).finally(() => {
      this.gitContextLoads.delete(cwd)
    })
    this.gitContextLoads.set(cwd, load)
    return load
  }

  /**
   * Mark an agent acknowledged: its current state is now one the human has
   * looked at, so a finished turn stops reading as `done`.
   */
  private markSeen(agent: FxAgent): void {
    const record = this.registry.get(agent.paneId)
    this.seenSeq.set(agent.id, record?.stateSeq ?? 0)
    this.checkpointAgent(agent)
  }

  /** Keep the last trustworthy ADE snapshot and its acknowledgement relation. */
  private checkpointAgent(agent: FxAgent): void {
    const record = this.registry.get(agent.paneId)
    if (!record) return
    void this.options.manifest.setAgentStatus(agent.entry.agentId, {
      state: record.state,
      attention: record.attention,
      seen: (this.seenSeq.get(agent.id) ?? 0) >= record.stateSeq,
    }).catch(() => {})
  }

  private selectAgent(agentId: number, focus = true): void {
    const index = this.agents.findIndex((agent) => agent.id === agentId)
    if (index === -1) return
    if (index === this.activeIndex) {
      if (focus) this.restoreFocus()
      return
    }
    this.switchTo(index, focus)
  }

  private acceptAdeRecord(record: AdeRecord): void {
    const agent = this.agents.find((candidate) => candidate.entry.agentId === record.instanceId)
    if (!agent) return

    let previousSequence = this.adeSequences.get(record.instanceId)
    if (
      record.event === "FxStarted" &&
      record.sequence === 1 &&
      this.adeStoppedInstances.has(record.instanceId)
    ) {
      // An orderly in-place Fx relaunch keeps fmx's stable instance identity
      // but begins a new process-local ADE sequence at one.
      previousSequence = undefined
      this.adeSequences.delete(record.instanceId)
      this.adeStoppedInstances.delete(record.instanceId)
    }
    if (previousSequence !== undefined && record.sequence <= previousSequence) {
      const stale = (this.adeStaleRecords.get(record.instanceId) ?? 0) + 1
      if (stale < STALE_SEQUENCE_LIMIT) {
        this.adeStaleRecords.set(record.instanceId, stale)
        return
      }
      // Fx never rewinds: a run beneath the mark means the mark is wrong.
      this.adeStaleRecords.delete(record.instanceId)
      previousSequence = undefined
    }
    this.adeStaleRecords.delete(record.instanceId)
    const gap = previousSequence === undefined ? record.sequence !== 1 : record.sequence !== previousSequence + 1
    this.adeSequences.set(record.instanceId, record.sequence)

    let changed = false
    // Identity and lifecycle are envelope context, not event payload. Main
    // records alone replace the active main identity: a child's parent
    // attribution can intentionally name an older session after `/new`.
    const previousSession = this.sessionIdOf(agent)
    const contextualIdentityChanged =
      record.context.agentRole === "main" && previousSession !== record.context.sessionId
    if (record.context.agentRole === "main") {
      changed = this.installAdeSession(agent, record.context.sessionId) || changed
    }
    if (gap) {
      const recoverySession = this.sessionIdOf(agent)
      // Installing a different identity already reads its durable sidecar.
      if (recoverySession && !contextualIdentityChanged) {
        changed = this.sessionNames.recover(recoverySession) || changed
      }
    }
    if (record.context.agentRole !== "main") {
      changed = this.subagents.applyAdeRecord(record) || changed
      if (changed) this.refreshAgentNavigation()
      return
    }

    this.registry.apply(agent.paneId, record)
    if (record.event === "FxStopped") this.adeStoppedInstances.add(record.instanceId)

    switch (record.event) {
      case "FxStarted":
        break
      case "SessionChanged":
        break
      case "SessionMetadataChanged": {
        const sessionId = record.context.sessionId
        const title = record.payload.title
        if (sessionId && typeof title === "string") {
          changed = this.sessionNames.apply(sessionId, title) || changed
        }
        break
      }
      default:
        // Schema 1 is additive. Unknown events still advance sequence.
        break
    }
    // A visible Agent is seen at the snapshot it just reported; an inactive
    // one is checkpointed as unseen so a completed turn survives Detach.
    if (this.activeAgent() === agent) this.markSeen(agent)
    else this.checkpointAgent(agent)
    this.refreshAgentNavigation()
  }

  private installAdeSession(agent: FxAgent, sessionId: string | null): boolean {
    if (sessionId !== null && !isSessionId(sessionId)) return false
    const hadRecord = this.registry.get(agent.paneId) !== null
    const previous = this.sessionIdOf(agent)
    const identityChanged = !hadRecord || previous !== sessionId
    this.registry.setSessionId(agent.paneId, sessionId)
    if (identityChanged) {
      void this.options.manifest.setFxSessionId(agent.entry.agentId, sessionId).catch(() => {})
    }
    const recovered = identityChanged && sessionId ? this.sessionNames.recover(sessionId) : false
    return previous !== sessionId || recovered
  }

  private home(): string {
    return this.options.home ?? homedir()
  }

  private adeBinding(instanceId: string): FxAdeBinding | null {
    const socket = this.adeSocket
    return socket ? { socketPath: socket.path, instanceId } : null
  }

  private subscribeAde(): void {
    if (this.adeSubscribed || !this.adeSocket) return
    this.adeSubscribed = true
    this.adeSocket.addEventListener(this.adeHandler)
  }

  private sessionIdOf(agent: FxAgent): string | null {
    return this.registry.get(agent.paneId)?.sessionId ?? null
  }

  private beginDividerDrag(event: MouseEvent): void {
    event.preventDefault()
    event.stopPropagation()
    this.dividerDragging = true
    this.dragStartWidth = this.trayWidth
    // Capture immediately: OpenTUI only latches drag capture on the first drag
    // event, and a fast flick can put that event past this one-cell divider —
    // over the terminal, which forwards motion to fx and stops propagation.
    this.captureMouse(this.divider)
  }

  private continueDividerDrag(event: MouseEvent): void {
    if (!this.dividerDragging) return
    event.preventDefault()
    event.stopPropagation()
    this.applyTrayWidth(event.x)
  }

  private endDividerDrag(): void {
    if (!this.dividerDragging) return
    this.dividerDragging = false
    if (this.trayWidth !== this.dragStartWidth) {
      this.options.onTrayWidthChange?.(this.trayWidth)
    }
  }

  private captureMouse(renderable: BoxRenderable): void {
    // Not in CliRenderer's public typings; the renderer clears it on mouse-up.
    const capturer = this.renderer as unknown as {
      setCapturedRenderable?: (renderable: BoxRenderable) => void
    }
    capturer.setCapturedRenderable?.(renderable)
  }

  private applyLayout(requestedTrayWidth = this.trayWidth): void {
    this.applyTrayWidth(requestedTrayWidth)
    this.agentPicker.resizeForSize(this.renderer.width, this.renderer.height)
  }

  private applyTrayWidth(requested = this.trayWidth): void {
    // The ceiling is measured against the whole stage, so a given drag always
    // reaches the same width.
    const max = Math.max(1, Math.floor(this.renderer.width * TRAY_MAX_SCREEN_FRACTION))
    const min = Math.min(TRAY_MIN_WIDTH, max)
    this.trayWidth = Math.max(min, Math.min(max, requested))
    this.tray.width = this.trayWidth
    this.refreshAgentNavigation()
  }

  private applyDividerTheme(): void {
    const color = fxnkRamp(this.theme.theme).divider
    this.divider.borderColor = color
    this.divider.focusedBorderColor = color
    this.sessionList.applyTheme(this.theme.theme)
    this.refreshAgentNavigation()
  }

  /** The modal takes keys, so its border is the focus hue — or the error hue
   * when what took the screen is a failure. */
  private applyModalTheme(): void {
    const palette = fxnkRamp(this.theme.theme)
    const isError = this.modalKind === "spawn-error"
    const borderColor = isError ? palette.error : palette.focus
    this.modalBackdrop.backgroundColor = palette.backdrop
    this.modal.backgroundColor = palette.background
    this.modal.borderColor = borderColor
    this.modal.focusedBorderColor = borderColor
    // Every surface fmx draws over fx names itself in its own border, so what
    // took the screen is legible before any of its content is read.
    this.modal.title = isError ? ERROR_MODAL_TITLE : HELP_MODAL_TITLE
    this.modal.titleColor = palette.foreground
    this.modalText.fg = palette.foreground
    this.modalText.bg = palette.background
    this.modalText.content =
      this.modalKind === "spawn-error"
        ? styledSpawnErrorContent(this.spawnErrorHeading, this.spawnErrorLines, palette)
        : styledHelpContent(this.keybindings, palette, this.pickerMode)
  }

  private onSelection(selection: Selection): void {
    // FxTerminalRenderable keeps a gesture provisional until it has covered two
    // cells. Treat gestures that never cross that threshold as focus, not a
    // clipboard mutation. Activated selections may later contract to one cell.
    if (selection.isStart) {
      this.renderer.clearSelection()
      return
    }

    const text = selection.getSelectedText()
    if (!text) {
      // Blank terminal rows can form a real multi-cell selection but yield no
      // clipboard text. There is nothing useful to preserve after mouse-up.
      this.renderer.clearSelection()
      return
    }
    if (this.renderer.copyToClipboardOSC52(text)) this.renderer.clearSelection()
  }

  private onKeyPress(key: KeyEvent): void {
    if (this.renderer.hasSelection) this.renderer.clearSelection()
    if (this.shuttingDown) {
      this.swallow(key)
      return
    }

    if (this.modalKind) {
      this.swallow(key)
      if (
        key.name === "escape" ||
        isCancelKey(key) ||
        (this.modalKind === "help" && keyMatchesCombo(key, HELP_CLOSE_KEY))
      ) {
        this.hideModal()
      }
      return
    }

    if (this.pickerMode && this.agentPicker.open) {
      this.handleAgentPickerKey(key)
      return
    }

    if (this.recoveryCardSelected && this.recoveryCard?.handleKeyPress(key)) {
      this.swallow(key)
      return
    }

    const emptyStateExitKey = isCancelKey(key) ? "ctrl+c" : keyMatchesCombo(key, CTRL_D_KEY) ? "ctrl+d" : null
    if (this.agents.length === 0 && !this.recoveryCard && emptyStateExitKey !== null) {
      this.swallow(key)
      this.cancelPrefix()
      this.requestExitConfirmation(emptyStateExitKey)
      return
    }

    if (this.prefixArmed) {
      this.swallow(key)
      if (MODIFIER_ONLY_KEYS.has(key.name.toLowerCase())) return
      this.cancelPrefix()
      if (key.name === "escape") return
      const action = actionForKey(this.keybindings, key, "prefix")
      if (action) this.executeAction(action)
      return
    }

    const directAction = actionForKey(this.keybindings, key, "direct")
    if (directAction) {
      this.swallow(key)
      this.executeAction(directAction)
      return
    }

    if (keyMatchesCombo(key, this.keybindings.prefix)) {
      this.swallow(key)
      this.prefixArmed = true
    }
  }

  private onKeyRelease(key: KeyEvent): void {
    const identity = keyIdentity(key)
    if (!this.swallowedReleases.delete(identity)) return
    key.preventDefault()
    key.stopPropagation()
  }

  private executeAction(action: KeyAction): void {
    switch (action.name) {
      case "detach":
        // A thin Client consumes this binding before its bytes reach the
        // Runtime. Treat a leaked or stale binding as inert: terminal input
        // must never turn one Client's Detach into a shared shutdown.
        return
      case "previous_tab":
        this.cycleSelectableSurface(-1)
        return
      case "next_tab":
        this.cycleSelectableSurface(1)
        return
      case "help":
        this.showHelp()
        return
      case "toggle_tray":
        if (this.pickerMode) this.agentPicker.toggle()
        else this.setTrayHidden(!this.trayHidden)
        return
    }
  }

  private handleAgentPickerKey(key: KeyEvent): void {
    if (this.prefixArmed) {
      this.swallow(key)
      if (MODIFIER_ONLY_KEYS.has(key.name.toLowerCase())) return
      this.cancelPrefix()
      if (key.name === "escape") return
      const action = actionForKey(this.keybindings, key, "prefix")
      if (action?.name === "toggle_tray") this.agentPicker.toggle()
      return
    }

    const directAction = actionForKey(this.keybindings, key, "direct")
    if (directAction?.name === "toggle_tray") {
      this.swallow(key)
      this.agentPicker.toggle()
      return
    }
    if (keyMatchesCombo(key, this.keybindings.prefix)) {
      this.swallow(key)
      this.prefixArmed = true
      return
    }

    this.swallow(key)
    this.agentPicker.handleKeyPress(key)
  }

  private cancelPrefix(): void {
    this.prefixArmed = false
  }

  /** Branch from what the Agent start was looking at and check it out under the
   * worktree root, returning where the agent should start. */
  private async cutWorktree(directory: string): Promise<string> {
    const context = await readWorktreeContext(directory)
    if (!context) throw new Error(`${directory} is not a git repository`)
    const base = await readHeadCommit(directory)
    const root = expandTilde(this.options.worktreeRoot ?? DEFAULT_WORKTREE_ROOT, this.home())
    const plan = planWorktree(context, root)
    await createWorktree(context, plan, base)
    return plan.checkout
  }

  private showHelp(): void {
    const [width, height] = helpModalSize(this.keybindings, this.pickerMode)
    this.showModal("help", width, height)
  }

  private showError(heading: string, error: unknown): void {
    const message = sanitizeTitle(errorMessage(error)) || "unknown error"
    const lineWidth = Math.max(1, Math.min(68, this.renderer.width - 5))
    this.spawnErrorHeading = heading
    this.spawnErrorLines = wrapText(message, lineWidth)
    const contentWidth = Math.max(
      heading.length,
      ...this.spawnErrorLines.map((line) => line.length),
    )
    this.showModal(
      "spawn-error",
      Math.min(this.renderer.width, contentWidth + 6),
      this.spawnErrorLines.length + 4,
    )
  }

  private showModal(kind: ModalKind, width: number, height: number): void {
    this.modalKind = kind
    this.agentPicker.close()
    this.resizeModal(width, height)
    this.applyModalTheme()
    this.modalBackdrop.visible = true
    this.modal.visible = true
    this.activeAgent()?.terminal.blur()
  }

  private resizeModal(width: number, height: number): void {
    this.modal.width = width
    this.modal.height = height
    this.modal.marginLeft = -Math.floor(width / 2)
    this.modal.marginTop = -Math.floor(height / 2)
  }

  private hideModal(): void {
    if (!this.modalKind) return
    this.modalKind = null
    this.modal.visible = false
    this.modalBackdrop.visible = false
    if (!this.shuttingDown) this.restoreFocus()
  }

  private swallow(key: KeyEvent): void {
    key.preventDefault()
    key.stopPropagation()
    this.swallowedReleases.add(keyIdentity(key))
  }

  /* ------------------------------------------------------------ control */

  /** MCP reads answer from current UI state; writes use the key/mouse paths. */
  private async handleControl(
    method: ControlMethod,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (this.shuttingDown) throw new ControlFailure("shutting_down", "fmx is shutting down")
    const caller = optionalInteger(params, "caller") ?? null
    switch (method) {
      case "orient":
        return this.snapshot(caller)
      case "agent.create":
        return this.serializeCreation(async () => {
          if (signal.aborted) throw new ControlFailure("cancelled", "Agent creation was cancelled")
          const directory = this.creationDirectory(params, caller)
          const model = optionalCreationSetting(params, "model")
          const effort = optionalCreationSetting(params, "effort")
          const agent = await this.createAgent({
            directory,
            worktree: optionalBoolean(params, "worktree") ?? false,
            focus: false,
            startLevel: model === undefined && effort === undefined ? null : { model, effort },
          })
          return { agent }
        })
      case "focus": {
        const agent = this.resolveTarget(parseTarget(requiredString(params, "target")), caller)
        this.refuseIfBusy()
        this.selectAgent(agent.id)
        return { agent: this.agentInfo(agent) }
      }
      case "tray": {
        const width = optionalInteger(params, "width")
        if (width !== undefined) {
          if (width < 1) throw new ControlFailure("invalid_params", "width must be at least 1")
          this.applyTrayWidth(width)
          this.options.onTrayWidthChange?.(this.trayWidth)
        }
        const hidden = optionalBoolean(params, "hidden")
        if (hidden !== undefined) this.setTrayHidden(hidden)
        else if (optionalBoolean(params, "toggle")) this.setTrayHidden(!this.trayHidden)
        return this.trayInfo()
      }
      case "work.snapshot":
        return this.agentWork(this.resolveWorkTarget(params, caller), "work.snapshot", {}, signal)
      case "work.queue":
      case "work.steer": {
        const agent = this.resolveWorkTarget(params, caller)
        const result = await this.requestAgentWork(agent, method, { text: requiredWorkText(params) }, signal)
        if (!result.turn_id || !result.disposition) {
          throw new ControlFailure("failed", "Fx returned no work admission identity")
        }
        return {
          agent: this.agentInfo(agent),
          turn_id: result.turn_id,
          disposition: result.disposition,
          work: result.snapshot,
        }
      }
      case "work.interrupt":
        return this.agentWork(this.resolveWorkTarget(params, caller), "work.interrupt", {}, signal)
      case "queue.update":
        return this.agentWork(
          this.resolveWorkTarget(params, caller),
          "queue.update",
          { turn_id: requiredTurnId(params), text: requiredWorkText(params) },
          signal,
        )
      case "queue.delete":
        return this.agentWork(
          this.resolveWorkTarget(params, caller),
          "queue.delete",
          { turn_id: requiredTurnId(params) },
          signal,
        )
      case "queue.resume":
        return this.agentWork(this.resolveWorkTarget(params, caller), "queue.resume", {}, signal)
    }
  }

  private creationDirectory(params: Record<string, unknown>, caller: number | null): string {
    const requested = optionalString(params, "directory")
    if (requested !== undefined) {
      if (requested.trim() === "") throw new ControlFailure("invalid_params", "directory must not be empty")
      const directory = resolve(this.options.cwd, expandTilde(requested, this.home()))
      if (!isRepositoryDirectory(directory)) throw new NotARepositoryError(directory)
      return directory
    }

    const callerAgent = caller === null
      ? null
      : (this.agents.find((agent) => agent.id === caller) ?? null)
    if (callerAgent) return callerAgent.cwd
    const [project] = scanProjectRoots(this.options.projectRoots ?? [], this.home())
    if (!project) {
      throw new ControlFailure(
        "invalid_params",
        "no project is available; pass directory or configure project_roots",
      )
    }
    return project
  }

  private serializeCreation<T>(create: () => Promise<T>): Promise<T> {
    const result = this.creationTail.then(create, create)
    this.creationTail = result.then(() => {}, () => {})
    return result
  }

  private resolveWorkTarget(params: Record<string, unknown>, caller: number | null): FxAgent {
    return this.resolveTarget(parseTarget(optionalString(params, "target") ?? "current"), caller)
  }

  private async agentWork(
    agent: FxAgent,
    method: FxWorkControlMethod,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ agent: AgentInfo; work: FxWorkControlResult["snapshot"] }> {
    const result = await this.requestAgentWork(agent, method, params, signal)
    return { agent: this.agentInfo(agent), work: result.snapshot }
  }

  private async requestAgentWork(
    agent: FxAgent,
    method: FxWorkControlMethod,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FxWorkControlResult> {
    const binding = agent.entry.workControl
    if (!binding) {
      throw new ControlFailure("failed", `Agent ${agent.id} was created without semantic Fx work control`)
    }
    try {
      return await this.fxWorkControl.request(binding, method, params, signal)
    } catch (error) {
      if (!(error instanceof FxWorkControlError)) throw error
      const code = error.code === "cancelled"
        ? "cancelled"
        : error.code === "timeout"
          ? "timeout"
          : error.code === "busy" || error.code === "queue_editor_visible"
            ? "busy"
            : error.code === "queued_work_not_found" || error.code === "no_active_work"
              ? "not_found"
              : "failed"
      throw new ControlFailure(code, error.message, { fx_code: error.code })
    }
  }

  /** Something drawn over fx takes the keys; a command that would fight it
   * for the screen is refused rather than silently stealing focus. */
  private refuseIfBusy(): void {
    if (this.modalKind || this.agentPicker.open) {
      throw new ControlFailure("busy", "something is already open", { surface: this.surface() })
    }
  }

  private resolveTarget(target: Target, caller: number | null): FxAgent {
    switch (target.kind) {
      case "agent_id":
        return this.agentByStableId(target.agentId)
      case "pane_id":
        return this.agentByPaneId(target.paneId)
      case "display_id":
        return this.agentById(target.displayId)
      case "current":
        if (caller === null) {
          throw new ControlFailure("invalid_params", "current needs a caller inside an agent (FMX_AGENT_ID)")
        }
        return this.agentById(caller)
      case "active": {
        const active = this.activeAgent()
        if (!active) throw new ControlFailure("not_found", "no agent is active")
        return active
      }
      case "next":
      case "previous": {
        if (this.agents.length === 0) throw new ControlFailure("not_found", "no agents")
        const count = this.agents.length
        const step = target.kind === "next" ? 1 : -1
        return this.agents[(((this.activeIndex + step) % count) + count) % count]!
      }
      case "name": {
        const byName = this.agents.filter((agent) => this.nameOf(agent) === target.name)
        if (byName.length === 1) return byName[0]!
        if (byName.length > 1) {
          throw new ControlFailure("ambiguous", `${target.name} names more than one agent`, {
            agents: byName.map((agent) => agent.id),
          })
        }
        const bySession = this.agents.filter((agent) => this.sessionIdOf(agent)?.startsWith(target.name))
        if (bySession.length === 1) return bySession[0]!
        if (bySession.length > 1) {
          throw new ControlFailure("ambiguous", `${target.name} names more than one agent`, {
            agents: bySession.map((agent) => agent.id),
          })
        }
        throw new ControlFailure("not_found", `no agent named ${target.name}`)
      }
    }
  }

  private agentById(id: number): FxAgent {
    const agent = this.agents.find((candidate) => candidate.id === id)
    if (!agent) throw new ControlFailure("not_found", `no agent ${id}`)
    return agent
  }

  private agentByStableId(agentId: string): FxAgent {
    const agent = this.agents.find((candidate) => candidate.entry.agentId === agentId)
    if (!agent) throw new ControlFailure("not_found", `no agent ${agentId}`)
    return agent
  }

  private agentByPaneId(paneId: string): FxAgent {
    const agent = this.agents.find((candidate) => candidate.paneId === paneId)
    if (!agent) throw new ControlFailure("not_found", `no agent ${paneId}`)
    return agent
  }

  private displayStateOf(agent: FxAgent): DisplayState {
    return displayStateFor(this.registry.get(agent.paneId), this.seenSeq.get(agent.id) ?? 0)
  }

  private nameOf(agent: FxAgent): string | null {
    const sessionId = this.sessionIdOf(agent)
    return sessionId ? this.sessionNames.nameFor(sessionId) : null
  }

  private agentInfo(agent: FxAgent): AgentInfo {
    const record = this.registry.get(agent.paneId)
    const sessionId = this.sessionIdOf(agent)
    const git = this.gitContexts.get(agent.cwd) ?? null
    return {
      agent_id: agent.entry.agentId,
      id: agent.id,
      display_id: agent.id,
      pane_id: agent.paneId,
      created_at: agent.entry.createdAt,
      cwd: agent.cwd,
      project: projectNameFor(git, agent.cwd),
      git_root: git?.root ?? null,
      main_git_root: git?.mainRoot ?? null,
      branch: git?.branch ?? null,
      worktree: git ? git.root !== git.mainRoot : null,
      name: this.nameOf(agent),
      session_id: sessionId,
      label: agent.label,
      state: this.displayStateOf(agent),
      attention: record?.attention ?? null,
      active: this.activeAgent() === agent,
      subagents: sessionId ? subagentInfos(this.subagents.childrenOf(sessionId)) : [],
    }
  }

  private surface(): Surface {
    if (this.modalKind === "help") return { kind: "help" }
    if (this.modalKind === "spawn-error") {
      return { kind: "error", heading: this.spawnErrorHeading, message: this.spawnErrorLines.join("") }
    }
    if (this.agentPicker.open) return { kind: "agent_picker" }
    return { kind: "none" }
  }

  private snapshot(caller: number | null): Snapshot {
    const you = caller === null ? null : (this.agents.find((agent) => agent.id === caller) ?? null)
    const rows: TrayRow[] = buildTree(this.sessionEntries()).map((row) => ({
      kind: row.kind,
      depth: row.depth,
      text:
        row.kind === "agent" || row.kind === "subagent"
          ? `${stateIcon(row.state, row.attention)} ${row.label || "—"}`
          : row.label,
      agent: row.agentId,
      active: row.active,
    }))
    return {
      fmx: {
        pid: process.pid,
        version: VERSION,
        cwd: this.options.cwd,
        cols: this.renderer.width,
        rows: this.renderer.height,
        ...(this.options.fmxName ? { name: this.options.fmxName } : {}),
      },
      you: you ? this.agentInfo(you) : null,
      active: this.activeAgent()?.id ?? null,
      agents: this.agents.map((agent) => this.agentInfo(agent)),
      tray: { ...this.trayInfo(), rows },
      surface: this.surface(),
    }
  }

  /** `visible` is what is drawn; `hidden` is the human's choice, which an
   * empty fmx keeps without showing. */
  private trayInfo(): { visible: boolean; hidden: boolean; width: number } {
    return { visible: this.tray.visible, hidden: this.trayHidden, width: this.trayWidth }
  }

  private refreshTerminalTitle(): void {
    if (this.shuttingDown && this.renderer.isDestroyed) return
    const active = this.activeAgent()
    this.renderer.setTerminalTitle(fmxTerminalTitle(this.options.fmxName, active?.label))
  }
}

export function fmxTerminalTitle(name?: string, activeLabel?: string): string {
  const base = name ? `fmx ${name}` : "fmx"
  return activeLabel ? `${base} · ${activeLabel}` : base
}

type HelpEntry = readonly [key: string, description: string]

const ACTIONS: Record<KeyActionName, { help: string }> = {
  help: { help: "keybinds" },
  detach: { help: "detach client" },
  previous_tab: { help: "prev agent" },
  next_tab: { help: "next agent" },
  toggle_tray: { help: "toggle tray" },
}

function helpEntries(keybindings: Keybindings, agentPicker = false): HelpEntry[] {
  return [
    [keybindings.prefixLabel, "prefix mode"],
    ...ACTION_FIELDS.map(
      (action): HelpEntry => [
        bindingLabel(keybindings[action]),
        action === "toggle_tray" && agentPicker ? "toggle agent picker" : ACTIONS[action].help,
      ],
    ),
  ]
}

function helpModalSize(keybindings: Keybindings, agentPicker = false): [width: number, height: number] {
  const lines = helpPlainText(keybindings, agentPicker).split("\n")
  return [Math.max(...lines.map((line) => line.length)) + 5, lines.length + 2]
}

function helpPlainText(keybindings: Keybindings, agentPicker = false): string {
  const entries = helpEntries(keybindings, agentPicker)
  const keyColumn = helpKeyColumn(entries)
  return entries.map(([key, description]) => ` ${key.padEnd(keyColumn)}${description}`).join("\n")
}

/** Keys are labels — bold, one step down the ramp; what they do is the text. */
function styledHelpContent(keybindings: Keybindings, ramp: Ramp, agentPicker = false): StyledText {
  const entries = helpEntries(keybindings, agentPicker)
  const keyColumn = helpKeyColumn(entries)
  const chunks: TextChunk[] = []
  for (const [index, [key, description]] of entries.entries()) {
    chunks.push(fg(ramp.foreground)(index === 0 ? " " : "\n "))
    chunks.push(bold(fg(ramp.secondary)(key.padEnd(keyColumn))))
    chunks.push(fg(ramp.foreground)(description))
  }
  return new StyledText(chunks)
}

/** The border already says failure; the heading is fx's red role, which is
 * a gray one step below primary, set bold. */
function styledSpawnErrorContent(heading: string, lines: string[], ramp: Ramp): StyledText {
  const chunks: TextChunk[] = [bold(fg(ramp.accent)(` ${heading}`)), fg(ramp.foreground)("\n\n ")]
  chunks.push(fg(ramp.foreground)(lines.join("\n ")))
  return new StyledText(chunks)
}

function helpKeyColumn(entries: HelpEntry[]): number {
  return Math.max(...entries.map(([key]) => key.length)) + 2
}

function emptyStateContent(): string {
  return "no agents"
}

function bindingLabel(bindings: ResolvedBinding[]): string {
  return bindings.map((binding) => binding.label).join(" / ") || "unset"
}

function resolveStartLevel(
  explicit: FxStartLevel | null,
  defaults: AgentDefaults | undefined,
): FxStartLevel | null {
  const model = explicit?.model ?? defaults?.model
  const effort = explicit?.effort ?? defaults?.effort
  return model === undefined && effort === undefined ? null : { model, effort }
}

function assertManagedClaim(claim: ManagedAgentClaim): void {
  if (!isAgentId(claim.agentId)) throw new Error(`invalid managed Agent id: ${claim.agentId}`)
  if (!isAbsolute(claim.cwd) || normalize(claim.cwd) !== claim.cwd || claim.cwd === "/") {
    throw new Error(`managed Agent ${claim.agentId} has an invalid directory`)
  }
  if (claim.fxPath.length === 0 || claim.fxArgs?.some((value) => typeof value !== "string")) {
    throw new Error(`managed Agent ${claim.agentId} has invalid Fx launch metadata`)
  }
  if (
    claim.createdAt !== undefined &&
    (!Number.isSafeInteger(claim.createdAt) || claim.createdAt < 0)
  ) {
    throw new Error(`managed Agent ${claim.agentId} has an invalid creation time`)
  }
  if (
    claim.workControl.instanceId !== claim.agentId ||
    !isAbsolute(claim.workControl.socketPath) ||
    claim.workControl.socketPath.includes("\0") ||
    !/^[0-9a-f]{64}$/u.test(claim.workControl.token)
  ) {
    throw new Error(`managed Agent ${claim.agentId} has an invalid Work-control binding`)
  }
}

function assertManagedInvocation(
  entry: ManifestEntry,
  invocation: ManagedAgentInvocation,
): void {
  if (invocation.cwd !== entry.cwd) {
    throw new Error(`managed Fx invocation directory does not match agent: ${entry.agentId}`)
  }
  if (
    invocation.command.length === 0 ||
    invocation.command.some((value) => typeof value !== "string") ||
    invocation.command[0] !== entry.fxPath
  ) {
    throw new Error(`managed Fx invocation does not match agent: ${entry.agentId}`)
  }
  if (
    entry.fxArgs !== null &&
    (invocation.command.length !== entry.fxArgs.length + 1 ||
      entry.fxArgs.some((value, index) => invocation.command[index + 1] !== value))
  ) {
    throw new Error(`managed Fx invocation does not match agent: ${entry.agentId}`)
  }
  if (Object.values(invocation.env).some((value) => typeof value !== "string")) {
    throw new Error(`managed Fx invocation environment is invalid: ${entry.agentId}`)
  }
}

function managedInvocationKey(invocation: ManagedAgentInvocation): string {
  return JSON.stringify([
    invocation.command,
    invocation.cwd,
    Object.entries(invocation.env).sort(([left], [right]) => left.localeCompare(right)),
  ])
}

function displayStateForCheckpoint(entry: ManifestEntry): DisplayState {
  const checkpoint = entry.agentStatus
  if (!checkpoint) return "unknown"
  if (checkpoint.state === "idle") return checkpoint.seen ? "idle" : "done"
  return checkpoint.state
}

function wrapText(value: string, width: number): string[] {
  const characters = [...value]
  const lines: string[] = []
  for (let offset = 0; offset < characters.length; offset += width) {
    lines.push(characters.slice(offset, offset + width).join(""))
  }
  return lines.length > 0 ? lines : [""]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  visit: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      await visit(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, () => worker()))
}

function subagentInfos(entries: SubagentEntry[]): SubagentInfo[] {
  return entries.map((entry) => ({
    session_id: entry.sessionId,
    label: entry.label,
    state: entry.state,
    attention: entry.attention,
    children: subagentInfos(entry.children),
  }))
}

/** Agent creation failed while making its requested Worktree. */
class WorktreeError extends ControlFailure {
  constructor(message: string) {
    super("failed", message)
    this.name = "WorktreeError"
  }
}

function optionalCreationSetting(
  params: Record<string, unknown>,
  key: "model" | "effort",
): string | undefined {
  const value = optionalString(params, key)
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === "") throw new ControlFailure("invalid_params", `${key} must not be empty`)
  return trimmed
}

function requiredWorkText(params: Record<string, unknown>): string {
  const text = requiredString(params, "text")
  if (text.length === 0) throw new ControlFailure("invalid_params", "text must not be empty")
  return text
}

function requiredTurnId(params: Record<string, unknown>): string {
  const turnId = requiredString(params, "turn_id")
  if (!/^[1-9]\d*$/u.test(turnId)) {
    throw new ControlFailure("invalid_params", "turn_id must be a positive decimal string")
  }
  return turnId
}

/** An agent runs in a repository or it does not run. */
class NotARepositoryError extends ControlFailure {
  constructor(directory: string) {
    super("invalid_params", `${directory} is not a git repository`)
    this.name = "NotARepositoryError"
  }
}
