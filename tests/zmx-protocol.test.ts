import { describe, expect, test } from "bun:test"
import fixture from "./fixtures/zmx-wire.json"
import {
  decodeExit,
  decodeHeader,
  decodeHello,
  decodeResize,
  decodeWelcome,
  encodeExit,
  encodeFrame,
  encodeHeader,
  encodeHello,
  encodeResize,
  encodeWelcome,
  EXIT_LEN,
  EXIT_STATUS_UNKNOWN,
  ExitReason,
  FrameReader,
  HEADER_LEN,
  MAX_CLIENT_NAME_LEN,
  MAX_PAYLOAD_LEN,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  ProtocolError,
  Tag,
} from "../src/zmx-protocol.ts"

const hex = (s: string) => Uint8Array.from(Buffer.from(s.replaceAll(" ", ""), "hex"))
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex")
const text = (s: string) => new TextEncoder().encode(s)
const tagOf = (name: string | number) => (typeof name === "number" ? name : Tag[name as keyof typeof Tag])

describe("golden wire bytes match the pinned Companion fork", () => {
  test("constants", () => {
    expect(PROTOCOL_VERSION).toBe(fixture.protocolVersion)
    expect(MIN_PROTOCOL_VERSION).toBe(fixture.minProtocolVersion)
    expect(HEADER_LEN).toBe(fixture.headerLen)
    expect(MAX_PAYLOAD_LEN).toBe(fixture.maxPayloadLen)
    expect(MAX_CLIENT_NAME_LEN).toBe(fixture.maxClientNameLen)
    expect<Record<string, number>>(Tag).toEqual(fixture.tags)
  })

  test("header", () => {
    const c = fixture.cases.header
    expect(toHex(encodeHeader(tagOf(c.tag), c.len))).toBe(c.hex)
    expect(decodeHeader(hex(c.hex))).toEqual({ tag: tagOf(c.tag), len: c.len })
  })

  test("header reserved bytes are ignored and unknown tags survive", () => {
    const r = fixture.cases.headerReservedIgnored
    expect(decodeHeader(hex(r.hex))).toEqual({ tag: tagOf(r.tag), len: r.len })
    const u = fixture.cases.headerUnknownTag
    expect(decodeHeader(hex(u.hex))).toEqual({ tag: u.tag, len: u.len })
  })

  test("frames", () => {
    const c = fixture.cases.frames
    const encoded = Buffer.concat(c.decoded.map((f) => encodeFrame(tagOf(f.tag), text(f.payload))))
    expect(toHex(encoded)).toBe(c.hex.replaceAll(" ", ""))
  })

  test("resize", () => {
    const c = fixture.cases.resize
    expect(toHex(encodeResize(c))).toBe(c.hex)
    expect(decodeResize(hex(c.hex))).toEqual({ rows: c.rows, cols: c.cols, xpixel: c.xpixel, ypixel: c.ypixel })
  })

  // The fixture is the fork's own golden bytes, including the client name it
  // encodes. It is refreshed with the fork, never renamed with smolmux.
  test("hello", () => {
    const c = fixture.cases.hello
    expect(toHex(encodeHello(c))).toBe(c.hex)
    expect(decodeHello(hex(c.hex))).toEqual({ minVersion: c.minVersion, maxVersion: c.maxVersion, capabilities: c.capabilities, client: c.client })
    expect(decodeHello(hex(fixture.cases.helloBare.hex)).client).toBe("")
  })

  test("exit", () => {
    for (const key of ["exit", "exitSignalled", "exitUnknown"] as const) {
      const c = fixture.cases[key]
      expect(toHex(encodeExit(c))).toBe(c.hex)
      expect(decodeExit(hex(c.hex))).toEqual({ code: c.code, signal: c.signal, reason: c.reason })
    }
    expect(EXIT_LEN).toBe(fixture.exitLen)
    expect(EXIT_STATUS_UNKNOWN).toBe(fixture.exitStatusUnknown)
    // Pinned against the wire, not against itself: renumbering a reason on
    // the Companion side has to fail here.
    expect<Record<string, number>>(ExitReason).toEqual(fixture.exitReasons)
    expect(() => encodeExit({ code: 256, signal: 0, reason: 0 })).toThrow(ProtocolError)
    expect(() => encodeExit({ code: 0, signal: -1, reason: 0 })).toThrow(ProtocolError)
    expect(() => encodeExit({ code: null, signal: 0, reason: 0 })).toThrow(ProtocolError)
    expect(() => encodeExit({ code: 0, signal: null, reason: 0 })).toThrow(ProtocolError)
    // A reason this client does not know decodes as its integer.
    expect(decodeExit(hex("0000c80000000000")).reason).toBe(200)
    expect(() => decodeExit(hex("000000"))).toThrow(ProtocolError)
  })

  test("Exit flags distinguish legacy zero from unknown and ignore future bits", () => {
    expect(decodeExit(hex("0000000000000000"))).toEqual({ code: 0, signal: 0, reason: 0 })
    expect(decodeExit(hex("0709010100000000"))).toEqual({ code: null, signal: null, reason: 1 })
    expect(decodeExit(hex("070903fe12345678"))).toEqual({ code: 7, signal: 9, reason: 3 })
  })

  test("welcome", () => {
    for (const c of [fixture.cases.welcome, fixture.cases.welcomeRejected]) {
      expect(toHex(encodeWelcome(c))).toBe(c.hex)
      expect(decodeWelcome(hex(c.hex))).toEqual({ version: c.version, minVersion: c.minVersion, maxVersion: c.maxVersion, capabilities: c.capabilities })
    }
  })
})

