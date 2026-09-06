import { chmodSync } from "node:fs"
import { userInfo } from "node:os"
import type { Socket } from "bun"
import { FrameLimitError, LineBuffer } from "./line-buffer.ts"
import { acquireExclusiveLock, type HeldLock } from "./file-lock.ts"
import {
  ApiFailure,
  encodeFrame,
  type ErrorCode,
  type EventFrame,
  failureFrame,
  frameNestingDepth,
  isMethod,
  MAX_LAYOUT_DEPTH,
  METHODS,
  matchesEvent,
  type Method,
  requestSchema,
  successFrame,
} from "./protocol.ts"
import { checkEventSocketOwnership, isAddressInUse, listenerAnswers, removeSocketFile } from "./unix-socket.ts"
import { privateRootDirectory } from "./zmx-environment.ts"

const MAX_FRAME_BYTES = 1 << 20
/**
 * How much unwritten output one connection may hold. A subscriber that stops
 * reading without closing would otherwise grow the Runtime's heap for as long
 * as it stays open; past this it is dropped, because a peer that cannot keep
 * up with its own events is not one worth keeping.
 */
const MAX_OUTGOING_BYTES = 4 * 1024 * 1024
/** The frame envelope nests a few levels above the deepest Layout it carries. */
const MAX_FRAME_DEPTH = MAX_LAYOUT_DEPTH + 8
/** How much of a frame is scanned for its id when the frame itself is refused. */
const ID_SCAN_LIMIT = 512

/**
 * A refusal has to name what it refuses: a response the caller cannot
 * correlate is one it will wait on forever. When a frame is rejected before
 * it can be parsed, its id is read straight out of the text.
 */
function frameId(line: string): string | null {
  const match = /"id"\s*:\s*"((?:[^"\\]|\\.){1,128})"/u.exec(line.slice(0, ID_SCAN_LIMIT))
  if (!match) return null
  try {
    return JSON.parse(`"${match[1]!}"`) as string
  } catch {
    return null
  }
}
const SINGLETON_HANDOFF_TIMEOUT_MS = 1_000
const SINGLETON_HANDOFF_INTERVAL_MS = 25

/** Another Runtime owns this Instance's API socket. */
export class InstanceActiveError extends Error {
  constructor(readonly path: string) {
    super(`another smolmux Runtime is already running for this Instance (listening on ${path})`)
    this.name = "InstanceActiveError"
  }
}

export type ApiHandler = (method: Method, params: unknown) => Promise<unknown>

type Connection = {
  id: number
  buffer: LineBuffer
  filters: string[] | null
  pending: number
  /** Frames not yet fully written; a large result can exceed the socket buffer. */
  outgoing: Uint8Array[]
  outgoingBytes: number
}

const encoder = new TextEncoder()

/**
 * The one API socket of a Runtime: newline-delimited JSON, any number of
 * long-lived connections, events to those that subscribed. Binding it makes
 * this process the Instance's singleton: a live holder is refused and never
 * unlinked; residue from a crashed Runtime is replaced only under the lock.
 */
export class ApiServer {
  private readonly connections = new Map<number, Connection>()
  private nextId = 1
  private server: ReturnType<typeof Bun.listen<Connection>> | null = null
  /** Held from start to stop: the right to probe, unlink, and bind the path. */
  private lock: HeldLock | null = null

  constructor(
    readonly path: string,
    private readonly handle: ApiHandler,
  ) {}

  async start(): Promise<void> {
    if (this.server) return
    await checkEventSocketOwnership(this.path, undefined, true)
    const lockPath = lockPathFor(this.path)
    let lock = acquireExclusiveLock(lockPath)
    if (lock === null) lock = await waitForSingletonHandoff(lockPath)
    if (lock === null) throw new InstanceActiveError(this.path)
    this.lock = lock ?? null
    if (await listenerAnswers(this.path)) {
      this.releaseLock()
      throw new InstanceActiveError(this.path)
    }
    removeSocketFile(this.path)
    for (const retired of retiredSocketPathsFor(this.path)) removeSocketFile(retired)
    try {
      this.server = Bun.listen<Connection>({
        unix: this.path,
        socket: {
          open: (socket) => this.open(socket),
          data: (socket, data) => this.data(socket, data),
          drain: (socket) => this.flush(socket),
          close: (socket) => this.forget(socket.data.id),
          error: (socket) => this.forget(socket.data.id),
        },
      })
      chmodSync(this.path, 0o600)
    } catch (error) {
      const owned = this.server !== null
      this.server?.stop(true)
      this.server = null
      if (owned) removeSocketFile(this.path)
      this.releaseLock()
      if (isAddressInUse(error)) throw new InstanceActiveError(this.path)
      throw error
    }
  }

