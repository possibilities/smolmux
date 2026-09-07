import type { SessionIdentity } from "./session-identity.ts"

/**
 * The terminal seam: what a Session's renderer needs from whatever holds the
 * process and its PTY, and nothing about how it is held. Bytes go in and
 * out, the size follows the Pane, and the two ways it ends are told apart —
 * the process ending, with a status, against the transport itself ending,
 * which says nothing about the process at all.
 *
 * One implementation ships: the Companion's, in `companion-transport.ts`.
 * Tests keep a Bun PTY behind the same seam so the renderer can be exercised
 * without a Companion on the machine.
 */
export interface SessionTransport {
  readonly pid?: number

  /**
   * Wire the consumer. Whatever arrived before this call is delivered now,
   * in order, so a transport that was attached before its Session was
   * listening loses nothing.
   */
  bind(handlers: TransportHandlers): void
  write(bytes: Uint8Array): void
  resize(size: TerminalSize): void
  /** Stop watching. The process keeps running; nothing is sent to it. */
  detach(): void
}

export type TransportHandlers = {
  /** Terminal bytes from the process, restored or live. */
  output(bytes: Uint8Array): void
  /**
   * The transport is about to replay the terminal's state. The terminal
   * resets here, because what follows is the whole state, not a
   * continuation — and it happens on every attach, first or not.
   */
  restoreBegin(): void
  /** The replay is over; every byte after this is live. */
  ready(): void
  /** The process ended. Final output has already been delivered. */
  exit(status: SessionExit): void
  /**
   * The transport ended without an Exit: the connection dropped, the
   * daemon went away. The process may be running still; only asking can tell.
   */
  lost(error: Error): void
}

export type SessionExit = {
  /** null when the Companion could not read it. */
  code: number | null
  /** Non-zero when a signal ended it; null when unknown. */
  signal: number | null
  reason: string
}

export type TerminalSize = { cols: number; rows: number }

/** A Companion terminal socket a caller already knows about. */
export type SessionEndpoint = { socketPath: string }

/** Everything needed to start a Session's process. */
export type SessionStart = {
  identity: SessionIdentity
  /** argv, the executable first. */
  command: string[]
  cwd: string
  env: Record<string, string>
  size: TerminalSize
}

/**
 * Where Sessions come from. `start` is the only way a process is ever
 * started; `attach` reaches one that is already running, whether it outlived
 * the Runtime that started it or only lost its transport.
 */
export interface SessionTransportFactory {
  /**
   * Start the process and attach to it. Resolves once attached. Rejects with
   * `SessionUnreachableError` when the process was started but could not be
   * attached to — it is running, and the Session is to be recovered, not
   * removed — and with anything else when it was not started at all.
   */
  start(request: SessionStart): Promise<SessionTransport>
  /**
   * Attach to a running Session. Rejects with `SessionEndedError` when the
   * process has ended — with its status, when that is known — and with
   * anything else when it could not be reached, which says nothing about it.
   *
   * `endpoint` is a socket path a caller has just read, so adoption does not
   * ask about a Session it already looked up. It is a hint: ownership is
   * still proved on the connection itself, and a stale path falls back to
   * asking.
   */
  attach(identity: SessionIdentity, size: TerminalSize, endpoint?: SessionEndpoint): Promise<SessionTransport>
}

export class SessionEndedError extends Error {
  constructor(
    readonly identity: SessionIdentity,
    /** `null` when the end was observed but its status was not. */
    readonly exit: SessionExit | null,
  ) {
    super(
      exit
        ? `session ${identity.name} ended with ${exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? "unknown"}`}`
        : `session ${identity.name} is gone`,
    )
    this.name = "SessionEndedError"
  }
}

/** The process is running; only the transport to it failed. */
export class SessionUnreachableError extends Error {
  constructor(
    readonly identity: SessionIdentity,
    readonly cause: Error,
  ) {
    super(`session ${identity.name} is running but could not be reached: ${cause.message}`)
    this.name = "SessionUnreachableError"
  }
}

/** An environment as the transport needs it: every value a string. */
export function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value
  }
  return result
}

/**
 * Delivers handler calls in order, holding them until the consumer binds.
 * Shared by the transports so neither reimplements the backlog.
 */
export class HandlerRelay {
  private handlers: TransportHandlers | null = null
  private backlog: ((handlers: TransportHandlers) => void)[] = []
  private stopped = false

  bind(handlers: TransportHandlers): void {
    this.handlers = handlers
    const held = this.backlog
    this.backlog = []
    for (const deliver of held) {
      // A held handler may stop the relay (an Exit detaches); nothing after it goes out.
      if (this.stopped) return
      deliver(handlers)
    }
  }

  /** After this nothing is delivered: the consumer let go. */
  stop(): void {
    this.stopped = true
    this.backlog = []
  }

  emit(deliver: (handlers: TransportHandlers) => void): void {
    if (this.stopped) return
    if (this.handlers) deliver(this.handlers)
    else this.backlog.push(deliver)
  }
}

/** Ownership operations are separate from detaching a terminal consumer. */
export interface LocalProcessOwner extends SessionTransportFactory {
  terminate(identity: SessionIdentity): Promise<SessionExit>
  pause(identity: SessionIdentity, paused: boolean): Promise<void>
  close(): Promise<void>
}
