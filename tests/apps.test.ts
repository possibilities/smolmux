import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Runtime } from "../src/runtime.ts"
import { eventSocketFrameSchema } from "../src/event-schema.ts"
import type { AppView, EventName, Method, Params, Result } from "../src/protocol.ts"
import type { LocalProcessOwner, SessionExit, SessionStart, SessionTransport, TransportHandlers } from "../src/session-transport.ts"
import type { SessionIdentity } from "../src/session-identity.ts"

const exit: SessionExit = { code: 0, signal: 0, reason: "natural" }
class Owner implements LocalProcessOwner {
  starts: SessionStart[] = []
  active = new Map<string, { handlers: TransportHandlers | null; input: string[] }>()
  pauses: boolean[] = []
  gate: Promise<void> | null = null
  peak = 0
  async start(request: SessionStart): Promise<SessionTransport> {
    this.starts.push(request)
    const record = { handlers: null as TransportHandlers | null, input: [] as string[] }
    this.active.set(request.identity.id, record)
    this.peak = Math.max(this.peak, this.active.size)
    return { pid: 123, bind: handlers => { record.handlers = handlers; handlers.output(new TextEncoder().encode("ready")) }, write: bytes => { record.input.push(new TextDecoder().decode(bytes)) }, resize: () => {}, detach: () => { record.handlers = null } }
  }
  async attach(): Promise<SessionTransport> { throw new Error("local Sessions cannot reattach") }
  async pause(_identity: SessionIdentity, value: boolean) { this.pauses.push(value); if (this.gate) await this.gate }
  async terminate(identity: SessionIdentity): Promise<SessionExit> {
    if (this.gate) await this.gate
    this.end(identity.id)
    return exit
  }
  end(id: string, status = exit) { const record = this.active.get(id); this.active.delete(id); record?.handlers?.exit(status) }
  async close() { for (const id of this.active.keys()) this.end(id) }
}
async function harness() {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const owner = new Owner(), events: { event: EventName; data: unknown }[] = []
  const runtime = new Runtime(setup.renderer, {
    instanceId: "apps-test", instanceName: "apps", socketPath: "/tmp/apps-test.api", adopt: false,
    theme: { theme: "dark", background: null, source: "default", explicit: false },
    sessions: { instanceId: "apps-test", local: owner, environment: {} },
    publish: (event, data) => {
      expect(eventSocketFrameSchema.safeParse({ v: 2, type: "event", event, data }).success).toBe(true)
      events.push({ event, data })
    },
  })
  const call = <M extends Method>(method: M, params: Params<M>) => runtime.handle(method, params) as Promise<Result<M>>
  await runtime.start()
  await call("layout.apply", { root: null, visible: [], focus: null })
  return { setup, owner, events, runtime, call, close: () => runtime.shutdown() }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check() && Date.now() < deadline) await Bun.sleep(5)
  expect(check()).toBe(true)
}
const declaration = (whenHidden: "stop" | "pause" | "keep") => ({ name: "tool", pty: "local" as const, whenHidden, argv: ["tool"], cwd: "/" })

test("hidden stop defers startup, reveal focuses it, squeezing preserves it, hide destroys execution", async () => {
  const h = await harness()
  try {
    expect(await h.call("app.create", declaration("stop"))).toMatchObject({ state: "stopped", session: null, visible: false })
    expect(h.owner.starts).toHaveLength(0)
    const layout = await h.call("layout.apply", { root: { app: "tool" }, visible: ["tool"], focus: "tool" })
    expect(layout.focus).toBe("tool")
    await until(() => h.runtime.apps.view("tool").state === "running")
    const first = h.runtime.apps.view("tool").session!.id
    expect(h.runtime.apps.terminalFor("tool")!.focused).toBe(true)
    await h.call("layout.apply", { root: { row: [{ text: "wide", min: 80 }, { app: "tool", min: 20 }] }, visible: ["tool"], focus: "tool" })
    expect(h.runtime.apps.view("tool")).toMatchObject({ state: "running", visible: true, shown: false, session: { id: first } })
    await h.call("layout.apply", { root: null, visible: [], focus: null })
    await until(() => h.runtime.apps.view("tool").state === "stopped")
    expect(h.runtime.apps.terminalFor("tool")).toBeNull()
    await expect(h.call("app.capture", { name: "tool" })).rejects.toMatchObject({ code: "not_running" })
    await h.call("layout.apply", { root: { app: "tool" }, visible: ["tool"], focus: "tool" })
    await until(() => h.runtime.apps.view("tool").state === "running")
    expect(h.runtime.apps.view("tool").session!.id).not.toBe(first)
    await expect(h.call("app.input", { name: "tool", sessionId: first, events: [{ key: "enter" }] })).rejects.toMatchObject({ code: "conflict" })
  } finally { await h.close() }
})

