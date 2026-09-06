import { type CliRenderer, MouseEvent, PasteEvent } from "@opentui/core"
import { CursorReportAdapter } from "./cursor-report-adapter.ts"
import type { FxnkThemeResolution } from "./host-palette.ts"
import { PaneTerminalRenderable } from "./pane-terminal.ts"
import { ApiFailure, type Capture, type InputEvent, type SessionView } from "./protocol.ts"
import {
  isNamedKey,
  keyEventFor,
  keyEventsForText,
  mouseDeliveryFor,
  type PaneOrigin,
} from "./session-input.ts"
import {
  looksLikeOwnedSession,
  ownedSessionName,
  RESERVED_LABELS,
  sessionIdentity,
  type SessionIdentity,
} from "./session-identity.ts"
import {
  SessionEndedError,
  SessionUnreachableError,
  type SessionExit,
  type SessionTransport,
  type SessionTransportFactory,
  type TerminalSize,
} from "./session-transport.ts"
import { OscTitleParser, sanitizeTitle } from "./title-parser.ts"
import type { CompanionCommand } from "./zmx-command.ts"

/** RIS. Everything — screen, scrollback, modes — so a restore lands on nothing. */
const TERMINAL_RESET = new Uint8Array([0x1b, 0x63])
const MAX_SCROLLBACK_BYTES = 10_000_000
const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 }
/** How long a change is collected before one `session.changed` goes out. */
export const CHANGE_DEBOUNCE_MS = 100
/** How many times, and how far apart, a lost transport is reached for. */
const RECOVERY_ATTEMPTS = 3
const RECOVERY_INTERVAL_MS = 250
/** How many inactive Sessions are attached at once while adopting. */
const ADOPT_CONCURRENCY = 4

/** Variables a child must never inherit from the Runtime that started it. */
const PRIVATE_ENVIRONMENT = /^(?:SMOLMUX_|ZMX_|TMUX|HERDR_)/u

export type SessionCreateRequest = {
  name: string
  argv: string[]
  cwd: string
  env?: Record<string, string>
  cols?: number
  rows?: number
  labels?: Record<string, string>
}

export type SessionsOptions = {
  renderer: CliRenderer
  instanceId: string
  companion: CompanionCommand
  transport: SessionTransportFactory
  theme: FxnkThemeResolution
  /** The Runtime's own environment; a child gets this with the private variables removed. */
  environment?: NodeJS.ProcessEnv
  onExit: (name: string, exit: SessionExit) => void
  /** Debounced: output or a title reached this Session's screen. */
  onChanged: (name: string, title: string) => void
  /** A Session's transport was lost or came back. */
  onState: (name: string, state: "live" | "unreachable") => void
  /** A Session appeared, went away, or changed enough that the Layout must be re-applied. */
  onRoster: () => void
  /** Where a failure with no caller to tell goes; never the drawn screen. */
  report?: (line: string) => void
}

/**
 * One Session as smolmux holds it: the emulator its bytes land in, and what the
 * Companion knows about the process behind them. The process and its PTY are
 * the transport's; this owns the rendering side and the bytes between.
 */
class Session {
  readonly terminal: PaneTerminalRenderable
  title = ""
  private currentState: "live" | "unreachable" = "live"

  /** Reported wherever it is set, so a client never has to poll to learn it. */
  get state(): "live" | "unreachable" {
    return this.currentState
  }

  set state(next: "live" | "unreachable") {
    if (next === this.currentState) return
    this.currentState = next
    this.events.onState(this, next)
  }
  pid: number | null = null
  /** Null when adopted: the Companion reports a display string, not an argv. */
  argv: string[] | null = null
  labels: Record<string, string> = {}
  ended = false

  private transport: SessionTransport | null = null
  private detached = false
  /** The emulator's size as last laid out, for a transport attached later. */
  private size: TerminalSize = DEFAULT_SIZE
  private cursorReportAdapter = new CursorReportAdapter()
  private readonly titleParser: OscTitleParser

