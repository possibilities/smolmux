/**
 * The wire contract smolmux speaks to the Companion daemon over its Unix socket.
 *
 * Frame and control codecs only: every integer is little-endian at a fixed
 * offset, mirroring `src/ipc.zig` in the pinned Companion fork byte for
 * byte. `tests/fixtures/zmx-wire.json` holds the same golden bytes the fork's
 * own tests pin, so a drift on either side fails a test rather than a session.
 *
 * Terminal bytes (Input/Output) ride in frames untouched; nothing here parses
 * them.
 */

/** Tags are frozen integers; a tag this client does not know decodes as-is. */
export const Tag = {
  Input: 0,
  Output: 1,
  Resize: 2,
  Detach: 3,
  DetachAll: 4,
  Kill: 5,
  Info: 6,
  Init: 7,
  History: 8,
  Run: 9,
  Ack: 10,
  Switch: 11,
  Write: 12,
  TaskComplete: 13,
  LabelGet: 14,
  LabelSet: 15,
  LabelClear: 16,
  LabelData: 17,
  Send: 18,
  Hello: 19,
  Welcome: 20,
  RestoreBegin: 21,
  Ready: 22,
  Exit: 23,
  Migrate: 24,
  MigrateAck: 25,
} as const

export const PROTOCOL_VERSION = 1
export const MIN_PROTOCOL_VERSION = 1

/** Envelope: tag u8, payload length u32, three reserved bytes. */
export const HEADER_LEN = 8
/** Largest payload either side may announce; the reader fails past it. */
export const MAX_PAYLOAD_LEN = 16 * 1024 * 1024
export const RESIZE_LEN = 8
export const HELLO_FIXED_LEN = 8
export const MAX_CLIENT_NAME_LEN = 64
export const WELCOME_LEN = 10
export const EXIT_LEN = 8
/** Exit byte 3 bit 0: set only when the daemon cannot know the status. */
export const EXIT_STATUS_UNKNOWN = 1 << 0

export type Header = { tag: number; len: number }
export type Frame = { tag: number; payload: Uint8Array }
export type Resize = { rows: number; cols: number; xpixel?: number; ypixel?: number }
export type Hello = {
  minVersion: number
  maxVersion: number
  capabilities?: number
  client: string
}
export type Welcome = {
  /** The version both sides speak, or 0 when the daemon refused. */
  version: number
  minVersion: number
  maxVersion: number
  capabilities: number
}

/**
 * How a session's child ended. `code` and `signal` are what the daemon's
 * `waitpid` reported — a signalled child has a non-zero `signal` and a `code`
 * of 0 — while `reason` says what brought it about. Both are null after a
 * handoff, when the replacement daemon cannot wait for the adopted child.
 */
export type Exit = {
  code: number | null
  signal: number | null
  reason: ExitReason
}

export const ExitReason = {
  /** Ended on its own, by exiting or by a signal nobody in the session sent. */
  natural: 0,
  /** Someone asked the daemon to end the session. */
  requested: 1,
  /** The daemon could not continue and took the child with it. */
  daemonFailure: 2,
  /** Never started: exec failed. */
  execFailure: 3,
} as const

/** A reason this client does not know decodes as its integer. */
export type ExitReason = number

export function encodeExit(status: Exit): Uint8Array {
  const unknown = status.code === null && status.signal === null
  if ((status.code === null) !== (status.signal === null)) throw new ProtocolError("Exit code and signal must both be known or both null")
  // Each field is a byte on the wire; silently truncating would encode a
  // different exit than the caller described.
  for (const [name, value] of [
    ["code", status.code ?? 0],
    ["signal", status.signal ?? 0],
    ["reason", status.reason],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 255) throw new ProtocolError(`Exit ${name} must be a byte, got ${value}`)
  }
  const out = new Uint8Array(EXIT_LEN)
  out[0] = status.code ?? 0
  out[1] = status.signal ?? 0
  out[2] = status.reason
  out[3] = unknown ? EXIT_STATUS_UNKNOWN : 0
  return out
}