  stop(): void {
    if (!this.server) return
    this.server.stop(true)
    this.server = null
    removeSocketFile(this.path)
    this.releaseLock()
    for (const id of this.connections.keys()) this.forget(id)
    this.sockets.clear()
  }

  broadcast(frame: EventFrame): void {
    if (!this.server) return
    const bytes = encoder.encode(encodeFrame(frame))
    for (const connection of [...this.connections.values()]) {
      if (!connection.filters || !matchesEvent(connection.filters, frame.event)) continue
      this.enqueue(connection, bytes)
    }
  }

  get subscribers(): number {
    let count = 0
    for (const connection of this.connections.values()) if (connection.filters) count += 1
    return count
  }

  private readonly sockets = new Map<number, Socket<Connection>>()

  private forget(id: number): void {
    const connection = this.connections.get(id)
    if (connection) {
      connection.outgoing = []
      connection.outgoingBytes = 0
      connection.buffer.clear()
    }
    this.connections.delete(id)
    this.sockets.delete(id)
  }

  private open(socket: Socket<Connection>): void {
    const id = this.nextId++
    const connection: Connection = {
      id,
      buffer: new LineBuffer(MAX_FRAME_BYTES),
      filters: null,
      pending: 0,
      outgoing: [],
      outgoingBytes: 0,
    }
    socket.data = connection
    if (this.connections.size >= 128) {
      socket.terminate()
      return
    }
    this.connections.set(id, connection)
    this.sockets.set(id, socket)
  }

  private send(connection: Connection, line: string): void {
    this.enqueue(connection, encoder.encode(line))
  }

  /** Queue bytes, or drop a peer that has stopped reading its own socket. */
  private enqueue(connection: Connection, bytes: Uint8Array): void {
    if (!this.connections.has(connection.id)) return
    if (connection.outgoingBytes + bytes.byteLength > MAX_OUTGOING_BYTES) {
      this.sockets.get(connection.id)?.terminate()
      this.forget(connection.id)
      return
    }
    connection.outgoing.push(bytes)
    connection.outgoingBytes += bytes.byteLength
    this.flushConnection(connection)
  }

  private flushConnection(connection: Connection): void {
    const socket = this.sockets.get(connection.id)
    if (socket) this.flush(socket)
  }

  /** Write what the kernel will take; the rest waits for `drain`. */
  private flush(socket: Socket<Connection>): void {
    const connection = socket.data
    while (connection.outgoing.length > 0) {
      const chunk = connection.outgoing[0]!
      let written: number
      try {
        written = socket.write(chunk)
      } catch {
        socket.terminate()
        this.forget(connection.id)
        return
      }
      // Bun answers -1 for a socket that errored or closed; retrying the same
      // chunk would spin. Let `close` clean it up.
      if (written < 0) {
        socket.terminate()
        this.forget(connection.id)
        return
      }
      if (written < chunk.byteLength) {
        connection.outgoing[0] = chunk.subarray(written)
        connection.outgoingBytes -= written
        return
      }
      connection.outgoing.shift()
      connection.outgoingBytes -= chunk.byteLength
    }
  }