  constructor(
    renderer: CliRenderer,
    readonly identity: SessionIdentity,
    readonly cwd: string,
    readonly createdAt: number,
    private hostTheme: FxnkThemeResolution,
    size: TerminalSize,
    private readonly events: {
      onChanged: (session: Session) => void
      onExit: (session: Session, exit: SessionExit) => void
      onLost: (session: Session, error: Error) => void
      onState: (session: Session, state: "live" | "unreachable") => void
    },
  ) {
    this.size = size
    this.titleParser = new OscTitleParser({
      onTitle: (title) => {
        this.title = sanitizeTitle(title)
        this.events.onChanged(this)
      },
    })
    this.terminal = new PaneTerminalRenderable(renderer, {
      id: `pane-${identity.name}`,
      cols: size.cols,
      rows: size.rows,
      position: "absolute",
      left: 0,
      top: 0,
      width: size.cols,
      height: size.rows,
      visible: false,
      maxScrollback: MAX_SCROLLBACK_BYTES,
      onData: (data, source) => {
        const transport = this.transport
        if (!transport || this.ended) return
        transport.write(source === "response" ? this.cursorReportAdapter.toPty(data) : data)
      },
      onTerminalResize: (cols, rows) => {
        this.size = { cols: Math.max(1, cols), rows: Math.max(1, rows) }
        this.transport?.resize(this.size)
      },
    })
    this.terminal.applyHostTheme(hostTheme)
  }

  /**
   * The size the emulator is actually at: the one it was created with until a
   * Pane lays it out, and that Pane's from then on. Never the renderable's own
   * dimensions — a Pane that has not been drawn yet reports one cell, and a
   * transport opened at that size would tell its PTY the screen is 1x1.
   */
  get currentSize(): TerminalSize {
    return { cols: Math.max(1, this.size.cols), rows: Math.max(1, this.size.rows) }
  }

  get connected(): boolean {
    return this.transport !== null
  }

  /**
   * Take a transport, first or replacement. Bound before anything else so
   * the restore it answers the attach with has somewhere to land; the
   * emulator resets at its `RestoreBegin`, so a replacement replays onto a
   * clean screen rather than over what the lost transport left.
   */
  adopt(transport: SessionTransport): void {
    if (this.detached || this.ended) {
      transport.detach()
      return
    }
    this.transport?.detach()
    this.transport = transport
    this.state = "live"
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
    // The transport was opened at the size the emulator had when it was asked
    // for; the layout pass has usually run since, and its resize found no
    // transport to tell. A size that has not changed is a no-op at the PTY.
    transport.resize(this.currentSize)
  }

  updateHostTheme(resolution: FxnkThemeResolution): void {
    this.hostTheme = resolution
    this.terminal.applyHostTheme(resolution)
  }

  /** Let go of the process without ending it, and take the emulator down. */
  destroy(): void {
    this.detach()
    this.terminal.blur()
    this.terminal.destroy()
  }

  detach(): void {
    this.detached = true
    this.transport?.detach()
    this.transport = null
  }

  capture(scrollback = 0): Capture {
    const size = this.currentSize
    const screen = this.terminal.captureScreen(size.cols, size.rows, scrollback)
    return {
      name: this.identity.name,
      lines: screen.lines,
      screen_start: screen.screenStart,
      cols: screen.columns,
      rows: screen.rows,
      cursor: { x: screen.cursor.x, y: screen.cursor.y, visible: screen.cursor.visible },
      title: this.title,
      state: this.state,
    }
  }