export function decodeExit(bytes: Uint8Array): Exit {
  if (bytes.byteLength !== EXIT_LEN) throw new ProtocolError(`Exit payload is ${bytes.byteLength} bytes, not ${EXIT_LEN}`)
  // Zero flags preserve legacy known status. Ignore unassigned flag bits.
  const unknown = (bytes[3]! & EXIT_STATUS_UNKNOWN) !== 0
  return { code: unknown ? null : bytes[0]!, signal: unknown ? null : bytes[1]!, reason: bytes[2]! }
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProtocolError"
  }
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

export function encodeHeader(tag: number, len: number): Uint8Array {
  const out = new Uint8Array(HEADER_LEN)
  out[0] = tag
  view(out).setUint32(1, len, true)
  return out
}

export function decodeHeader(bytes: Uint8Array): Header {
  if (bytes.byteLength < HEADER_LEN) throw new ProtocolError("header shorter than 8 bytes")
  // Reserved bytes 5-7 are ignored so a later revision can claim them.
  return { tag: bytes[0]!, len: view(bytes).getUint32(1, true) }
}

export function encodeFrame(tag: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (payload.byteLength > MAX_PAYLOAD_LEN) throw new ProtocolError(`frame payload of ${payload.byteLength} bytes exceeds ${MAX_PAYLOAD_LEN}`)
  const out = new Uint8Array(HEADER_LEN + payload.byteLength)
  out.set(encodeHeader(tag, payload.byteLength), 0)
  out.set(payload, HEADER_LEN)
  return out
}

export function encodeResize(size: Resize): Uint8Array {
  const out = new Uint8Array(RESIZE_LEN)
  const v = view(out)
  v.setUint16(0, size.rows, true)
  v.setUint16(2, size.cols, true)
  v.setUint16(4, size.xpixel ?? 0, true)
  v.setUint16(6, size.ypixel ?? 0, true)
  return out
}

export function decodeResize(bytes: Uint8Array): Required<Resize> {
  if (bytes.byteLength !== RESIZE_LEN) throw new ProtocolError(`Resize payload is ${bytes.byteLength} bytes, not ${RESIZE_LEN}`)
  const v = view(bytes)
  return {
    rows: v.getUint16(0, true),
    cols: v.getUint16(2, true),
    xpixel: v.getUint16(4, true),
    ypixel: v.getUint16(6, true),
  }
}

export function encodeHello(hello: Hello): Uint8Array {
  const name = new TextEncoder().encode(hello.client)
  if (name.byteLength > MAX_CLIENT_NAME_LEN) throw new ProtocolError(`client name longer than ${MAX_CLIENT_NAME_LEN} bytes`)
  const out = new Uint8Array(HELLO_FIXED_LEN + name.byteLength)
  const v = view(out)
  v.setUint16(0, hello.minVersion, true)
  v.setUint16(2, hello.maxVersion, true)
  v.setUint32(4, hello.capabilities ?? 0, true)
  out.set(name, HELLO_FIXED_LEN)
  return out
}

export function decodeHello(bytes: Uint8Array): Required<Hello> {
  if (bytes.byteLength < HELLO_FIXED_LEN) throw new ProtocolError("Hello shorter than 8 bytes")
  if (bytes.byteLength > HELLO_FIXED_LEN + MAX_CLIENT_NAME_LEN) throw new ProtocolError("Hello client name too long")
  const v = view(bytes)
  return {
    minVersion: v.getUint16(0, true),
    maxVersion: v.getUint16(2, true),
    capabilities: v.getUint32(4, true),
    client: new TextDecoder().decode(bytes.subarray(HELLO_FIXED_LEN)),
  }
}

export function encodeWelcome(welcome: Welcome): Uint8Array {
  const out = new Uint8Array(WELCOME_LEN)
  const v = view(out)
  v.setUint16(0, welcome.version, true)
  v.setUint16(2, welcome.minVersion, true)
  v.setUint16(4, welcome.maxVersion, true)
  v.setUint32(6, welcome.capabilities, true)
  return out
}

