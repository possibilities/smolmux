import { describe, expect, test } from "bun:test"
import { CursorReportAdapter } from "../src/cursor-report-adapter.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const encode = (value: string) => encoder.encode(value)
const decode = (value: Uint8Array) => decoder.decode(value)

describe("CursorReportAdapter", () => {
  test("translates private cursor queries and restores private responses", () => {
    const adapter = new CursorReportAdapter()

    expect(decode(adapter.toTerminal(encode("before\u001b[1G\u001b[?6nafter")))).toBe(
      "before\u001b[1G\u001b[6nafter",
    )
    expect(decode(adapter.toPty(encode("\u001b[12;1R")))).toBe("\u001b[?12;1R")
  })

  test("recognizes a private query split at every byte boundary", () => {
    const input = encode("left\u001b[?6nright")

    for (let split = 0; split <= input.byteLength; split += 1) {
      const adapter = new CursorReportAdapter()
      const first = adapter.toTerminal(input.subarray(0, split))
      const second = adapter.toTerminal(input.subarray(split))
      expect(decode(concat(first, second, adapter.flushTerminalBytes()))).toBe("left\u001b[6nright")
      expect(decode(adapter.toPty(encode("\u001b[3;9R")))).toBe("\u001b[?3;9R")
    }
  })

  test("translates only as many responses as private queries", () => {
    const adapter = new CursorReportAdapter()
    adapter.toTerminal(encode("\u001b[?6n"))

    expect(decode(adapter.toPty(encode("\u001b[0n\u001b[4;5R\u001b[6;7R")))).toBe(
      "\u001b[0n\u001b[?4;5R\u001b[6;7R",
    )
  })

  test("preserves ordinary output, standard queries, and unmatched responses", () => {
    const adapter = new CursorReportAdapter()

    expect(decode(adapter.toTerminal(encode("text\u001b[6n\u001b]2;title\u0007")))).toBe(
      "text\u001b[6n\u001b]2;title\u0007",
    )
    expect(decode(adapter.toPty(encode("\u001b[8;9R")))).toBe("\u001b[8;9R")
  })

  test("flushes an incomplete request prefix without changing it", () => {
    const adapter = new CursorReportAdapter()

    expect(decode(adapter.toTerminal(encode("text\u001b[?")))).toBe("text")
    expect(decode(adapter.flushTerminalBytes())).toBe("\u001b[?")
  })
})

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

/**
 * Chunk boundaries are where a scanner that skips runs goes wrong, and fx's
 * output arrives split at arbitrary bytes. Feeding a stream whole and feeding
 * it in pieces must produce exactly the same bytes.
 */
test("translates the same bytes however the stream is split", () => {
  const PRIVATE = [0x1b, 0x5b, 0x3f, 0x36, 0x6e]
  const DECOYS = [
    [0x1b, 0x5b, 0x36, 0x6e],
    [0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x68],
    [0x1b, 0x5d, 0x30, 0x3b, 0x61, 0x07],
    [0x1b],
    [0x1b, 0x1b, 0x5b, 0x3f, 0x36, 0x6e],
  ]
  let seed = 20260826
  const random = (bound: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % bound
  }

  for (let trial = 0; trial < 200; trial += 1) {
    const stream: number[] = []
    for (let piece = 0; piece < 12; piece += 1) {
      const kind = random(4)
      if (kind === 0) stream.push(...PRIVATE)
      else if (kind === 1) stream.push(...DECOYS[random(DECOYS.length)]!)
      else for (let index = 0, length = random(40); index < length; index += 1) stream.push(random(2) ? 0x61 : random(256))
    }
    const bytes = Uint8Array.from(stream)

    const whole = new CursorReportAdapter()
    const expected = [...whole.toTerminal(bytes), ...whole.flushTerminalBytes()]

    const split = new CursorReportAdapter()
    const actual: number[] = []
    let offset = 0
    while (offset < bytes.length) {
      const size = 1 + random(7)
      actual.push(...split.toTerminal(bytes.subarray(offset, offset + size)))
      offset += size
    }
    actual.push(...split.flushTerminalBytes())
    expect(actual).toEqual(expected)
  }
})

test("declines in-band resize while preserving other coalesced terminal replies", () => {
  const adapter = new CursorReportAdapter()
  adapter.toTerminal(encode("\u001b[?6n"))
  const bytes = encode("\u001b[?2048;2$y\u001b[?2026;2$y\u001b[4;5R")
  expect(decode(adapter.toPty(bytes))).toBe("\u001b[?2048;0$y\u001b[?2026;2$y\u001b[?4;5R")
  expect(decode(bytes)).toBe("\u001b[?2048;2$y\u001b[?2026;2$y\u001b[4;5R")
  for (const mode of [1, 2, 3, 4]) {
    expect(decode(adapter.toPty(encode(`\u001b[?2048;${mode}$y`)))).toBe("\u001b[?2048;0$y")
  }
  const ordinary = encode("\u001b[?2048;0$y\u001b[?2049;2$y")
  expect(adapter.toPty(ordinary)).toBe(ordinary)
})
