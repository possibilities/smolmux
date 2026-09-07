import { expect, test } from "bun:test"
import { ApiClient, type ApiClientOptions } from "../src/api-client.ts"
import { LineBuffer } from "../src/line-buffer.ts"

test("decodes UTF-8 at every byte boundary and limits each frame in bytes", () => {
  const value = "café 猫 🐈"
  const bytes = Buffer.from(`${value}\n${value}\n`)
  for (let split = 0; split <= bytes.length; split++) {
    const lines: string[] = []
    const buffer = new LineBuffer(Buffer.byteLength(value))
    buffer.push(bytes.subarray(0, split), (line) => lines.push(line))
    buffer.push(bytes.subarray(split), (line) => lines.push(line))
    expect(lines).toEqual([value, value])
  }
  const buffer = new LineBuffer(8)
  expect(() => buffer.push(Buffer.from("猫猫猫"), () => {})).toThrow("frame too large")
  const lines: string[] = []
  buffer.push(Buffer.from("ok\n"), (line) => lines.push(line))
  expect(lines).toEqual(["ok"])
})

// Drive the socket seam deterministically: even a one-byte write or a zero-byte
// write must preserve complete requests. Real sockets rarely force each case.
function driven(options: ApiClientOptions = {}) {
  const client = new (ApiClient as unknown as new (options: ApiClientOptions) => ApiClient)(options)
  const seam = client
  // Private names are exposed only to this transport fault fixture.
  return {
    client,
    seam: seam as unknown as {
      socket: { write(bytes: Uint8Array): number; terminate(): void }
      flush(): void
      data(bytes: Buffer): void
    },
  }
}

test("partial writes and drain preserve large Unicode requests in order", async () => {
  const { client, seam } = driven()
  const written: Uint8Array[] = []
  let blocked = true
  seam.socket = {
    write: (bytes) => {
      if (blocked) return 0
      const count = Math.min(bytes.length, 97)
      written.push(bytes.slice(0, count))
      return count
    },
    terminate() {},
  }
  const payload = "猫".repeat(100_000)
  const first = client.call("test.echo", { payload })
  const second = client.call("test.echo", { payload: "café" })
  try {
    expect(written.length).toBe(0)
    blocked = false
    for (let i = 0; i < 4000; i++) seam.flush()
    const lines = Buffer.concat(written)
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(lines.map((frame) => frame.params.payload)).toEqual([payload, "café"])
    const reply = Buffer.from(
      lines
        .map((frame) => JSON.stringify({ v: 2, type: "response", id: frame.id, ok: true, result: "猫 café" }) + "\n")
        .join(""),
    )
    for (const byte of reply) seam.data(Buffer.from([byte]))
    expect(await Promise.all([first, second])).toEqual(["猫 café", "猫 café"])
  } finally {
    client.close()
  }
})

test("explicit close and deadlines settle pending calls", async () => {
  for (const timeout of [false, true]) {
    const { client, seam } = driven({ timeoutMs: 20 })
    seam.socket = { write: (bytes) => bytes.length, terminate() {} }
    const pending = client.call("test.hang")
    const result = pending.catch((error: Error) => error)
    if (!timeout) client.close()
    expect(((await result) as Error).message).toContain(timeout ? "outcome is unknown" : "connection closed")
    await expect(client.call("test.echo")).rejects.toThrow("not connected")
  }
})

test("malformed responses and uncorrelated refusals settle every pending call", async () => {
  for (const frame of [
    null,
    { v: 2, type: "response", id: "1", ok: false },
    { v: 2, type: "response", id: null, ok: false, error: { code: "invalid_request", message: "uncorrelated" } },
  ]) {
    const { client, seam } = driven()
    seam.socket = { write: (bytes) => bytes.length, terminate() {} }
    const pending = client.call("test.echo").catch((error: Error) => error)
    seam.data(Buffer.from(`${JSON.stringify(frame)}\n`))
    expect(await pending).toBeInstanceOf(Error)
    await expect(client.call("test.echo")).rejects.toThrow("not connected")
  }
})