export function decodeWelcome(bytes: Uint8Array): Welcome {
  if (bytes.byteLength !== WELCOME_LEN) throw new ProtocolError(`Welcome payload is ${bytes.byteLength} bytes, not ${WELCOME_LEN}`)
  const v = view(bytes)
  return {
    version: v.getUint16(0, true),
    minVersion: v.getUint16(2, true),
    maxVersion: v.getUint16(4, true),
    capabilities: v.getUint32(6, true),
  }
}

/** The Hello this client sends: it speaks exactly the pinned version. */
export const clientHello = (client: string): Hello => ({
  minVersion: MIN_PROTOCOL_VERSION,
  maxVersion: PROTOCOL_VERSION,
  capabilities: 0,
  client,
})

/**
 * Reassembles frames from a byte stream that may split or merge them
 * arbitrarily. Bytes are copied once into a growing buffer and compacted
 * when the consumed prefix is the larger part, so a long session does not
 * accumulate what it has already read.
 */
const INITIAL_BUFFER_BYTES = 4096

export class FrameReader {
  private buffer = new Uint8Array(INITIAL_BUFFER_BYTES)
  private head = 0
  private tail = 0

  /**
   * Appends bytes, throwing ProtocolError as soon as any header now in the
   * buffer announces too large a payload — not only the frame at the front.
   * One read can carry several frames, and a violating header sitting behind
   * a valid one would otherwise wait for a later push that may never come.
   */
  push(chunk: Uint8Array): void {
    this.reserve(chunk.byteLength)
    this.buffer.set(chunk, this.tail)
    this.tail += chunk.byteLength
    let offset = this.head
    while (this.tail - offset >= HEADER_LEN) {
      const { len } = decodeHeader(this.buffer.subarray(offset, offset + HEADER_LEN))
      if (len > MAX_PAYLOAD_LEN) throw new ProtocolError(`peer announced a ${len}-byte payload, over ${MAX_PAYLOAD_LEN}`)
      if (this.tail - offset < HEADER_LEN + len) return
      offset += HEADER_LEN + len
    }
  }

  /** The next complete frame, or null until one has fully arrived. The payload is a copy. */
  next(): Frame | null {
    const available = this.tail - this.head
    if (available < HEADER_LEN) return null
    const { tag, len } = decodeHeader(this.buffer.subarray(this.head, this.head + HEADER_LEN))
    if (available < HEADER_LEN + len) return null
    const payload = this.buffer.slice(this.head + HEADER_LEN, this.head + HEADER_LEN + len)
    this.head += HEADER_LEN + len
    if (this.head === this.tail) {
      this.head = this.tail = 0
      // One restore-sized frame would otherwise hold its buffer for the life
      // of the connection, and there is one connection per Session.
      if (this.buffer.byteLength > INITIAL_BUFFER_BYTES) this.buffer = new Uint8Array(INITIAL_BUFFER_BYTES)
    }
    return { tag, payload }
  }

  /** Bytes received but not yet returned as a frame. */
  get pending(): number {
    return this.tail - this.head
  }

  /** How much this reader is holding, so a test can prove it lets go. */
  get bufferBytes(): number {
    return this.buffer.byteLength
  }

  private reserve(extra: number): void {
    if (this.tail + extra <= this.buffer.byteLength) return
    if (this.head > 0 && this.head >= this.buffer.byteLength / 2) {
      this.buffer.copyWithin(0, this.head, this.tail)
      this.tail -= this.head
      this.head = 0
      if (this.tail + extra <= this.buffer.byteLength) return
    }
    let size = this.buffer.byteLength * 2
    while (size < this.tail + extra) size *= 2
    const grown = new Uint8Array(size)
    grown.set(this.buffer.subarray(this.head, this.tail), 0)
    this.tail -= this.head
    this.head = 0
    this.buffer = grown
  }
}
