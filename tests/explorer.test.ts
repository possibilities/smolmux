import { afterEach, expect, test } from "bun:test"
import { chmod, symlink } from "node:fs/promises"
import { join } from "node:path"
import { demoSnapshot } from "../examples/explorer/demo.ts"
import { discoverInstances } from "../examples/explorer/discovery.ts"
import { appLeaf, planNavigation } from "../examples/explorer/navigation.ts"
import { startBridge } from "../examples/explorer/bridge.ts"
import type { ExplorerMessage, Navigation } from "../examples/explorer/wire.ts"
import type { Capture } from "../src/protocol.ts"
import { explorerFixture } from "./explorer-fixture.ts"

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const navigate = (snapshot = demoSnapshot(), name = "api", action: Navigation["action"] = "reveal"): Navigation => ({
  type: "navigate",
  id: "1",
  name,
  action,
  instanceId: snapshot.instanceId,
  revision: snapshot.state!.layout.revision,
})

test("Focus preserves the complete tree and visibility, including logical Apps omitted from the tree", () => {
  const snapshot = demoSnapshot()
  snapshot.state!.layout.visible.push("api")
  const before = structuredClone(snapshot)
  const next = planNavigation(snapshot, navigate(snapshot, "tests", "focus"))
  expect(next).toEqual({
    root: before.state!.layout.root,
    visible: before.state!.layout.visible,
    revision: 1,
    focus: "tests",
  })
  expect(snapshot).toEqual(before)
})

test("reveal keeps every visible App and does not activate size/min on the former root", () => {
  const snapshot = demoSnapshot()
  snapshot.state!.layout.root!.size = 1
  snapshot.state!.layout.root!.min = 1
  const next = planNavigation(snapshot, navigate(snapshot))
  expect(next.visible).toEqual(["editor", "preview", "tests", "api"])
  expect(next.focus).toBe("api")
  expect(next.revision).toBe(1)
  expect(next.root && "row" in next.root && next.root.row[0]!.size).toBeUndefined()
  expect(appLeaf(next.root, "editor")).toEqual({ app: "editor" })
  expect(snapshot.state!.layout.root!.size).toBe(1)
})

test("rejects stale Revision and restarted Runtime before navigation", () => {
  const snapshot = demoSnapshot()
  expect(() => planNavigation(snapshot, { ...navigate(snapshot), revision: 0 })).toThrow("Layout changed")
  expect(() => planNavigation(snapshot, { ...navigate(snapshot), instanceId: "previous" })).toThrow("Runtime restarted")
  snapshot.availability = "unavailable"
  expect(() => planNavigation(snapshot, navigate(snapshot))).toThrow("not ready")
})

test("never Focus and squeezed Panes cannot be navigated as if they receive input", () => {
  const snapshot = demoSnapshot()
  appLeaf(snapshot.state!.layout.root, "editor")!.focusMode = "never"
  expect(() => planNavigation(snapshot, navigate(snapshot, "editor", "focus"))).toThrow("does not permit Focus")
  snapshot.state!.layout.panes.find((pane) => pane.app === "tests")!.cols = 0
  expect(() => planNavigation(snapshot, navigate(snapshot, "tests", "focus"))).toThrow("no fitted Pane")
  expect(() => planNavigation(snapshot, navigate(snapshot, "tests"))).toThrow("already in the Layout")
})

test("a small Stage refuses reveal and leaves hidden stop/pause declarations untouched", () => {
  const snapshot = demoSnapshot()
  snapshot.state!.layout.stage = { cols: 16, rows: 3 }
  const before = structuredClone(snapshot)
  expect(() => planNavigation(snapshot, navigate(snapshot, "traces"))).toThrow("Stage is too small")
  expect(snapshot).toEqual(before)
})

async function setup() {
  const fixture = await explorerFixture()
  cleanups.push(() => fixture.close())
  const bridge = startBridge({
    assets: new Map(),
    html: "<html>explorer</html>",
    port: 0,
    directory: fixture.directory,
  })
  cleanups.push(() => bridge.stop())
  return { fixture, bridge, origin: new URL(bridge.url).origin }
}

