import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ApiClient } from "../src/api-client.ts"
import { ApiServer, InstanceActiveError, lockPathFor, retiredSocketPathsFor } from "../src/api-server.ts"
import { ApiFailure, eventFrame, type Method } from "../src/protocol.ts"

const servers: ApiServer[] = []
const clients: ApiClient[] = []
let directory = ""

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  for (const server of servers.splice(0)) server.stop()
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = ""
})

async function serve(handle: (method: Method, params: unknown) => Promise<unknown>): Promise<ApiServer> {
  directory = directory || (await mkdtemp(join(tmpdir(), "smolmux-api-")))
  const server = new ApiServer(join(directory, "instance.api"), handle)
  servers.push(server)
  await server.start()
  return server
}

async function connect(server: ApiServer, onEvent?: (event: unknown) => void): Promise<ApiClient> {
  const client = await ApiClient.connect(server.path, { onEvent: onEvent as never })
  clients.push(client)
  return client
}

test("answers a request with a correlated response", async () => {
  const server = await serve(async (method) => ({ echoed: method }))
  const client = await connect(server)
  expect(await client.call("layout.get")).toEqual({ echoed: "layout.get" })
  expect(await client.call("app.list")).toEqual({ echoed: "app.list" })
})

test("validates the method and its params from the contract", async () => {
  const server = await serve(async () => ({}))
  const client = await connect(server)
  await expect(client.call("session.explode")).rejects.toThrow('unknown method "session.explode"')
  await expect(client.call("app.create", { pty: "companion", name: "tray" })).rejects.toThrow(/argv|cwd/u)
  await expect(client.call("app.create", { pty: "companion", name: "Tray", argv: ["/bin/sh"], cwd: "/" })).rejects.toMatchObject({
    code: "invalid_params",
  })
})

test("carries a handler's own failure code to the caller", async () => {
  const server = await serve(async () => {
    throw new ApiFailure("not_found", "no Session named tray")
  })
  const client = await connect(server)
  await expect(client.call("app.list")).rejects.toMatchObject({
    code: "not_found",
    message: "no Session named tray",
  })
})

test("an unexpected handler failure is internal, and its message survives", async () => {
  const server = await serve(async () => {
    throw new Error("the Companion is not answering")
  })
  const client = await connect(server)
  await expect(client.call("app.list")).rejects.toMatchObject({
    code: "internal_error",
    message: "the Companion is not answering",
  })
})

test("events reach only the connections that subscribed", async () => {
  const server = await serve(async () => ({}))
  const heard: unknown[] = []
  const quiet: unknown[] = []
  const listener = await connect(server, (event) => heard.push(event))
  await connect(server, (event) => quiet.push(event))
  await listener.call("event.subscribe")
  expect(server.subscribers).toBe(1)

  server.broadcast(eventFrame("theme.changed", { theme: "light", instanceId: "test", generation: 1, sequence: 1 }))
  await Bun.sleep(30)
  expect(heard).toEqual([{ v: 2, type: "event", event: "theme.changed", data: { theme: "light", instanceId: "test", generation: 1, sequence: 1 } }])
  expect(quiet).toEqual([])
})

test("a connection is long-lived and answers requests in order", async () => {
  const seen: string[] = []
  const server = await serve(async (method, params) => {
    seen.push(`${method}:${JSON.stringify(params)}`)
    return { index: seen.length }
  })
  const client = await connect(server)
  const results = await Promise.all([
    client.call("layout.get"),
    client.call("app.list"),
    client.call("instance.status"),
  ])
  expect(results).toEqual([{ index: 1 }, { index: 2 }, { index: 3 }])
})

test("refuses a line that is not one JSON request", async () => {
  const server = await serve(async () => ({}))
  const responses: string[] = []
  const socket = await Bun.connect({
    unix: server.path,
    socket: {
      data: (_socket, data) => {
        responses.push(data.toString("utf8"))
      },
      open: () => {},
    },
  })
  try {
    socket.write("not json\n")
    socket.write(`${JSON.stringify({ v: 9, type: "request", id: "1", method: "layout.get" })}\n`)
    await Bun.sleep(50)
    expect(responses.join("")).toContain("expected one JSON object per line")
    expect(responses.join("")).toContain("invalid_request")
  } finally {
    socket.end()
  }
})