describe("codec bounds", () => {
  test("rejects wrong lengths and oversized names", () => {
    expect(() => decodeResize(hex("180050"))).toThrow(ProtocolError)
    expect(() => decodeResize(new Uint8Array(9))).toThrow(ProtocolError)
    expect(() => decodeWelcome(hex("0100"))).toThrow(ProtocolError)
    expect(() => decodeHello(hex("01000100"))).toThrow(ProtocolError)
    expect(() => decodeHello(new Uint8Array(8 + MAX_CLIENT_NAME_LEN + 1))).toThrow(ProtocolError)
    expect(() => encodeHello({ minVersion: 1, maxVersion: 1, client: "x".repeat(MAX_CLIENT_NAME_LEN + 1) })).toThrow(ProtocolError)
    expect(() => encodeFrame(Tag.Output, new Uint8Array(MAX_PAYLOAD_LEN + 1))).toThrow(ProtocolError)
    expect(toHex(encodeFrame(Tag.Output, new Uint8Array(MAX_PAYLOAD_LEN)).subarray(0, HEADER_LEN))).toBe("0100000001000000")
  })
})

describe("FrameReader", () => {
  const stream = hex(fixture.cases.frames.hex)

  test("reassembles frames fed one byte at a time", () => {
    const reader = new FrameReader()
    const frames: { tag: number; payload: string; at: number }[] = []
    stream.forEach((byte, i) => {
      reader.push(Uint8Array.of(byte))
      for (let f = reader.next(); f; f = reader.next()) frames.push({ tag: f.tag, payload: new TextDecoder().decode(f.payload), at: i })
    })
    expect(frames).toEqual([
      { tag: Tag.Output, payload: "hello", at: 12 },
      { tag: Tag.Detach, payload: "", at: 20 },
    ])
    expect(reader.pending).toBe(0)
  })

  test("splits coalesced frames and keeps a trailing partial", () => {
    const reader = new FrameReader()
    reader.push(Buffer.concat([stream, encodeHeader(Tag.Input, 3), text("ab")]))
    expect(reader.next()?.tag).toBe(Tag.Output)
    expect(reader.next()?.tag).toBe(Tag.Detach)
    expect(reader.next()).toBeNull()
    expect(reader.pending).toBe(HEADER_LEN + 2)
    reader.push(text("c"))
    const last = reader.next()
    expect(last?.tag).toBe(Tag.Input)
    expect(new TextDecoder().decode(last!.payload)).toBe("abc")
    expect(reader.next()).toBeNull()
  })

  test("a payload returned is a copy, unaffected by later pushes", () => {
    const reader = new FrameReader()
    reader.push(encodeFrame(Tag.Output, text("first")))
    const first = reader.next()!
    for (let i = 0; i < 2000; i++) reader.push(encodeFrame(Tag.Output, text("x".repeat(100))))
    expect(new TextDecoder().decode(first.payload)).toBe("first")
    let count = 0
    while (reader.next()) count++
    expect(count).toBe(2000)
    expect(reader.pending).toBe(0)
  })

  test("survives a payload larger than its initial buffer", () => {
    const reader = new FrameReader()
    const big = new Uint8Array(100_000).fill(7)
    const frame = encodeFrame(Tag.Output, big)
    for (let off = 0; off < frame.byteLength; off += 4096) reader.push(frame.subarray(off, off + 4096))
    const got = reader.next()!
    expect(got.payload.byteLength).toBe(100_000)
    expect(got.payload.every((b) => b === 7)).toBe(true)
  })

  test("fails as soon as a header announces an oversized payload", () => {
    // At the cap: fine. Split across pushes: fails on the byte that completes it.
    const reader = new FrameReader()
    reader.push(encodeHeader(Tag.Output, MAX_PAYLOAD_LEN))
    const over = encodeHeader(Tag.Output, MAX_PAYLOAD_LEN + 1)
    const split = new FrameReader()
    split.push(over.subarray(0, 4))
    expect(() => split.push(over.subarray(4))).toThrow(ProtocolError)

    // Behind a complete frame in the same push: also caught now, rather than
    // waiting for a later push that a quiet peer may never send.
    const behind = new FrameReader()
    expect(() => behind.push(Buffer.concat([encodeFrame(Tag.Output, text("ok")), over]))).toThrow(ProtocolError)

    // And behind two frames.
    const deeper = new FrameReader()
    expect(() =>
      deeper.push(Buffer.concat([encodeFrame(Tag.Output, text("a")), encodeFrame(Tag.Detach), over])),
    ).toThrow(ProtocolError)
  })

  test("gives back the buffer grown for one huge frame", () => {
    const reader = new FrameReader()
    const big = new Uint8Array(2 * 1024 * 1024)
    reader.push(encodeFrame(Tag.Output, big))
    expect(reader.next()?.payload.byteLength).toBe(big.byteLength)
    expect(reader.pending).toBe(0)
    // Drained: the next small frame must not still be sitting in a 4MB buffer.
    reader.push(encodeFrame(Tag.Output, text("small")))
    expect(reader.bufferBytes).toBeLessThanOrEqual(8192)
    expect(new TextDecoder().decode(reader.next()!.payload)).toBe("small")
  })
})
