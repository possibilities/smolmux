import { afterEach, expect, test } from "bun:test"
import { chmod, lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { userInfo } from "node:os"
import { join } from "node:path"
import { ApiClient } from "../src/api-client.ts"
import { ApiServer } from "../src/api-server.ts"
import { EventFeed } from "../src/event-feed.ts"
import { EventObservation } from "../src/event-observation.ts"
import { eventSchemaDocument, eventSocketFrameSchema } from "../src/event-schema.ts"
import { LineBuffer } from "../src/line-buffer.ts"
import { eventFrame, type EventFrame, type InstanceStatus, MAX_PROJECTION_BYTES, type StateSnapshot } from "../src/protocol.ts"
import { checkEventSocketOwnership } from "../src/unix-socket.ts"

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const context = { instanceId: "test-lifetime", generation: 1 as const, sequence: 1 }
function status(): InstanceStatus {
  return { version: "0.8.0", pid: 42, name: "default", instance_id: "stable-id", socket: "/tmp/test.api",
    stage: { cols: 80, rows: 24 }, theme: "dark", apps: [],
    host: "headless", capabilities: { local: false, companion: true },
    layout: { visible: [], revision: 0, root: null, focus: null, stage: { cols: 80, rows: 24 }, panes: [] } }
}
async function serve(handle: ConstructorParameters<typeof ApiServer>[1] = async () => ({})) {
  const dir = await mkdtemp("/tmp/smolmux-events-")
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const server = new ApiServer(join(dir, "test.api"), handle)
  await server.start()
  cleanups.push(() => server.stop())
  return server
}
async function connect(server: ApiServer, onEvent?: (event: EventFrame) => void) {
  const client = await ApiClient.connect(server.path, { onEvent })
  cleanups.push(() => client.close())
  return client
}
async function settle() { await Bun.sleep(15) }

test("published schema is generated from the runtime contract, including optional defaults", async () => {
  const document = eventSchemaDocument() as { $schema: string; $defs: { events: { anyOf: { $ref: string }[] } } }
  expect(await Bun.file(new URL("../events.schema.json", import.meta.url)).json()).toEqual(document)
  expect(document.$schema).toBe("https://json-schema.org/draft/2020-12/schema")
  expect(document.$defs.events.anyOf.map((ref) => ref.$ref)).toContain("#/$defs/apps.changed")
  for (const params of [undefined, null, {}]) {
    expect(eventSocketFrameSchema.safeParse({ v: 2, type: "request", id: "x", method: "app.create", params }).success).toBe(false)
  }
  for (const params of [undefined, null, {}, { events: ["future.*"] }]) {
    expect(eventSocketFrameSchema.safeParse({ v: 2, type: "request", id: "x", method: "event.subscribe", params }).success).toBe(true)
  }
})

test("exact, prefix and wildcard filters replace per connection, deduplicate, and survive invalid requests", async () => {
  const server = await serve()
  const left: EventFrame[] = [], right: EventFrame[] = []
  const a = await connect(server, (event) => left.push(event))
  const b = await connect(server, (event) => right.push(event))
  expect(await a.request("event.subscribe", { events: ["theme.changed", "theme.changed"] })).toEqual({ subscribed: true, events: ["theme.changed"] })
  await b.request("event.subscribe", { events: ["session.*", "future.event"] })
  const publish = () => {
    server.broadcast(eventFrame("theme.changed", { ...context, theme: "light" }))
    server.broadcast(eventFrame("session.changed", { sessionId: "00000000-0000-4000-8000-000000000001", ...context, name: "a", title: "hello" }))
  }
  publish(); await settle()
  expect(left.map((e) => e.event)).toEqual(["theme.changed"])
  expect(right.map((e) => e.event)).toEqual(["session.changed"])
  for (const events of [[], ["Bad"], ["a*b"], ["a**"], ["a".repeat(129)], Array(33).fill("a")]) {
    await expect(a.call("event.subscribe", { events })).rejects.toMatchObject({ code: "invalid_params" })
  }
  await expect(a.call("event.subscribe", { extra: true })).rejects.toMatchObject({ code: "invalid_params" })
  publish(); await settle()
  expect(left.map((e) => e.event)).toEqual(["theme.changed", "theme.changed"])
  await a.request("event.subscribe", { events: ["*"] })
  publish(); await settle()
  expect(left.slice(-2).map((e) => e.event)).toEqual(["theme.changed", "session.changed"])
  await a.request("event.subscribe", { events: ["future.event"] })
  publish(); await settle()
  expect(left).toHaveLength(4)
  a.close(); await settle()
  expect(server.subscribers).toBe(1)
})

test("snapshot race discards older state events, preserves transient delivery, and marks disconnect unavailable", async () => {
  let server!: ApiServer
  const current = status()
  const feed = new EventFeed(() => ({ state: current, availability: "ready", reason: null }), (name, data) => server.broadcast(eventFrame(name, data as never)))
  server = await serve(async (method) => {
    if (method !== "state.get") return {}
    current.theme = "light"
    feed.publish("theme.changed", { theme: "light" })
    feed.publish("session.changed", { sessionId: "00000000-0000-4000-8000-000000000001", name: "a", title: "before watermark" })
    const snapshot = feed.snapshot()
    current.theme = "dark"
    feed.publish("theme.changed", { theme: "dark" })
    feed.publish("session.changed", { sessionId: "00000000-0000-4000-8000-000000000001", name: "a", title: "capture me" })
    return snapshot
  })
  const transient: EventFrame[] = []
  const client = await connect(server, (event) => transient.push(event))
  const states: (StateSnapshot | null)[] = []
  await client.observe((state) => states.push(structuredClone(state)))
  expect(states.map((state) => state?.state?.theme)).toEqual(["light", "dark"])
  expect(transient.map((event) => event.event)).toEqual(["session.changed", "session.changed"])
  expect(states.at(-1)?.sequence).toBe(3)
  for (const frame of transient) expect(eventSocketFrameSchema.safeParse(frame).success).toBe(true)
  server.stop(); await settle()
  expect(states.at(-1)).toBeNull()
})

test("snapshots are detached, filter independent, and bounded with explicit source failures", async () => {
  let server!: ApiServer
  const current = status()
  let availability: StateSnapshot["availability"] = "incomplete"
  const feed = new EventFeed(() => ({ state: current, availability, reason: "adoption failed for one source" }), (name, data) => server.broadcast(eventFrame(name, data as never)))
  server = await serve(async () => feed.snapshot())
  const client = await connect(server)
  await client.request("event.subscribe", { events: ["nothing.matches"] })
  feed.publish("theme.changed", { theme: "dark" })
  const snapshot = await client.request("state.get")
  expect(snapshot).toMatchObject({ sequence: 1, availability: "incomplete", state: { theme: "dark" } })
  current.layout.root = { text: "changed" }
  expect(snapshot.state?.layout.root).toBeNull()
  current.name = "x".repeat(MAX_PROJECTION_BYTES)
  availability = "ready"
  expect(await client.request("state.get")).toMatchObject({ availability: "unavailable", state: null, sequence: 1 })
})

test("lifetime restart and generation replacement invalidate prior observation; removal is not reachability", () => {
  const current = status()
  current.apps = [{ name: "a", pty: "companion", whenHidden: "keep", visible: false, error: null, lastExit: null, session: { id: "00000000-0000-4000-8000-000000000001", pid: 1, created_at: 1, state: "live" }, cwd: "/", argv: null, created_at: 1, title: "", cols: 80, rows: 24, shown: false, state: "running", labels: {} }]
  const feed = new EventFeed(() => ({ state: current, availability: "ready", reason: null }), () => {})
  const other = new EventFeed(() => ({ state: current, availability: "ready", reason: null }), () => {})
  const observation = new EventObservation()
  const snapshot = feed.snapshot()
  observation.replace(snapshot)
  const ctx = { instanceId: snapshot.instanceId, generation: 1 as const, sequence: 1 }
  observation.apply(eventFrame("app.state", { ...ctx, app: { ...current.apps[0]!, state: "unreachable" } }))
  expect(observation.current?.state?.apps).toHaveLength(1)
  expect(observation.current?.state?.apps[0]?.state).toBe("unreachable")
  observation.apply(eventFrame("apps.changed", { ...ctx, sequence: 2, apps: [], availability: "ready", reason: null }))
  expect(observation.current?.state?.apps).toEqual([])
  observation.apply(eventFrame("theme.changed", { ...ctx, instanceId: other.snapshot().instanceId, sequence: 3, theme: "light" }))
  expect(observation.current).toBeNull()
  observation.replace(feed.snapshot())
  observation.apply({ ...eventFrame("theme.changed", { ...ctx, theme: "light" }), data: { ...ctx, generation: 2, theme: "light" } } as unknown as EventFrame)
  expect(observation.current).toBeNull()
  expect(other.snapshot().sequence).toBe(0)
})

test("wire validation rejects unknown envelope fields and invalid versions/IDs, preserving subscription", async () => {
  const server = await serve()
  const replies: Record<string, unknown>[] = []
  const lines = new LineBuffer(4 * 1024 * 1024)
  const socket = await Bun.connect({ unix: server.path, socket: { data: (_s, data) => lines.push(data, (line) => replies.push(JSON.parse(line))) } })
  cleanups.push(() => { socket.terminate() })
  const base = { v: 2, type: "request", id: "a", method: "event.subscribe", params: {} }
  socket.write(`${JSON.stringify(base)}\n`)
  for (const extra of [{ surprise: true }, { v: 1 }, { id: "" }, { id: "x".repeat(129) }]) socket.write(`${JSON.stringify({ ...base, ...extra })}\n`)
  socket.write(`${JSON.stringify({ ...base, id: "null", params: null })}\n`)
  await settle()
  expect(replies.map((reply) => reply.ok)).toEqual([true, false, false, false, false, true])
  expect(server.subscribers).toBe(1)
})

test("fragmented UTF-8 requests survive every split; an oversized line is correlated and disconnected", async () => {
  const server = await serve(async (_method, params) => params)
  const replies: any[] = []
  const lines = new LineBuffer(4 * 1024 * 1024)
  const socket = await Bun.connect({ unix: server.path, socket: { data: (_s, data) => lines.push(data, (line) => replies.push(JSON.parse(line))) } })
  cleanups.push(() => { socket.terminate() })
  const bytes = Buffer.from(`${JSON.stringify({ v: 2, type: "request", id: "unicode", method: "client.copy", params: { text: "é漢🙂" } })}\n`)
  for (const byte of bytes) { socket.write(Uint8Array.of(byte)); await Bun.sleep(1) }
  await settle()
  expect(replies[0]).toMatchObject({ id: "unicode", ok: true, result: { text: "é漢🙂" } })
  const oversized = Buffer.from('{"id":"oversize","padding":"' + 'x'.repeat((1 << 20) + 1))
  for (let offset = 0; offset < oversized.length;) {
    const written = socket.write(oversized.subarray(offset, offset + 8192))
    if (written < 0) break
    offset += written
    await Bun.sleep(1)
  }
  await settle()
  expect(replies[1]).toMatchObject({ id: "oversize", ok: false, error: { code: "invalid_request" } })
})

test("binding and discovery refuse foreign, permissive, and symlink paths without removing them", async () => {
  const server = await serve()
  await checkEventSocketOwnership(server.path)
  await expect(checkEventSocketOwnership(server.path, userInfo().uid + 1)).rejects.toThrow("owned by this user")
  await chmod(server.path, 0o666)
  await expect(checkEventSocketOwnership(server.path)).rejects.toThrow("0600")
  await chmod(server.path, 0o600)
  const unsafe = join(server.path, "..", "foreign.api")
  await writeFile(unsafe, "foreign", { mode: 0o600 })
  const impostor = new ApiServer(unsafe, async () => ({}))
  await expect(impostor.start()).rejects.toThrow("event socket")
  expect(await Bun.file(unsafe).text()).toBe("foreign")
  const alias = join(server.path, "..", "alias.api")
  await symlink(server.path, alias)
  await expect(checkEventSocketOwnership(alias)).rejects.toThrow("event socket")
  expect((await lstat(alias)).isSymbolicLink()).toBe(true)
})

test("the 129th connection and 129th pending request are dropped without blocking another client", async () => {
  const release = Promise.withResolvers<void>()
  const server = await serve(async () => { await release.promise; return {} })
  const sockets = []
  for (let i = 0; i < 128; i++) sockets.push(await connect(server))
  const overflow = await connect(server)
  await expect(overflow.call("layout.get")).rejects.toThrow()
  sockets[0]!.close(); await settle()
  let closed = false
  const raw = await Bun.connect({ unix: server.path, socket: { data: () => {}, close: () => { closed = true } } })
  cleanups.push(() => { raw.terminate() })
  raw.write(Array.from({ length: 129 }, (_, i) => JSON.stringify({ v: 2, type: "request", id: String(i), method: "layout.get" }) + "\n").join(""))
  await settle()
  expect(closed).toBe(true)
  release.resolve()
  expect(await sockets[1]!.call("layout.get")).toEqual({})
})

test("a slow subscriber is dropped without delaying a separately filtered observer", async () => {
  const server = await serve(async () => ({}))
  const received: EventFrame[] = []
  const fast = await connect(server, (event) => received.push(event))
  await fast.request("event.subscribe", { events: ["theme.*"] })
  const slow = await connect(server)
  await slow.request("event.subscribe", { events: ["session.*"] })
  const frame = eventFrame("session.changed", { sessionId: "00000000-0000-4000-8000-000000000001", ...context, name: "a", title: "x".repeat(40000) })
  for (let i = 0; i < 4000 && server.subscribers > 1; i++) server.broadcast(frame)
  expect(server.subscribers).toBe(1)
  server.broadcast(eventFrame("theme.changed", { ...context, theme: "light" }))
  expect(await fast.call("layout.get")).toEqual({})
  expect(received.map((event) => event.event)).toEqual(["theme.changed"])
})

test("event-socket selects exactly default or named live Instance and never starts a missing one", async () => {
  const { resolveInstance } = await import("../src/instance.ts")
  const { apiSocketPathFor } = await import("../src/api-server.ts")
  const { ensurePrivateDirectories } = await import("../src/private-directory.ts")
  const { privateRootDirectory } = await import("../src/zmx-environment.ts")
  await ensurePrivateDirectories([privateRootDirectory()], "test")
  const config = await mkdtemp("/tmp/smolmux-discovery-")
  cleanups.push(() => rm(config, { recursive: true, force: true }))
  const env = { ...process.env, XDG_CONFIG_HOME: config }
  for (const name of ["default", "other"]) {
    const instance = resolveInstance(name, env)
    const path = apiSocketPathFor(instance.id)
    const server = new ApiServer(path, async () => ({ ...status(), instance_id: instance.id, name, socket: path }))
    await server.start()
    cleanups.push(() => server.stop())
  }
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "src/index.ts", "event-socket", ...args], { cwd: new URL("..", import.meta.url).pathname, env, stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { code, stdout, stderr }
  }
  expect(await run()).toEqual({ code: 0, stdout: apiSocketPathFor(resolveInstance("default", env).id) + "\n", stderr: "" })
  expect(await run("--name", "other")).toEqual({ code: 0, stdout: apiSocketPathFor(resolveInstance("other", env).id) + "\n", stderr: "" })
  expect((await run("--name", "other", "--name", "default")).code).toBe(2)
  expect((await run("--name", "missing")).code).toBe(1)
  expect(await Bun.file(apiSocketPathFor(resolveInstance("missing", env).id)).exists()).toBe(false)
})

test("snapshot buffering is bounded and a failed observation becomes unavailable", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const server = await serve(async () => { entered.resolve(); await release.promise; return {} })
  const client = await connect(server)
  const states: (StateSnapshot | null)[] = []
  const observing = client.observe((state) => states.push(state))
  const rejected = observing.then(() => null, (error: Error) => error)
  await entered.promise
  for (let sequence = 1; sequence <= 4097; sequence++) {
    server.broadcast(eventFrame("theme.changed", { ...context, sequence, theme: "dark" }))
  }
  expect((await rejected)?.message).toBe("snapshot event buffer is full")
  expect(states.at(-1)).toBeNull()
  release.resolve()
})
