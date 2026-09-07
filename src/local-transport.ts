import { closeSync } from "node:fs"
import { access } from "node:fs/promises"
import { constants } from "node:fs"
import { join } from "node:path"
import type { Subprocess } from "bun"
import { installedDirectory } from "./zmx-environment.ts"
import { SessionEndedError, type LocalProcessOwner, type SessionExit, type SessionStart, type SessionTransport, type TerminalSize, type TransportHandlers } from "./session-transport.ts"
import type { SessionIdentity } from "./session-identity.ts"

const MAX_BYTES = 32 * 1024 * 1024
const MAX_FRAMES = 4096
const MAX_PAYLOAD = 65536
const CONTROL_TIMEOUT = 5000
const DRAIN_TIMEOUT = 30000

type Delivery = { bytes: number; deliver: (handlers: TransportHandlers) => void }

export async function resolveLocalHelper(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const candidates = env.SMOLMUX_LOCAL_PTY_PATH
    ? [env.SMOLMUX_LOCAL_PTY_PATH]
    : [installedDirectory() ? join(installedDirectory()!, "smolmux-local-pty") : null, Bun.which("smolmux-local-pty", { PATH: env.PATH ?? "" })].filter((path): path is string => !!path)
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return path }
    catch { /* The next installation location may have it. */ }
  }
  throw new Error("local PTY helper is missing; run scripts/install.sh --install --local-only")
}

/** Ephemeral ownership through a pipe-bound helper; detaching never terminates. */
export class LocalPtyOwner implements LocalProcessOwner {
  private readonly processes = new Map<string, LocalTransport>()
  private closing = false
  constructor(private readonly options: { helper?: string; report: (line: string) => void } ) {}

  async start(request: SessionStart): Promise<SessionTransport> {
    if (this.closing) throw new Error("local PTY owner is closing")
    const helper = this.options.helper ?? await resolveLocalHelper()
    if (this.closing) throw new Error("local PTY owner is closing")
    const transport = new LocalTransport(helper, request, this.options.report)
    this.processes.set(request.identity.id, transport)
    void transport.done.finally(() => this.processes.delete(request.identity.id)).catch((error) => this.options.report(`local Session ${request.identity.name}: ${message(error)}`))
    try { await transport.started; return transport }
    catch (error) { transport.abandon(); await deadline(transport.done, 7000, () => transport.abandon(), "local PTY startup cleanup timed out").catch(() => {}); throw error }
  }
  async attach(identity: SessionIdentity): Promise<SessionTransport> { throw new SessionEndedError(identity, null) }
  async terminate(identity: SessionIdentity): Promise<SessionExit> {
    const transport = this.processes.get(identity.id)
    if (!transport) return { code: null, signal: null, reason: "gone" }
    return transport.terminate()
  }
  async pause(identity: SessionIdentity, paused: boolean): Promise<void> {
    const transport = this.processes.get(identity.id)
    if (!transport) throw new SessionEndedError(identity, null)
    await transport.control(paused ? "S" : "C")
  }
  async close(): Promise<void> {
    this.closing = true
    const results = await Promise.allSettled([...this.processes.values()].map((transport) => transport.terminate()))
    const failures = results.filter((result) => result.status === "rejected")
    if (failures.length) throw new Error(`could not terminate ${failures.length} local Sessions`)
  }
}

class LocalTransport implements SessionTransport {
  pid = 0
  readonly started: Promise<void>
  readonly done: Promise<SessionExit>
  private readonly start = Promise.withResolvers<void>()
  private readonly process: Subprocess<"pipe", "pipe", "pipe">
  private lifetime: number | null
  private handlers: TransportHandlers | null = null
  private held: Delivery[] = []
  private heldBytes = 0
  private detached = false
  private failure: Error | null = null
  private status: SessionExit | null = null
  private outgoing: Buffer[] = []
  private queuedBytes = 0
  private flushing = false
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private terminating: Promise<SessionExit> | null = null