  /**
   * Deliver semantic input as a human at this Session's keyboard would.
   *
   * The emulator encodes, because it is the only thing that knows which modes
   * this Session turned on, and `handleKeyPress`/`handlePaste` put the bytes on
   * exactly the path a human's keystroke takes: out through `onData` to the
   * transport. A left button-down cannot steal the keyboard here because a
   * Pane's `focus()` is gated on the Stage's word.
   *
   * `origin` is the Pane's top-left cell, or null when no Pane shows this
   * Session. The batch is checked before any of it is applied, so a call that
   * cannot be delivered whole delivers nothing.
   */
  input(events: readonly InputEvent[], origin: PaneOrigin | null): void {
    // Nothing carries input to the child without a transport, and the
    // emulator's own data callback drops it silently, so a call that got this
    // far would answer success for bytes that went nowhere. A caller cannot
    // preflight this with session.list either: the transport can drop between
    // the two calls, and only here are the check and the write together.
    if (this.transport === null || this.ended) {
      throw new ApiFailure(
        "conflict",
        `Session ${this.identity.name} is ${this.ended ? "gone" : "unreachable"}: input would be dropped rather than delivered`,
      )
    }
    for (const event of events) {
      if ("mouse" in event) {
        if (origin === null) {
          throw new ApiFailure(
            "not_found",
            `no Pane shows Session ${this.identity.name}: mouse input needs the coordinates a Pane gives it`,
          )
        }
        if (event.mouse.action === "scroll" && event.mouse.scroll === undefined) {
          throw new ApiFailure("invalid_params", "a scroll needs a direction and a delta")
        }
        continue
      }
      if ("key" in event && !isNamedKey(event.key) && [...event.key].length !== 1) {
        throw new ApiFailure("invalid_params", `not a key: ${event.key}`)
      }
    }

    for (const event of events) {
      if ("text" in event) {
        for (const key of keyEventsForText(event.text)) this.terminal.handleKeyPress(key)
      } else if ("paste" in event) {
        this.terminal.handlePaste(new PasteEvent(new TextEncoder().encode(event.paste)))
      } else if ("mouse" in event) {
        const delivery = mouseDeliveryFor(event.mouse, origin as PaneOrigin)
        this.terminal.processMouseEvent(new MouseEvent(this.terminal, delivery))
      } else {
        this.terminal.handleKeyPress(keyEventFor(event))
      }
    }
  }

  view(shown: boolean): SessionView {
    const size = this.currentSize
    return {
      name: this.identity.name,
      pid: this.pid,
      cwd: this.cwd,
      argv: this.argv,
      created_at: this.createdAt,
      title: this.title,
      cols: size.cols,
      rows: size.rows,
      shown,
      state: this.state,
      labels: this.labels,
    }
  }

  private acceptOutput(data: Uint8Array): void {
    this.titleParser.push(data)
    const terminalData = this.cursorReportAdapter.toTerminal(data)
    if (terminalData.byteLength > 0) this.terminal.write(terminalData)
    this.events.onChanged(this)
  }

  /**
   * What the transport replays is the whole terminal, so the one here must
   * hold nothing first: not the screen, not the scrollback, not a cursor
   * query half-translated when the last transport dropped. The resolved
   * terminal-default background goes back on afterwards — the replay restores
   * what the process set, not smolmux's own terminal state.
   */
  private resetTerminal(): void {
    this.cursorReportAdapter = new CursorReportAdapter()
    this.terminal.write(TERMINAL_RESET)
    this.terminal.applyHostTheme(this.hostTheme)
  }

  private recordExit(status: SessionExit): void {
    if (this.ended) return
    const trailing = this.cursorReportAdapter.flushTerminalBytes()
    if (trailing.byteLength > 0) this.terminal.write(trailing)
    this.ended = true
    this.transport?.detach()
    this.transport = null
    this.events.onExit(this, status)
  }
}

/**
 * The Instance's roster: what Sessions exist, what holds them, and what
 * their screens say. It knows nothing about the Layout — the Stage asks it
 * for a Session's emulator by name.
 */