async function peer(origin: string, token: string, instance: string) {
  const messages: ExplorerMessage[] = []
  const listeners = new Set<(message: ExplorerMessage) => void>()
  // lib.dom selects the browser overload; this socket is Bun's server-side constructor.
  const LocalWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket
  const ws = new LocalWebSocket(`${origin.replace("http:", "ws:")}/live?instance=${instance}&token=${token}`, {
    headers: { Origin: origin },
  })
  cleanups.push(async () => {
    ws.close()
  })
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as ExplorerMessage
    messages.push(message)
    for (const listener of listeners) listener(message)
  })
  function wait(predicate: (message: ExplorerMessage) => boolean): Promise<ExplorerMessage> {
    const found = messages.find(predicate)
    if (found) return Promise.resolve(found)
    return new Promise((resolve, reject) => {
      const listener = (message: ExplorerMessage) => {
        if (!predicate(message)) return
        clearTimeout(timer)
        listeners.delete(listener)
        resolve(message)
      }
      const timer = setTimeout(() => {
        listeners.delete(listener)
        reject(new Error("Explorer message deadline"))
      }, 2500)
      listeners.add(listener)
    })
  }
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true })
    ws.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true })
  })
  return { ws, messages, wait }
}

test("discovers live, owned socket identities; refuses symlinks and unsafe permissions without cleanup", async () => {
  const { fixture } = await setup()
  await symlink(fixture.path, join(fixture.directory, "0abc00000002.api"))
  const discovery = await discoverInstances(fixture.directory)
  expect(discovery.instances).toEqual([
    { id: fixture.id, name: "explorer-check", host: "foreground", apps: 6, running: 4, hidden: 3 },
  ])
  expect(discovery.skipped).toBe(1)
  await chmod(fixture.path, 0o666)
  expect((await discoverInstances(fixture.directory)).instances).toEqual([])
  await chmod(fixture.path, 0o600)
  await chmod(fixture.directory, 0o755)
  expect((await discoverInstances(fixture.directory)).warning).toContain("0700")
  await chmod(fixture.directory, 0o700)
})

test("loopback HTTP refuses missing capability, foreign Origin, foreign Host and arbitrary routes", async () => {
  const { bridge, origin } = await setup()
  const authorization = `Bearer ${bridge.token}`
  expect((await fetch(`${origin}/instances`)).status).toBe(401)
  expect(
    (await fetch(`${origin}/instances`, { headers: { authorization, Origin: "https://other.example" } })).status,
  ).toBe(403)
  expect((await fetch(`${origin}/instances`, { headers: { authorization, Host: "other.example" } })).status).toBe(403)
  expect((await fetch(`${origin}/instances`, { method: "POST", headers: { authorization } })).status).toBe(405)
  expect((await fetch(`${origin}/api/instance.stop`, { headers: { authorization } })).status).toBe(404)
  const response = await fetch(`${origin}/instances`, { headers: { authorization } })
  expect(response.status).toBe(200)
  expect(response.headers.get("access-control-allow-origin")).toBeNull()
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
  expect(((await response.json()) as { instances: unknown[] }).instances).toHaveLength(1)
})

test("WebSocket handshake requires capability, exact Origin and an Instance id, not a path", async () => {
  const { fixture, origin, bridge } = await setup()
  for (const [originHeader, token, id] of [
    ["https://other.example", bridge.token, fixture.id],
    [origin, "wrong", fixture.id],
    [origin, bridge.token, "../other"],
  ]) {
    const response = await fetch(`${origin}/live?instance=${encodeURIComponent(id!)}&token=${token}`, {
      headers: {
        Origin: originHeader!,
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": "MDEyMzQ1Njc4OWFiY2RlZg==",
        "Sec-WebSocket-Version": "13",
      },
    })
    expect(response.status).toBe(403)
  }
})