  constructor(helper: string, request: SessionStart, private readonly report: (line: string) => void) {
    this.started = deadline(this.start.promise, 5000, () => this.fail(new Error("local PTY helper startup timed out")), "local PTY helper startup timed out")
    this.started.catch(() => {})
    this.process = Bun.spawn([helper, String(request.size.cols), String(request.size.rows), request.cwd, ...request.command], {
      env: request.env, stdio: ["pipe", "pipe", "pipe", "socket-fd"],
    })
    this.lifetime = this.process.stdio[3] ?? null
    if (this.lifetime === null) throw new Error("local PTY helper has no liveness descriptor")
    const read = this.read().catch((error) => this.fail(asError(error)))
    const diagnostics = this.readDiagnostics().catch((error) => this.report(`local PTY diagnostics: ${message(error)}`))
    const child = this.process
    this.done = (async () => {
      const helperCode = await child.exited
      await read
      await diagnostics
      this.closeLifetime()
      if (!this.status) {
        const error = this.failure ?? new Error("local PTY helper ended without confirming process exit")
        this.fail(error)
        throw error
      }
      if (this.failure || helperCode !== 0) throw this.failure ?? new Error(`local PTY helper failed with code ${helperCode}`)
      this.rejectPending(new Error("local Session ended"))
      return this.status
    })()
    this.done.catch(() => {})
  }
  bind(handlers: TransportHandlers): void {
    this.handlers = handlers
    const held = this.held; this.held = []; this.heldBytes = 0
    for (const event of held) { if (this.detached) return; event.deliver(handlers) }
  }
  write(bytes: Uint8Array): void {
    this.assertWritable()
    // The transport retains one bounded user-space queue; FileSink holds only
    // the current frame while its explicit flush is awaited.
    for (let offset = 0; offset < bytes.byteLength; offset += MAX_PAYLOAD) this.send("I", 0, bytes.subarray(offset, offset + MAX_PAYLOAD))
  }
  resize(size: TerminalSize): void {
    if (this.detached || this.status || this.failure) return
    const payload = Buffer.alloc(8); payload.writeUInt32BE(size.cols); payload.writeUInt32BE(size.rows, 4)
    this.send("R", 0, payload)
  }
  detach(): void { this.detached = true; this.handlers = null; this.held = []; this.heldBytes = 0 }
  abandon(): void { this.closeLifetime() }
  async terminate(): Promise<SessionExit> {
    this.terminating ??= (async () => {
      if (!this.status) {
        if (this.failure) this.closeLifetime()
        else this.send("K", this.nextId++)
      }
      return deadline(this.done, 7000, () => this.closeLifetime(), "local Session termination timed out")
    })()
    return this.terminating
  }
  control(op: "S" | "C"): Promise<void> {
    this.assertWritable()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("local PTY control acknowledgment timed out")), CONTROL_TIMEOUT)
      this.pending.set(id, { resolve, reject, timer })
      try { this.send(op, id) }
      catch (error) { this.fail(asError(error)) }
    })
  }
  private send(op: string, id: number, payload: Uint8Array = new Uint8Array()): void {
    if (this.failure) throw this.failure
    const frame = Buffer.alloc(9 + payload.byteLength)
    frame[0] = op.charCodeAt(0); frame.writeUInt32BE(id, 1); frame.writeUInt32BE(payload.byteLength, 5); frame.set(payload, 9)
    if (this.outgoing.length >= MAX_FRAMES || this.queuedBytes + frame.length > MAX_BYTES) {
      const error = new Error("local PTY outbound queue exceeded its bound"); this.fail(error); throw error
    }
    this.outgoing.push(frame); this.queuedBytes += frame.length
    if (!this.flushing) {
      this.flushing = true
      void this.flush().catch((error) => this.fail(asError(error)))
    }
  }
  private async flush(): Promise<void> {
    try {
      while (this.outgoing.length && !this.failure) {
        const frame = this.outgoing[0]!
        this.process.stdin.write(frame)
        await deadline(Promise.resolve(this.process.stdin.flush()), DRAIN_TIMEOUT, () => this.closeLifetime(), "local PTY input drain timed out")
        if (this.failure) throw this.failure
        this.outgoing.shift(); this.queuedBytes -= frame.length
      }
    } finally { this.flushing = false }
  }
  private async read(): Promise<void> {
    for await (const chunk of this.process.stdout) {
      this.buffer = Buffer.concat([this.buffer, chunk])
      if (this.buffer.length > MAX_BYTES) throw new Error("local PTY input frame exceeded its bound")
      while (this.buffer.length >= 9) {
        const size = this.buffer.readUInt32BE(5)
        if (size > MAX_PAYLOAD) throw new Error("oversized local PTY response")
        if (this.buffer.length < 9 + size) break
        const op = String.fromCharCode(this.buffer[0]!), id = this.buffer.readUInt32BE(1)
        const payload = this.buffer.subarray(9, 9 + size)
        this.buffer = this.buffer.subarray(9 + size)
        this.frame(op, id, payload)
      }
    }
    if (this.buffer.length) throw new Error("truncated local PTY response")
  }
  private frame(op: string, id: number, payload: Buffer): void {
    switch (op) {
      case "P":
        if (payload.length !== 4 || this.pid) throw new Error("invalid local PTY start")
        this.pid = payload.readUInt32BE(); this.start.resolve(); return
      case "O": {
        const bytes = Uint8Array.from(payload)
        this.deliver({ bytes: bytes.length, deliver: (handlers) => handlers.output(bytes) }); return
      }
      case "A": {
        const pending = this.pending.get(id)
        if (!pending) throw new Error("unknown local PTY acknowledgment")
        clearTimeout(pending.timer); this.pending.delete(id); pending.resolve(); return
      }
      case "E": {
        const error = new Error(payload.toString("utf8")); this.fail(error); return
      }
      case "X": {
        if (payload.length !== 12 || this.status) throw new Error("invalid local PTY exit")
        const code = payload.readInt32BE(), signal = payload.readInt32BE(4)
        this.status = { code: code < 0 ? null : code, signal: signal < 0 ? null : signal, reason: payload.readUInt32BE(8) ? "exec_failure" : signal > 0 ? "signal" : "natural" }
        this.deliver({ bytes: 0, deliver: (handlers) => handlers.exit(this.status!) })
        return
      }
      default: throw new Error("unknown local PTY frame")
    }
  }
  private async readDiagnostics(): Promise<void> {
    let count = 0
    for await (const chunk of this.process.stderr) {
      count += chunk.byteLength
      if (count <= MAX_PAYLOAD) this.report(`local PTY helper: ${new TextDecoder().decode(chunk)}`)
    }
  }
  private deliver(event: Delivery): void {
    if (this.detached) return
    if (this.handlers) { event.deliver(this.handlers); return }
    if (this.held.length >= (event.bytes === 0 ? MAX_FRAMES : MAX_FRAMES - 1) || this.heldBytes + event.bytes > MAX_BYTES) { this.fail(new Error("local PTY pre-listener output exceeded its bound")); return }
    this.held.push(event); this.heldBytes += event.bytes
  }
  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    this.report(`local PTY failed: ${error.message}`)
    this.start.reject(error); this.rejectPending(error)
    this.outgoing = []; this.queuedBytes = 0
    this.closeLifetime()
    if (!this.status) {
      // Lost/exit must still reach the consumer when ordinary output filled
      // its pre-bind allowance. That screen is incomplete and cannot replay.
      this.held = []; this.heldBytes = 0
      this.deliver({ bytes: 0, deliver: (handlers) => handlers.lost(error) })
    }
  }
  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }
  private closeLifetime(): void {
    if (this.lifetime === null) return
    try { closeSync(this.lifetime) } catch { /* Process already closed it. */ }
    this.lifetime = null
  }
  private assertWritable(): void {
    if (this.failure) throw this.failure
    if (this.status || this.detached) throw new Error("local Session is closed")
  }
}
function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)) }
function message(error: unknown): string { return asError(error).message }
async function deadline<T>(work: Promise<T>, ms: number, expire: () => void, text: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => { expire(); reject(new Error(text)) }, ms) })]) }
  finally { clearTimeout(timer) }
}