  private data(socket: Socket<Connection>, data: Buffer): void {
    const connection = socket.data
    try {
      connection.buffer.push(data, (raw) => {
        const line = raw.trim()
        if (line.length === 0 || !this.connections.has(connection.id)) return
        if (connection.pending >= 128) {
          socket.terminate()
          this.forget(connection.id)
          return
        }
        connection.pending += 1
        void this.accept(line, connection)
          .catch((error) => {
            this.send(
              connection,
              encodeFrame(
                failureFrame(frameId(line), "internal_error", error instanceof Error ? error.message : String(error)),
              ),
            )
          })
          .finally(() => {
            connection.pending -= 1
          })
      })
    } catch (error) {
      if (!(error instanceof FrameLimitError)) throw error
      this.send(connection, encodeFrame(failureFrame(frameId(error.prefix), "invalid_request", error.message)))
      socket.end()
    }
  }

  private async accept(line: string, connection: Connection): Promise<void> {
    // `JSON.parse` is recursive, so a frame deep enough to overflow it is
    // refused before it is parsed: the overflow would be a RangeError, and
    // the caller would get no reply at all.
    if (frameNestingDepth(line, MAX_FRAME_DEPTH) > MAX_FRAME_DEPTH) {
      this.send(
        connection,
        encodeFrame(
          failureFrame(frameId(line), "invalid_request", `a request may nest at most ${MAX_LAYOUT_DEPTH} deep`),
        ),
      )
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.send(
        connection,
        encodeFrame(failureFrame(frameId(line), "invalid_request", "expected one JSON object per line")),
      )
      return
    }
    const request = requestSchema.safeParse(parsed)
    if (!request.success) {
      const id = isRecord(parsed) && typeof parsed.id === "string" ? parsed.id : null
      this.send(
        connection,
        encodeFrame(failureFrame(id, "invalid_request", request.error.issues.map((issue) => issue.message).join("; "))),
      )
      return
    }
    const { id, method, params } = request.data
    if (!isMethod(method)) {
      this.send(connection, encodeFrame(failureFrame(id, "unknown_method", `unknown method ${JSON.stringify(method)}`)))
      return
    }
    // Anything the params parse throws is a refusal, never an escape.
    let checked: ReturnType<(typeof METHODS)[Method]["params"]["safeParse"]>
    try {
      checked = METHODS[method].params.safeParse(params ?? {})
    } catch (error) {
      this.send(
        connection,
        encodeFrame(failureFrame(id, "invalid_params", error instanceof Error ? error.message : String(error))),
      )
      return
    }
    if (!checked.success) {
      const reasons = checked.error.issues.map((issue) =>
        issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
      )
      this.send(connection, encodeFrame(failureFrame(id, "invalid_params", reasons.join("; "))))
      return
    }
    if (method === "event.subscribe") {
      const events = [...new Set((checked.data as { events: string[] }).events)]
      this.send(connection, encodeFrame(successFrame(id, { subscribed: true, events })))
      connection.filters = events
      return
    }
    try {
      const result = await this.handle(method, checked.data)
      this.send(connection, encodeFrame(successFrame(id, result)))
    } catch (error) {
      const code: ErrorCode = error instanceof ApiFailure ? error.code : "internal_error"
      const message = error instanceof Error ? error.message : String(error)
      this.send(connection, encodeFrame(failureFrame(id, code, message)))
    }
  }

  private releaseLock(): void {
    this.lock?.release()
    this.lock = null
  }
}

export function apiSocketPathFor(instanceId: string, uid: number = userInfo().uid): string {
  return `${privateRootDirectory(uid)}/${instanceId}.api`
}

export function lockPathFor(apiSocketPath: string): string {
  return apiSocketPath.replace(/\.api$/u, "") + ".lock"
}

/** Paths earlier smolmux versions bound for the same Instance; residue only. */
export function retiredSocketPathsFor(apiSocketPath: string): string[] {
  const base = apiSocketPath.replace(/\.api$/u, "")
  return [`${base}.ade.sock`, `${base}.bus`, `${base}.ctl`, `${base}.obs`]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function waitForSingletonHandoff(path: string): Promise<HeldLock | null | undefined> {
  const deadline = Date.now() + SINGLETON_HANDOFF_TIMEOUT_MS
  let lock: HeldLock | null | undefined = null
  while (lock === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SINGLETON_HANDOFF_INTERVAL_MS))
    lock = acquireExclusiveLock(path)
  }
  return lock
}
