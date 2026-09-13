import { StdinParser, type StdinEvent, type KeyEvent } from "@opentui/core"
import { randomUUID } from "node:crypto"
import { CompanionConnection, type CloseReason } from "./companion-client.ts"
import { colorFgBgIsLight, type FxnkTheme, parseOsc11Response, themeModeReport } from "./host-palette.ts"
import { keyMatchesCombo, type Keybindings } from "./keybindings.ts"
import { PRESENTATION_MARKER_LENGTH, PRESENTATION_MARKER_PREFIX, readPresentationMarker } from "./presentation.ts"
import type { Params } from "./protocol.ts"
import { Tag, type Resize } from "./zmx-protocol.ts"

const CURSOR_CONCEAL = "\x1b[?25l"
const CURSOR_REVEAL = "\x1b[?25h"
const RESTORE_RESET = Buffer.from(`\x1bc${CURSOR_CONCEAL}`)
const SYNCHRONIZED_BEGIN = Buffer.from("\x1b[?2026h")
const SYNCHRONIZED_END = Buffer.from("\x1b[?2026l")
const PRESENTATION_BOUNDARY = /\x1bc|\x1b\[\?2026[hl]/gu
const MAX_HELD_PRESENTATION_BYTES = 32 * 1024 * 1024
const BRACKETED_PASTE_START = new TextEncoder().encode("\x1b[200~")
const BRACKETED_PASTE_END = new TextEncoder().encode("\x1b[201~")
const TERMINAL_CLEANUP = [
  "\x1b[?2026l", // synchronized output off
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l", // mouse reporting off
  "\x1b[?2004l", // bracketed paste off
  "\x1b[<u", // pop Kitty keyboard mode
  "\x1b[?7h", // autowrap on
  "\x1b[0m", // attributes reset
  "\x1b[?1049l", // restore the shell screen and cursor position first
  CURSOR_REVEAL, // reveal only after terminal handback
].join("")

const MODIFIER_ONLY_KEYS = new Set(["shift", "control", "ctrl", "alt", "meta", "option", "super", "hyper"])

/** How long this terminal is given to answer the one OSC 11 background query. */
export const THEME_SAMPLE_TIMEOUT_MS = 200

type SampledTheme = { theme: FxnkTheme; background: string | null }

export type TerminalClientOptions = {
  socketPath: string
  keybindings: Keybindings
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream
  /** Release temporary startup signal ownership once this Client owns it. */
  onSignalHandlersInstalled?: () => void
  /** Replace the stale attach Restore with a Runtime-rendered current frame. */
  present?: (request: Params<"client.present">) => Promise<void>
}

type ClientOutcome = { exitCode: number; error?: Error }

/**
 * Keep the shell's surface intact through a cold Runtime bootstrap. A real
 * Restore still starts from RIS, but an empty Restore emits nothing: OpenTUI
 * can perform its invisible probes before atomically replacing the screen.
 */
export class ClientOutputRelay {
  private restorePending = false
  private presentationToken: string | null = null
  private held: Buffer[] = []
  private fresh: Buffer[] = []
  private heldBytes = 0
  private freshTail = Buffer.alloc(0)
  private markerMatched = false
  private scanning = Buffer.alloc(0)

  constructor(private readonly write: (bytes: Uint8Array) => void) {}

  beginRestore(): void {
    this.restorePending = true
  }

  awaitPresentation(token: string): void {
    this.presentationToken = token
  }

  output(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return
    this.scanning = Buffer.concat([this.scanning, Buffer.from(bytes)])
    for (;;) {
      const marker = this.scanning.indexOf(PRESENTATION_MARKER_PREFIX)
      if (marker === -1) {
        const keep = markerPrefixSuffix(this.scanning)
        this.deliver(this.scanning.subarray(0, this.scanning.byteLength - keep))
        this.scanning = this.scanning.subarray(this.scanning.byteLength - keep)
        return
      }
      this.deliver(this.scanning.subarray(0, marker))
      this.scanning = this.scanning.subarray(marker)
      if (this.scanning.byteLength < PRESENTATION_MARKER_LENGTH) return
      const token = readPresentationMarker(this.scanning.subarray(0, PRESENTATION_MARKER_LENGTH))
      if (!token) {
        this.deliver(this.scanning.subarray(0, 1))
        this.scanning = this.scanning.subarray(1)
        continue
      }
      this.scanning = this.scanning.subarray(PRESENTATION_MARKER_LENGTH)
      if (token === this.presentationToken) this.markerMatched = true
    }
  }

  ready(): void {
    // No Restore output means this is a fresh, blank Runtime. Its alternate
    // screen is the reset, so clearing the physical Client here would only
    // expose an empty screen before the first frame exists.
    if (!this.presentationToken) this.restorePending = false
  }

  private deliver(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return
    if (this.presentationToken) {
      if (this.heldBytes + bytes.byteLength > MAX_HELD_PRESENTATION_BYTES) {
        throw new Error("terminal presentation exceeded 32 MiB before its first complete frame")
      }
      const copy = Buffer.from(bytes)
      this.heldBytes += copy.byteLength
      if (!this.markerMatched) {
        this.held.push(copy)
        return
      }
      const scanned = Buffer.concat([this.freshTail, copy])
      const frameEnd = scanned.indexOf(SYNCHRONIZED_END)
      if (frameEnd === -1) {
        this.fresh.push(copy)
        this.freshTail = scanned.subarray(Math.max(0, scanned.byteLength - SYNCHRONIZED_END.byteLength + 1))
        return
      }
      const throughEnd = frameEnd + SYNCHRONIZED_END.byteLength - this.freshTail.byteLength
      this.fresh.push(copy.subarray(0, throughEnd))
      const remainder = copy.subarray(throughEnd)
      this.openPresentation()
      this.deliver(remainder)
      return
    }
    if (this.restorePending) {
      this.restorePending = false
      this.write(Buffer.concat([RESTORE_RESET, bytes]))
    } else this.write(bytes)
  }

  private openPresentation(): void {
    this.presentationToken = null
    this.markerMatched = false
    this.restorePending = false
    const held = Buffer.concat(this.held).toString("latin1").replaceAll(PRESENTATION_BOUNDARY, "")
    const fresh = this.fresh
    this.held = []
    this.fresh = []
    this.heldBytes = 0
    this.freshTail = Buffer.alloc(0)
    // RIS and old synchronized-frame boundaries cannot escape early because
    // nothing is written until the first post-marker frame has ended. Release
    // the sanitized Restore and complete fresh frame in one physical write.
    this.write(Buffer.concat([RESTORE_RESET, SYNCHRONIZED_BEGIN, Buffer.from(held, "latin1"), ...fresh]))
  }
}

function markerPrefixSuffix(bytes: Buffer): number {
  const maximum = Math.min(bytes.byteLength, PRESENTATION_MARKER_PREFIX.byteLength - 1)
  for (let length = maximum; length > 0; length -= 1) {
    if (bytes.subarray(bytes.byteLength - length).equals(PRESENTATION_MARKER_PREFIX.subarray(0, length))) return length
  }
  return 0
}

/** Conceal as soon as a terminal invocation commits to opening the TUI. */
export function concealClientCursor(stdout: Pick<NodeJS.WriteStream, "write"> = process.stdout): void {
  stdout.write(CURSOR_CONCEAL)
}

/** Undo early concealment when startup fails before the normal Client cleanup. */
export function revealClientCursor(stdout: Pick<NodeJS.WriteStream, "write"> = process.stdout): void {
  stdout.write(CURSOR_REVEAL)
}

/**
 * Relay one physical terminal to the shared Runtime. Rendering remains the
 * Runtime's byte stream; this layer owns only host terminal cleanup, resize,
 * and Client-local Detach interception.
 */
export async function runTerminalClient(options: TerminalClientOptions): Promise<number> {
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  const connection = await CompanionConnection.connect(options.socketPath, { client: "smolmux-client" })
  const completion = Promise.withResolvers<ClientOutcome>()
  let completed = false
  let sawExit = false
  let inputFilter: ClientInputFilter | null = null
  let inputStarted = false
  const wasRaw = Boolean(stdin.isRaw)
  const outputRelay = new ClientOutputRelay((bytes) => stdout.write(bytes))

  const finish = (outcome: ClientOutcome): void => {
    if (completed) return
    completed = true
    completion.resolve(outcome)
  }
  const detach = (): void => finish({ exitCode: 0 })
  // EventEmitter and parser timer callbacks run outside this async function's
  // try/finally. Turn synchronous transport failures into its normal outcome.
  const guard = (action: () => void): void => {
    try {
      action()
    } catch (error) {
      finish({ exitCode: 1, error: error instanceof Error ? error : new Error(String(error)) })
    }
  }
  const onData = (bytes: Buffer): void => guard(() => inputFilter?.push(bytes))
  const onEnd = (): void => detach()
  const onResize = (): void => {
    if (!connection.isClosed) guard(() => connection.resize(terminalSize(stdout)))
  }
  const signalHandlers = new Map<NodeJS.Signals, () => void>()

  connection.onRestoreBegin(() => outputRelay.beginRestore())
  connection.onOutput((bytes) => guard(() => outputRelay.output(bytes)))
  connection.onFrame((frame) => {
    if (frame.tag === Tag.Resize && frame.payload.byteLength === 0 && !connection.isClosed) {
      guard(() => connection.resize(terminalSize(stdout)))
    }
  })
  connection.onExit((status) => {
    sawExit = true
    if (status.code === null || status.signal === null) {
      finish({ exitCode: 1, error: new Error("the Runtime ended; its exit status is unknown after a Companion handoff") })
      return
    }
    finish({ exitCode: status.signal ? 128 + status.signal : status.code })
  })
  connection.onClose((reason) => {
    if (completed || sawExit || reason.kind === "detached") return
    finish({ exitCode: 1, error: closeError(reason) })
  })

  let theme: SampledTheme | null = null
  const ready = Promise.withResolvers<void>()
  let readyHandled = false
  connection.onReady(() => {
    if (readyHandled) return
    readyHandled = true
    // The Runtime is headless until a terminal arrives, so this Client owns
    // the first exact background sample. A presentation-capable caller sends
    // size and palette together; an older caller retains the theme trigger.
    outputRelay.ready()
    if (options.present) {
      void options.present({
        token: presentationToken!, ...presentationSize!,
        theme: theme?.theme ?? null, background: theme?.background ?? null,
      }).then(() => ready.resolve(), (error) => finish({ exitCode: 1, error: error instanceof Error ? error : new Error(String(error)) }))
    } else {
      const sampled = theme
      if (sampled && !connection.isClosed) guard(() => connection.write(themeModeReport(sampled.theme)))
      ready.resolve()
    }
  })

  let presentationToken: string | null = null
  let presentationSize: Resize | null = null
  try {
    stdin.setRawMode?.(true)
    theme = await sampleTerminalTheme(stdin, stdout)
    presentationSize = terminalSize(stdout)
    if (options.present) {
      presentationToken = randomUUID()
      outputRelay.awaitPresentation(presentationToken)
    }
    inputFilter = new ClientInputFilter(
      options.keybindings,
      (bytes) => {
        if (!connection.isClosed) guard(() => connection.write(bytes))
      },
      detach,
    )
    stdin.on("data", onData)
    stdin.once("end", onEnd)
    stdout.on("resize", onResize)
    inputStarted = true
    stdin.resume()

    for (const [signal, exitCode] of [
      ["SIGHUP", 129],
      ["SIGINT", 130],
      ["SIGQUIT", 131],
      ["SIGTERM", 143],
    ] as const) {
      const handler = () => finish({ exitCode })
      signalHandlers.set(signal, handler)
      process.once(signal, handler)
    }
    options.onSignalHandlersInstalled?.()

    connection.attach(presentationSize)
    await Promise.race([ready.promise, completion.promise])

    const outcome = await completion.promise
    if (outcome.error) throw outcome.error
    return outcome.exitCode
  } finally {
    if (inputStarted) {
      stdin.off("data", onData)
      stdin.off("end", onEnd)
      stdout.off("resize", onResize)
    }
    for (const [signal, handler] of signalHandlers) process.off(signal, handler)
    try {
      inputFilter?.destroy()
      if (!connection.isClosed) {
        // Completion already chose the caller-visible outcome. The Companion
        // may have delivered Runtime Exit while its socket was closing, so
        // this courtesy Detach is best-effort and cannot rewrite that outcome.
        try { connection.detach() }
        catch {
          try { connection.close() }
          catch { /* Terminal restoration still owns this completed path. */ }
        }
      }
    } finally {
      try {
        stdin.pause()
        stdin.setRawMode?.(wasRaw)
      } finally {
        stdout.write(TERMINAL_CLEANUP)
      }
    }
  }
}

/** Stateful because a prefix must not reach the shared Runtime until the next
 * key proves it was not this Client's Detach command. */
export class ClientInputFilter {
  private readonly parser: StdinParser
  private heldPrefix: Uint8Array | null = null

  constructor(
    private readonly keybindings: Keybindings,
    private readonly forward: (bytes: Uint8Array) => void,
    private readonly detach: () => void,
  ) {
    this.parser = new StdinParser({
      useKittyKeyboard: true,
      protocolContext: { kittyKeyboardEnabled: true },
      onTimeoutFlush: () => this.drain(),
    })
  }

  push(bytes: Uint8Array): void {
    this.parser.push(bytes)
    this.drain()
  }

  destroy(): void {
    this.parser.destroy()
  }

  private drain(): void {
    this.parser.drain((event) => this.accept(event))
  }

  private accept(event: StdinEvent): void {
    if (event.type !== "key") {
      // Terminal responses must never wait behind a human's half-entered
      // prefix. Reordering one response ahead of that held key is harmless;
      // sending the prefix would make a later local Detach globally armed.
      this.forward(eventBytes(event))
      return
    }

    const bytes = eventBytes(event)
    const key = event.key as KeyEvent
    if (this.heldPrefix) {
      if (MODIFIER_ONLY_KEYS.has(event.key.name.toLowerCase())) return
      if (
        event.key.eventType !== "release" &&
        this.keybindings.detach.some(
          (binding) => binding.trigger === "prefix" && keyMatchesCombo(key, binding.combo),
        )
      ) {
        this.heldPrefix = null
        this.detach()
        return
      }
      const prefix = this.heldPrefix
      this.heldPrefix = null
      this.forward(concatBytes(prefix, bytes))
      return
    }

    if (
      event.key.eventType !== "release" &&
      this.keybindings.detach.some(
        (binding) => binding.trigger === "direct" && keyMatchesCombo(key, binding.combo),
      )
    ) {
      this.detach()
      return
    }
    if (event.key.eventType !== "release" && keyMatchesCombo(key, this.keybindings.prefix)) {
      this.heldPrefix = bytes
      return
    }
    this.forward(bytes)
  }
}

function eventBytes(event: StdinEvent): Uint8Array {
  switch (event.type) {
    case "key":
    case "mouse":
      return new TextEncoder().encode(event.raw)
    case "response":
      return new TextEncoder().encode(event.sequence)
    case "paste":
      return concatBytes(BRACKETED_PASTE_START, event.bytes, BRACKETED_PASTE_END)
  }
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

function terminalSize(stdout: NodeJS.WriteStream): Resize {
  return {
    cols: clampDimension(stdout.columns),
    rows: clampDimension(stdout.rows),
  }
}

function clampDimension(value: number | undefined): number {
  return Math.max(1, Math.min(0xffff, value || 1))
}

/**
 * Ask this terminal for its background before any relaying begins, so the
 * reply cannot race the Runtime's byte stream. `SMOLMUX_THEME` fixes it without
 * a query, exactly as it fixes the Runtime's.
 */
async function sampleTerminalTheme(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = THEME_SAMPLE_TIMEOUT_MS,
): Promise<SampledTheme | null> {
  const override = env.SMOLMUX_THEME?.toLowerCase()
  if (override === "light" || override === "dark") return { theme: override, background: null }
  if (!stdin.isTTY || !stdout.isTTY) return null

  const { promise, resolve } = Promise.withResolvers<SampledTheme | null>()
  let buffer = ""
  let settled = false
  const finish = (theme: SampledTheme | null): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    stdin.off("data", onData)
    resolve(theme)
  }
  const onData = (chunk: Buffer): void => {
    buffer = (buffer + chunk.toString("latin1")).slice(-256)
    const start = buffer.lastIndexOf("\x1b]11;")
    if (start === -1) return
    const parsed = parseOsc11Response(buffer.slice(start))
    if (parsed) finish({ theme: parsed.light ? "light" : "dark", background: parsed.hex })
  }
  const timer = setTimeout(() => finish(colorFgBgIsLight(env.COLORFGBG) ? { theme: "light", background: null } : null), Math.max(0, timeoutMs))
  stdin.on("data", onData)
  stdin.resume()
  try {
    stdout.write("\x1b]11;?\x1b\\")
  } catch {
    finish(null)
  }
  const theme = await promise
  stdin.pause()
  return theme
}

function closeError(reason: CloseReason): Error {
  return reason.kind === "error" ? reason.error : new Error("the smolmux Runtime closed its terminal connection")
}