test("observes every App and captures hidden/paused Sessions; history guards the Session UUID", async () => {
  const { fixture, origin, bridge } = await setup()
  const client = await peer(origin, bridge.token, fixture.id)
  const state = await client.wait((message) => message.type === "state" && !!message.snapshot)
  expect(state.type === "state" && state.snapshot!.state!.apps).toHaveLength(6)
  await client.wait((message) => message.type === "capture" && message.capture.name === "traces")
  await client.wait((message) => message.type === "capture" && message.capture.name === "api")
  expect(fixture.calls.filter((call) => call.method === "app.capture")).toHaveLength(5)
  const traces = fixture.snapshot.state!.apps.find((app) => app.name === "traces")!
  client.ws.send(JSON.stringify({ type: "history", id: "history-1", name: "traces", sessionId: traces.session!.id }))
  const history = await client.wait((message) => message.type === "history")
  expect(history.type === "history" && history.capture.screen_start).toBe(1)
  client.ws.send(JSON.stringify({ type: "history", id: "stale", name: "traces", sessionId: crypto.randomUUID() }))
  await client.wait((message) => message.type === "error" && message.id === "stale")
})

test("live Focus/reveal is guarded at the API boundary and unknown browser operations never execute", async () => {
  const { fixture, origin, bridge } = await setup()
  const client = await peer(origin, bridge.token, fixture.id)
  await client.wait((message) => message.type === "state" && !!message.snapshot)
  client.ws.send(JSON.stringify({ type: "instance.stop", id: "bad" }))
  await client.wait((message) => message.type === "error" && message.message.includes("Unknown"))
  expect(fixture.calls.some((call) => call.method === "instance.stop")).toBe(false)
  client.ws.send(JSON.stringify(navigate(fixture.snapshot)))
  await client.wait((message) => message.type === "navigated" && message.id === "1")
  expect(fixture.snapshot.state!.layout.visible).toEqual(["editor", "preview", "tests", "api"])
  client.ws.send(JSON.stringify({ ...navigate(fixture.snapshot, "preview", "focus"), id: "stale", revision: 1 }))
  await client.wait((message) => message.type === "error" && message.id === "stale")
  expect(fixture.calls.filter((call) => call.method === "layout.apply")).toHaveLength(1)
})

test("a Capture finishing after Session replacement is discarded", async () => {
  const { fixture, origin, bridge } = await setup()
  const pending = Promise.withResolvers<Capture>()
  let oldCapture: Capture | undefined
  fixture.holdCaptures(async (capture) => {
    if (capture.name === "editor") {
      oldCapture = capture
      return pending.promise
    }
    return capture
  })
  const client = await peer(origin, bridge.token, fixture.id)
  await client.wait((message) => message.type === "capture" && message.capture.name === "preview")
  const editor = fixture.snapshot.state!.apps[0]!
  editor.session!.id = crypto.randomUUID()
  fixture.publish("app.state", { app: editor })
  await client.wait(
    (message) => message.type === "state" && message.snapshot?.state?.apps[0]?.session?.id === editor.session!.id,
  )
  fixture.holdCaptures(null)
  pending.resolve(oldCapture!)
  await client.wait((message) => message.type === "capture" && message.capture.sessionId === editor.session!.id)
  expect(
    client.messages.some(
      (message) => message.type === "capture" && message.capture.sessionId === oldCapture!.sessionId,
    ),
  ).toBe(false)
})

test("Runtime disconnection invalidates observation and closes the browser connection", async () => {
  const { fixture, origin, bridge } = await setup()
  const client = await peer(origin, bridge.token, fixture.id)
  await client.wait((message) => message.type === "state" && !!message.snapshot)
  const closed = new Promise<void>((resolve) => client.ws.addEventListener("close", () => resolve(), { once: true }))
  fixture.server.stop()
  await client.wait((message) => message.type === "state" && message.snapshot === null)
  await closed
})

test("an invalidated projection is resnapshotted so a recovered Instance becomes observable again", async () => {
  const { fixture, origin, bridge } = await setup()
  const client = await peer(origin, bridge.token, fixture.id)
  await client.wait((message) => message.type === "state" && !!message.snapshot)
  fixture.publish("state.invalidated", { reason: "Projection exceeded the publication bound" })
  await client.wait((message) => message.type === "state" && message.snapshot?.state === null)
  await client.wait(
    (message) =>
      message.type === "state" && message.snapshot?.sequence === fixture.snapshot.sequence && !!message.snapshot.state,
  )
  expect(fixture.calls.filter((call) => call.method === "state.get").length).toBeGreaterThanOrEqual(2)
})