export class Sessions {
  private readonly sessions = new Map<string, Session>()
  private readonly changeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private theme: FxnkThemeResolution
  private shuttingDown = false
  /** Session names in a Pane of the current Layout. */
  private shownNames = new Set<string>()
  private creationTail: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: SessionsOptions) {
    this.theme = options.theme
  }

  get names(): string[] {
    return [...this.sessions.keys()]
  }

  terminalFor(name: string): PaneTerminalRenderable | null {
    return this.sessions.get(name)?.terminal ?? null
  }

  setShown(names: Iterable<string>): void {
    this.shownNames = new Set(names)
    for (const [name, session] of this.sessions) {
      session.terminal.setHostSelectionEnabled(this.shownNames.has(name))
    }
  }

  list(): SessionView[] {
    return [...this.sessions.values()]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((session) => session.view(this.shownNames.has(session.identity.name)))
  }

  view(name: string): SessionView {
    return this.require(name).view(this.shownNames.has(name))
  }

  capture(name: string, scrollback = 0): Capture {
    return this.require(name).capture(scrollback)
  }

  input(name: string, events: readonly InputEvent[], origin: PaneOrigin | null): void {
    this.require(name).input(events, origin)
  }

  setTheme(resolution: FxnkThemeResolution): void {
    this.theme = resolution
    for (const session of this.sessions.values()) session.updateHostTheme(resolution)
  }

  /**
   * Find the Sessions this Instance's Companion still holds and attach them.
   * Labels are applied by the Companion before any client can see a session,
   * so they are the record: nothing of smolmux's own has to survive a crash.
   */
  async adopt(): Promise<{ adopted: number; unresolved: string[] }> {
    const entries = await this.options.companion.list()
    const unresolved: string[] = []
    const live: { name: string; entry: (typeof entries)[number] }[] = []
    for (const entry of entries) {
      if (entry.state === "exited") {
        if (looksLikeOwnedSession(entry.name, this.options.instanceId)) {
          await this.options.companion.forget(entry.name).catch(() => {})
        }
        continue
      }
      if (entry.state === "refused" || entry.state === "unreachable") {
        // Labels cannot be read, so ownership cannot be decided; the name can.
        if (looksLikeOwnedSession(entry.name, this.options.instanceId)) unresolved.push(entry.name)
        continue
      }
      const name = entry.state === "live" ? ownedSessionName(entry, this.options.instanceId) : null
      if (name) live.push({ name, entry })
    }

    live.sort((left, right) => (left.entry.createdAt ?? 0) - (right.entry.createdAt ?? 0))
    const prepared = live.map(({ name, entry }) => {
      const identity = sessionIdentity(this.options.instanceId, name, callerLabels(entry.labels))
      const session = this.add(identity, entry.cwd ?? "/", entry.createdAt ?? Date.now(), DEFAULT_SIZE)
      session.pid = entry.pid
      session.labels = { ...entry.labels }
      // An adopted Session's argv is not recoverable: the Companion reports a
      // shell-quoted display string, cut at 256 bytes.
      session.argv = null
      // The endpoint this listing already read, so the first attach does not
      // inspect the same session again.
      return { session, endpoint: entry.socketPath ? { socketPath: entry.socketPath } : undefined }
    })
    if (prepared.length > 0) this.options.onRoster()
    await forEachConcurrent(prepared, ADOPT_CONCURRENCY, async ({ session, endpoint }) => {
      if (this.shuttingDown) return
      try {
        const transport = await this.options.transport.attach(session.identity, session.currentSize, endpoint)
        if (this.shuttingDown || !this.sessions.has(session.identity.name)) {
          transport.detach()
          return
        }
        session.adopt(transport)
      } catch (error) {
        if (error instanceof SessionEndedError) {
          this.remove(session, error.exit ?? { code: null, signal: null, reason: "gone" })
          return
        }
        // One attach is not proof: a daemon mid-reap answers a moment later.
        // The same recovery a lost transport gets applies here.
        session.state = "unreachable"
        await this.recover(session, error instanceof Error ? error : new Error(String(error)))
      }
    })
    return { adopted: prepared.length, unresolved }
  }

  /**
   * Start a Session. Creation is serialized so two callers cannot claim the
   * same name, and the Companion arbitrates the rest.
   */
  create(request: SessionCreateRequest): Promise<SessionView> {
    const run = () => this.createOne(request)
    const result = this.creationTail.then(run, run)
    this.creationTail = result.then(
      () => {},
      () => {},
    )
    return result
  }

  private async createOne(request: SessionCreateRequest): Promise<SessionView> {
    if (this.shuttingDown) throw new ApiFailure("conflict", "smolmux is shutting down")
    if (this.sessions.has(request.name)) {
      throw new ApiFailure("conflict", `a Session named ${request.name} already exists`)
    }
    for (const key of Object.keys(request.labels ?? {})) {
      if ((RESERVED_LABELS as readonly string[]).includes(key)) {
        throw new ApiFailure("invalid_params", `label ${key} is smolmux's own`)
      }
    }
    const identity = sessionIdentity(this.options.instanceId, request.name, request.labels)
    const size: TerminalSize = {
      cols: request.cols ?? DEFAULT_SIZE.cols,
      rows: request.rows ?? DEFAULT_SIZE.rows,
    }
    const session = this.add(identity, request.cwd, Date.now(), size)
    session.labels = { ...identity.labels }
    session.argv = [...request.argv]
    try {
      const transport = await this.options.transport.start({
        identity,
        command: request.argv,
        cwd: request.cwd,
        env: childEnvironment(this.options.environment ?? process.env, request.env),
        size,
      })
      if (this.shuttingDown || !this.sessions.has(identity.name)) {
        transport.detach()
        throw new ApiFailure("conflict", "smolmux is shutting down")
      }
      session.adopt(transport)
    } catch (error) {
      if (error instanceof SessionUnreachableError) {
        // The process is running; only the way to it failed. It is recovered
        // like a lost transport, never removed.
        session.state = "unreachable"
        this.reportFailure(this.recover(session, error), `recovering ${identity.name}`)
        this.options.onRoster()
        return session.view(false)
      }
      this.dropQuietly(session)
      throw companionFailure(error)
    }
    this.options.onRoster()
    return session.view(this.shownNames.has(identity.name))
  }

  async kill(name: string): Promise<void> {
    const session = this.require(name)
    try {
      await this.options.companion.kill(session.identity.companionName)
    } catch (error) {
      throw companionFailure(error)
    }
  }

  /** Every Session ends; used by `instance.stop`. */
  /**
   * End every Session, and name the ones that would not go. A swallowed
   * failure here is a process nothing is managing any more: the Runtime that
   * held it exits, its Companion session stays live and labelled, and the
   * caller was told the Instance stopped.
   */
  async killAll(): Promise<string[]> {
    const survived: string[] = []
    await Promise.all(
      [...this.sessions.values()].map(async (session) => {
        try {
          await this.options.companion.kill(session.identity.companionName)
        } catch {
          survived.push(session.identity.name)
        }
      }),
    )
    return survived.sort()
  }

  /**
   * Refuse new work without tearing anything down. `instance.stop` seals
   * before it kills, so a create already queued behind another one cannot
   * start a process after the kills have gone out and never be killed.
   */
  seal(): void {
    this.shuttingDown = true
  }

  /** Take the seal off: a stop that could not finish leaves the Instance usable. */
  unseal(): void {
    this.shuttingDown = false
  }

  /** Let go of every process without ending it: the Companion keeps them. */
  shutdown(): void {
    this.shuttingDown = true
    for (const timer of this.changeTimers.values()) clearTimeout(timer)
    this.changeTimers.clear()
    for (const session of this.sessions.values()) session.destroy()
    this.sessions.clear()
  }

  private add(identity: SessionIdentity, cwd: string, createdAt: number, size: TerminalSize): Session {
    const session = new Session(this.options.renderer, identity, cwd, createdAt, this.theme, size, {
      onChanged: (changed) => this.noteChange(changed),
      onExit: (ended, status) => this.remove(ended, status),
      onLost: (lost, error) => this.reportFailure(this.recover(lost, error), `recovering ${lost.identity.name}`),
      onState: (changed, state) => this.options.onState(changed.identity.name, state),
    })
    this.sessions.set(identity.name, session)
    return session
  }

  /** Remove a Session that never started; no exit is reported for it. */
  private dropQuietly(session: Session): void {
    this.sessions.delete(session.identity.name)
    this.clearChangeTimer(session.identity.name)
    session.destroy()
    if (!this.shuttingDown) this.options.onRoster()
  }

  private remove(session: Session, exit: SessionExit): void {
    const name = session.identity.name
    if (!this.sessions.delete(name)) return
    this.clearChangeTimer(name)
    session.destroy()
    if (this.shuttingDown) return
    this.options.onExit(name, exit)
    this.options.onRoster()
  }

  /**
   * The transport dropped under a running process. Reach for it again: a live
   * session is re-attached and replays onto a reset emulator; one that ended
   * is removed exactly as an Exit would have; one that cannot be reached
   * after a few tries stays in the roster as unreachable, where the next
   * start's adoption will find it.
   */
  private async recover(session: Session, lost: Error): Promise<void> {
    for (let attempt = 0; attempt < RECOVERY_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RECOVERY_INTERVAL_MS))
      if (this.shuttingDown || !this.sessions.has(session.identity.name)) return
      try {
        const transport = await this.options.transport.attach(session.identity, session.currentSize)
        if (this.shuttingDown || !this.sessions.has(session.identity.name)) {
          transport.detach()
          return
        }
        session.adopt(transport)
        this.options.onRoster()
        return
      } catch (error) {
        if (error instanceof SessionEndedError) {
          this.remove(session, error.exit ?? { code: null, signal: null, reason: "gone" })
          return
        }
      }
    }
    if (this.shuttingDown || !this.sessions.has(session.identity.name)) return
    session.state = "unreachable"
    this.options.onRoster()
    this.options.report?.(`session ${session.identity.name} is unreachable: ${lost.message}`)
  }

  /**
   * Output reached a screen. One event per Session per debounce window: a
   * Session printing steadily must not turn into an event per frame.
   */
  private noteChange(session: Session): void {
    const name = session.identity.name
    if (this.shuttingDown || this.changeTimers.has(name)) return
    const timer = setTimeout(() => {
      this.changeTimers.delete(name)
      if (this.shuttingDown || !this.sessions.has(name)) return
      this.options.onChanged(name, session.title)
    }, CHANGE_DEBOUNCE_MS)
    // A pending change must never hold the process open.
    timer.unref?.()
    this.changeTimers.set(name, timer)
  }

  private clearChangeTimer(name: string): void {
    const timer = this.changeTimers.get(name)
    if (timer) clearTimeout(timer)
    this.changeTimers.delete(name)
  }

  /** A failure with nobody to tell goes to the log, never to the screen. */
  private reportFailure(work: Promise<unknown>, what: string): void {
    void work.catch((error) => {
      this.options.report?.(`${what} failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  private require(name: string): Session {
    const session = this.sessions.get(name)
    if (!session) throw new ApiFailure("not_found", `no Session named ${name}`)
    return session
  }
}

/** A child's environment: the Runtime's own, with smolmux's private variables removed, plus the caller's. */
export function childEnvironment(
  parent: NodeJS.ProcessEnv,
  requested: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined || PRIVATE_ENVIRONMENT.test(key)) continue
    env[key] = value
  }
  return { ...env, ...requested }
}

/** The labels a caller set, without smolmux's own. */
function callerLabels(labels: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(labels)) {
    if (!(RESERVED_LABELS as readonly string[]).includes(key)) result[key] = value
  }
  return result
}

function companionFailure(error: unknown): Error {
  if (error instanceof ApiFailure) return error
  const message = error instanceof Error ? error.message : String(error)
  return new ApiFailure("companion_error", message)
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