test("pause keeps capture and execution, refuses input through transitions and resumes", async () => {
  const h = await harness()
  try {
    await h.call("app.create", declaration("pause"))
    await h.call("layout.apply", { root: { app: "tool" }, visible: ["tool"], focus: "tool" })
    await until(() => h.runtime.apps.view("tool").state === "running")
    const first = await h.call("app.capture", { name: "tool" })
    const gate = Promise.withResolvers<void>(); h.owner.gate = gate.promise
    await h.call("layout.apply", { root: null, visible: [], focus: null })
    await until(() => h.runtime.apps.view("tool").state === "pausing")
    await expect(h.call("app.input", { name: "tool", events: [{ text: "bad" }] })).rejects.toMatchObject({ code: "not_running" })
    gate.resolve(); h.owner.gate = null
    await until(() => h.runtime.apps.view("tool").state === "paused")
    expect(await h.call("app.capture", { name: "tool" })).toMatchObject({ sessionId: first.sessionId, lines: first.lines, state: "paused" })
    await h.call("layout.apply", { root: { app: "tool" }, visible: ["tool"], focus: "tool" })
    await until(() => h.runtime.apps.view("tool").state === "running")
    expect(h.owner.pauses).toEqual([true, false])
    expect(h.runtime.apps.view("tool").session!.id).toBe(first.sessionId)
  } finally { h.owner.gate = null; await h.close() }
})

test("rapid hide/reveal serializes termination and starts only one replacement", async () => {
  const h = await harness()
  const gate = Promise.withResolvers<void>()
  try {
    await h.call("app.create", declaration("stop"))
    await h.call("layout.apply", { root: { app: "tool" }, visible: ["tool"], focus: "tool" })
    await until(() => h.runtime.apps.view("tool").state === "running")
    h.owner.gate = gate.promise
    await h.call("layout.apply", { root: null, visible: [], focus: null })
    await until(() => h.runtime.apps.view("tool").state === "stopping")
    await h.call("layout.apply", { root: { app: "tool" }, visible: ["tool"], focus: "tool" })
    gate.resolve(); h.owner.gate = null
    await until(() => h.runtime.apps.view("tool").state === "running")
    expect(h.owner.starts).toHaveLength(2)
    expect(h.owner.peak).toBe(1)
  } finally { gate.resolve(); h.owner.gate = null; await h.close() }
})

test("natural exit remains declared without auto-restart; deferred restart publishes new command", async () => {
  const h = await harness()
  try {
    await h.call("app.create", declaration("stop"))
    await h.call("layout.apply", { root: { app: "tool" }, visible: ["tool"], focus: "tool" })
    await until(() => h.runtime.apps.view("tool").state === "running")
    h.owner.end(h.runtime.apps.view("tool").session!.id)
    expect(h.runtime.apps.view("tool")).toMatchObject({ state: "exited", session: null, lastExit: { cause: "natural" } })
    await h.call("layout.apply", { root: null, visible: [], focus: null })
    h.events.length = 0
    await h.call("app.restart", { name: "tool", command: { argv: ["new"], cwd: "/tmp" } })
    expect(h.owner.starts).toHaveLength(1)
    expect((h.events.find(e => e.event === "app.state")!.data as { app: AppView }).app).toMatchObject({ state: "stopped", argv: ["new"], cwd: "/tmp" })
    await h.call("app.remove", { name: "tool" })
    expect((await h.call("app.list", {})).apps).toEqual([])
  } finally { await h.close() }
})

test("invalid or stale Layout never changes visibility or process policy", async () => {
  const h = await harness()
  try {
    await h.call("app.create", declaration("stop"))
    for (const params of [
      { root: { app: "tool" }, visible: [] },
      { root: { row: [{ app: "tool" }, { app: "tool" }] }, visible: ["tool"] },
      { root: { app: "tool" }, visible: ["tool"], revision: 0 },
    ]) await expect(h.call("layout.apply", params)).rejects.toBeDefined()
    expect(h.runtime.apps.view("tool")).toMatchObject({ visible: false, state: "stopped" })
    expect(h.owner.starts).toHaveLength(0)
  } finally { await h.close() }
})

test("unknown child status reaches the exit event and retained App unchanged", async () => {
  const h = await harness()
  try {
    await h.call("app.create", declaration("keep"))
    const sessionId = h.runtime.apps.view("tool").session!.id
    const status = { code: null, signal: null, reason: "natural" }
    h.owner.end(sessionId, status)
    expect(h.runtime.apps.view("tool").lastExit).toEqual({ sessionId, ...status, cause: "natural" })
    expect(h.events.find(e => e.event === "session.exited")?.data).toMatchObject({ name: "tool", sessionId, ...status, cause: "natural" })
  } finally { await h.close() }
})