test("the socket is the Instance singleton, mode 0600, and refuses a second Runtime", async () => {
  const server = await serve(async () => ({}))
  expect((await stat(server.path)).mode & 0o777).toBe(0o600)

  const second = new ApiServer(server.path, async () => ({}))
  await expect(second.start()).rejects.toBeInstanceOf(InstanceActiveError)

  server.stop()
  servers.length = 0
  // Once the holder is gone the path is free again.
  const replacement = new ApiServer(server.path, async () => ({ ok: true }))
  servers.push(replacement)
  await replacement.start()
  const client = await connect(replacement)
  expect(await client.call("layout.get")).toEqual({ ok: true })
})

test("a subscriber that stops reading is dropped rather than growing the heap", async () => {
  const server = await serve(async () => ({}))
  // A peer that subscribes and never reads its socket.
  const received: number[] = []
  const socket = await Bun.connect({
    unix: server.path,
    socket: {
      data: (_socket, data) => {
        received.push(data.byteLength)
      },
      open: () => {},
    },
  })
  try {
    socket.write(`${JSON.stringify({ v: 2, type: "request", id: "1", method: "event.subscribe" })}\n`)
    await Bun.sleep(30)
    expect(server.subscribers).toBe(1)

    // Nothing reads from here on; the kernel buffer fills and the queue grows.
    const big = "x".repeat(40_000)
    for (let index = 0; index < 4_000 && server.subscribers > 0; index += 1) {
      server.broadcast(eventFrame("session.changed", { sessionId: "00000000-0000-4000-8000-000000000001", name: "tray", title: big, instanceId: "test", generation: 1, sequence: 1 }))
    }
    // It is dropped, not held forever.
    expect(server.subscribers).toBe(0)
  } finally {
    socket.end()
  }
})

test("a Layout too deep to validate is refused, not left to overflow the stack", async () => {
  const server = await serve(async () => ({ ok: true }))
  const client = await connect(server)
  const nest = (depth: number) => {
    let node: unknown = { app: "a" }
    for (let index = 0; index < depth; index += 1) node = { row: [node] }
    return node
  }
  // A frame can carry far more nesting than JSON.parse itself can walk; the
  // overflow is a RangeError, so the caller would get no reply at all.
  for (const depth of [40, 500, 5_000]) {
    await expect(client.call("layout.apply", { visible: [], root: nest(depth) }), `at depth ${depth}`).rejects.toMatchObject({
      code: "invalid_request",
    })
  }
  // The connection is still good afterwards.
  expect(await client.call("layout.get")).toEqual({ ok: true })
  expect(await client.call("layout.apply", { visible: [], root: nest(4) })).toEqual({ ok: true })
})

test("a refusal names the request it refuses, so a caller never waits on it", async () => {
  const server = await serve(async () => ({ ok: true }))
  const client = await connect(server)
  // Malformed JSON carrying a readable id is still correlated.
  const answered = Promise.withResolvers<string>()
  const socket = await Bun.connect({
    unix: server.path,
    socket: {
      data: (_socket, data) => answered.resolve(data.toString("utf8")),
      open: () => {},
    },
  })
  try {
    socket.write(`{"v":2,"type":"request","id":"7","method":"layout.get",}\n`)
    const reply = JSON.parse(await answered.promise)
    expect(reply).toMatchObject({ id: "7", ok: false, error: { code: "invalid_request" } })
  } finally {
    socket.end()
  }
  expect(await client.call("layout.get")).toEqual({ ok: true })
})

test("names the paths an earlier smolmux bound for the same Instance", () => {
  expect(retiredSocketPathsFor("/tmp/smolmux-501/abc.api")).toEqual([
    "/tmp/smolmux-501/abc.ade.sock",
    "/tmp/smolmux-501/abc.bus",
    "/tmp/smolmux-501/abc.ctl",
    "/tmp/smolmux-501/abc.obs",
  ])
  expect(lockPathFor("/tmp/smolmux-501/abc.api")).toBe("/tmp/smolmux-501/abc.lock")
})
