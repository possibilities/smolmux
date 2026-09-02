import { expect, test } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { AdeAgentState, AdeAttentionKind, AdeRecord } from "../src/ade-events.ts"
import type { AgentDefaults } from "../src/config.ts"
import { ControlFailure, type Snapshot } from "../src/control-protocol.ts"
import {
  FxWorkControlError,
  type FxWorkControlBinding,
  type FxWorkControlMethod,
  type FxWorkControlRequester,
  type FxWorkControlResult,
} from "../src/fx-work-control.ts"
import { resolveKeybindings } from "../src/keybindings.ts"
import { fmxTerminalTitle, Multiplexer, RuntimeExtensionSurfaceError } from "../src/multiplexer.ts"
import type {
  RuntimeMemberCorrelation,
  RuntimeMemberCorrelationEntry,
  RuntimeMemberCorrelationSource,
} from "../src/runtime-member-correlation.ts"
import { instanceIdForPane, record as feedRecord, TestAdeSocket } from "./fixtures/ade-feed.ts"
import { initRepository } from "./fixtures/git-workspace.ts"
import { agentOptions } from "./fixtures/pty-transport.ts"

const FAKE_FX = fileURLToPath(new URL("./fixtures/fake-fx.ts", import.meta.url))
const RUNTIME_PATH = `/tmp/fmx-control-test-${process.pid}.bus`
const NEVER = new AbortController().signal

type Setup = Awaited<ReturnType<typeof createTestRenderer>>

const WORK_SNAPSHOT = {
  active_turn_id: "41",
  queue_paused: false,
  queue: [{
    turn_id: "42",
    kind: "steering" as const,
    text: "next",
    has_images: false,
    has_skill_bindings: false,
    has_review_draft: false,
  }],
}

type WorkCall = {
  binding: FxWorkControlBinding
  method: FxWorkControlMethod
  params: Record<string, unknown>
  signal: AbortSignal
}

class FakeWorkControl implements FxWorkControlRequester {
  readonly calls: WorkCall[] = []
  failure: FxWorkControlError | null = null

  async request(
    binding: FxWorkControlBinding,
    method: FxWorkControlMethod,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FxWorkControlResult> {
    this.calls.push({ binding, method, params, signal })
    if (this.failure) throw this.failure
    return method === "work.queue" || method === "work.steer"
      ? { snapshot: WORK_SNAPSHOT, turn_id: "42", disposition: method === "work.steer" ? "steering" : "queued" }
      : { snapshot: WORK_SNAPSHOT }
  }
}

class FakeRuntimeMemberCorrelationSource implements RuntimeMemberCorrelationSource {
  calls = 0
  entries: RuntimeMemberCorrelationEntry[] = []
  failure: Error | null = null

  async snapshot(): Promise<readonly RuntimeMemberCorrelationEntry[]> {
    this.calls++
    if (this.failure) throw this.failure
    return structuredClone(this.entries)
  }
}

function memberCorrelation(index: number): RuntimeMemberCorrelation {
  return {
    ensure_id: `ensure-${index}`,
    ensure_digest: index.toString(16).padStart(64, "0"),
    launch_id: `launch-${index}`,
    launch_digest: (index + 16).toString(16).padStart(64, "0"),
  }
}

async function workspace(): Promise<{ home: string; code: string }> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "fmx-control-")))
  const code = join(home, "code")
  // Unborn repositories: nothing is committed, which is what proves an
  // unborn HEAD still draws its branch in the tray rows asserted below.
  for (const name of ["alpha", "beta"]) await initRepository(join(code, name), "trunk")
  return { home, code }
}

async function harness(
  name: string,
  fmxName?: string,
  agentDefaults?: AgentDefaults,
  runtimeMemberCorrelationSource?: RuntimeMemberCorrelationSource,
) {
  const { home, code } = await workspace()
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true, exitOnCtrlC: false })
  const adeSocket = new TestAdeSocket(`/tmp/fmx-control-test-${name}-${process.pid}.ade.sock`)
  const options = agentOptions()
  const fxWorkControl = new FakeWorkControl()
  const multiplexer = new Multiplexer(setup.renderer, {
    ...options,
    fxPath: FAKE_FX,
    cwd: join(code, "alpha"),
    keybindings: resolveKeybindings().keybindings,
    fmxName,
    home,
    adeSocket,
    runtimeSocketPath: RUNTIME_PATH,
    projectRoots: [code],
    agentDefaults,
    fxWorkControl,
    runtimeMemberCorrelationSource,
  })
  const control = (method: Parameters<typeof multiplexer.control.handle>[0], params: Record<string, unknown> = {}) =>
    multiplexer.control.handle(method, params, NEVER)
  const close = async () => {
    await multiplexer.shutdown()
  }
  /**
   * The pane id fx would address: an Agent's is minted with its identity,
   * so a test names the Agent by number and looks the pane up.
   */
  const paneOf = async (ref: string): Promise<string> => {
    const match = /^p_(\d+)$/.exec(ref)
    if (!match) return ref
    const snapshot = (await control("orient")) as Snapshot
    const info = snapshot.agents.find((candidate) => candidate.id === Number(match[1]))
    if (!info) throw new Error(`no agent ${match[1]}`)
    return info.pane_id
  }
  /** Publish the same lifecycle snapshot Fx places on every ADE record. */
  const report = async (pane: string, state: AdeAgentState, attention: AdeAttentionKind | null = null) => {
    const paneId = await paneOf(pane)
    if (state === "working") adeSocket.main(paneId, "PromptQueued", { state })
    else if (state === "blocked") adeSocket.main(paneId, "AttentionRequired", { state, attention })
    else adeSocket.main(paneId, "PostTurnEnd", { state })
    await setup.renderOnce()
  }
  const session = async (pane: string, sessionId: string) => {
    const paneId = await paneOf(pane)
    adeSocket.main(paneId, "SessionChanged", { sessionId })
    await setup.renderOnce()
  }
  const start = async (params: {
    directory?: string
    worktree?: boolean
    focus?: boolean
  } = {}) => ({
    agent: await multiplexer.createAgent({
      directory: params.directory ?? join(code, "alpha"),
      worktree: params.worktree,
      focus: params.focus,
    }),
  })
  await multiplexer.start()
  return { setup, multiplexer, control, close, report, session, start, home, code, adeSocket, options, fxWorkControl }
}

async function sendAde(socket: TestAdeSocket, record: AdeRecord): Promise<void> {
  socket.emit(record)
}

function adeRecord(
  sequence: number,
  instanceId: string,
  event: string,
  sessionId: string | null,
  payload: Record<string, unknown> = {},
): AdeRecord {
  return {
    schemaVersion: 1,
    sequence,
    event,
    instanceId,
    context: {
      agentRole: "main",
      workspaceRoot: null,
      sessionId,
      parentSessionId: null,
      subagentId: null,
      turnId: null,
      agentState: "idle",
      attentionKind: null,
    },
    payload,
  }
}

function terminal(setup: Setup, id: number): BoxRenderable {
  return setup.renderer.root.findDescendantById(`fx-${id}`) as BoxRenderable
}

async function failure(run: Promise<unknown>): Promise<ControlFailure> {
  try {
    await run
  } catch (error) {
    if (error instanceof ControlFailure) return error
    throw error
  }
  throw new Error("expected a ControlFailure")
}

test("orients an empty fmx", async () => {
  const h = await harness("empty")
  try {
    const snapshot = (await h.control("orient", { caller: 1 })) as Snapshot
    expect(snapshot.fmx).toMatchObject({ pid: process.pid, cols: 100, rows: 30 })
    expect(snapshot.fmx).not.toHaveProperty("name")
    expect(snapshot.fmx).not.toHaveProperty("socket")
    expect(snapshot.you).toBeNull()
    expect(snapshot.active).toBeNull()
    expect(snapshot.agents).toEqual([])
    expect(snapshot.tray).toMatchObject({ visible: false, rows: [] })
    expect(snapshot.surface).toEqual({ kind: "none" })
  } finally {
    await h.close()
  }
})

test("identifies a named fmx in Orientation and terminal titles", async () => {
  const h = await harness("named", "review")
  try {
    const snapshot = (await h.control("orient")) as Snapshot
    expect(snapshot.fmx.name).toBe("review")
    expect(fmxTerminalTitle()).toBe("fmx")
    expect(fmxTerminalTitle(undefined, "agent")).toBe("fmx · agent")
    expect(fmxTerminalTitle("review")).toBe("fmx review")
    expect(fmxTerminalTitle("review", "agent")).toBe("fmx review · agent")
  } finally {
    await h.close()
  }
})

test("creates background Agents from explicit, caller, and configured projects", async () => {
  const h = await harness("create")
  try {
    const first = await h.control("agent.create") as { agent: Snapshot["agents"][number] }
    expect(first.agent.id).toBe(1)
    expect(first.agent.cwd).toBe(join(h.code, "alpha"))
    await h.setup.renderOnce()
    expect(terminal(h.setup, 1).visible).toBe(true)

    const second = await h.control("agent.create", {
      directory: join(h.code, "beta"),
      model: "gpt-test",
      effort: "high",
    }) as { agent: Snapshot["agents"][number] }
    await h.setup.renderOnce()
    expect(second.agent.id).toBe(2)
    expect(terminal(h.setup, 2).visible).toBe(false)
    expect(terminal(h.setup, 1).visible).toBe(true)

    const snapshot = (await h.control("orient", { caller: 1 })) as Snapshot
    expect(snapshot.active).toBe(1)
    expect(snapshot.you).toMatchObject({ id: 1, active: true, cwd: join(h.code, "alpha"), project: "alpha" })
    expect(snapshot.agents.map((agent) => [agent.id, agent.project])).toEqual([
      [1, "alpha"],
      [2, "beta"],
    ])
    expect(snapshot.tray.visible).toBe(true)
    expect(snapshot.tray.rows.map((row) => [row.kind, row.depth, row.text, row.agent])).toEqual([
      ["project", 0, "beta", null],
      ["branch", 1, "trunk", null],
      ["agent", 2, "· —", 2],
      ["project", 0, "alpha", null],
      ["branch", 1, "trunk", null],
      ["agent", 2, "· —", 1],
    ])

    const third = await h.control("agent.create", { caller: 1 }) as { agent: Snapshot["agents"][number] }
    await h.setup.renderOnce()
    expect(third.agent).toMatchObject({ id: 3, cwd: join(h.code, "alpha"), active: false })
    expect(terminal(h.setup, 3).visible).toBe(false)
    expect(terminal(h.setup, 1).visible).toBe(true)

    expect(h.options.transport.started[1]?.request.env).toMatchObject({
      FX_MODEL: "gpt-test",
      FX_EFFORT: "high",
    })
    for (const entry of h.options.manifest.entries) {
      expect(entry.workControl).toMatchObject({ instanceId: entry.agentId })
      expect(entry.workControl?.socketPath).toBe(RUNTIME_PATH.replace(/\.bus$/u, `.${entry.agentId}.fx`))
      expect(entry.workControl?.token).toMatch(/^[0-9a-f]{64}$/u)
    }
    expect(first.agent).not.toHaveProperty("workControl")
  } finally {
    await h.close()
  }
})

test("applies exact Session defaults field by field beneath explicit launch values", async () => {
  const h = await harness("defaults", undefined, {
    stateDir: "/var/tmp/fmx-session-state",
    model: "fixture/default-model",
    effort: "medium",
  })
  try {
    await h.control("agent.create", { effort: "max" })
    await h.control("agent.create", { model: "fixture/explicit-model" })
    expect(h.options.transport.started[0]?.request).toMatchObject({
      command: [FAKE_FX, "--state-dir", "/var/tmp/fmx-session-state"],
      env: { FX_MODEL: "fixture/default-model", FX_EFFORT: "max" },
    })
    expect(h.options.transport.started[1]?.request).toMatchObject({
      command: [FAKE_FX, "--state-dir", "/var/tmp/fmx-session-state"],
      env: { FX_MODEL: "fixture/explicit-model", FX_EFFORT: "medium" },
    })
    expect(h.options.manifest.entries.map((entry) => entry.fxArgs)).toEqual([
      ["--state-dir", "/var/tmp/fmx-session-state"],
      ["--state-dir", "/var/tmp/fmx-session-state"],
    ])
  } finally {
    await h.close()
  }
})

test("routes every semantic work operation to the targeted Fx authority", async () => {
  const h = await harness("work")
  try {
    const first = await h.control("agent.create") as { agent: Snapshot["agents"][number] }
    await h.control("agent.create", { directory: join(h.code, "beta") })

    expect(await h.control("work.snapshot", { caller: 1 })).toMatchObject({
      agent: { id: 1 },
      work: WORK_SNAPSHOT,
    })
    expect(await h.control("work.queue", { target: "2", text: "after this" })).toMatchObject({
      agent: { id: 2 },
      turn_id: "42",
      disposition: "queued",
      work: WORK_SNAPSHOT,
    })
    expect(await h.control("work.steer", { target: first.agent.agent_id, text: "change course" })).toMatchObject({
      agent: { id: 1 },
      disposition: "steering",
    })
    await h.control("work.interrupt", { target: "active" })
    await h.control("queue.update", { target: "1", turn_id: "42", text: "replacement" })
    await h.control("queue.delete", { target: "1", turn_id: "42" })
    await h.control("queue.resume", { target: "1" })

    expect(h.fxWorkControl.calls.map(({ binding, method, params }) => [binding.instanceId, method, params])).toEqual([
      [first.agent.agent_id, "work.snapshot", {}],
      [h.options.manifest.entries[1]!.agentId, "work.queue", { text: "after this" }],
      [first.agent.agent_id, "work.steer", { text: "change course" }],
      [first.agent.agent_id, "work.interrupt", {}],
      [first.agent.agent_id, "queue.update", { turn_id: "42", text: "replacement" }],
      [first.agent.agent_id, "queue.delete", { turn_id: "42" }],
      [first.agent.agent_id, "queue.resume", {}],
    ])

    h.fxWorkControl.failure = new FxWorkControlError("queue_editor_visible", "the human editor is open")
    const busy = await failure(h.control("work.interrupt", { target: "1" }))
    expect(busy).toMatchObject({ code: "busy", data: { fx_code: "queue_editor_visible" } })
    expect((await failure(h.control("queue.delete", { target: "1", turn_id: "0" }))).code).toBe("invalid_params")
  } finally {
    await h.close()
  }
})

test("includes filesystem subagents in the tray orientation", async () => {
  const h = await harness("subagents")
  const parent = "1787368596567-1787368596567934000-ba9a9f7e16e5ef8c"
  const child = "1787368609310-1787368609310138000-3e38dc7a8d7c16c2"
  try {
    await h.start()
    await mkdir(join(h.home, ".fx", "sessions", parent), { recursive: true })
    const subagentDirectory = join(h.home, ".fx", "sessions", child, "subagent")
    await mkdir(subagentDirectory, { recursive: true })
    await writeFile(
      join(subagentDirectory, "control.json"),
      JSON.stringify({
        schema_version: 7,
        child_id: child,
        parent_id: parent,
        generation: 1,
        configuration: { name: "test-subagent" },
        state: "completed",
        created_at_ms: 1,
      }),
    )
    await h.session("p_1", parent)

    const snapshot = await waitForSnapshot(
      () => h.control("orient") as Promise<Snapshot>,
      (candidate) => candidate.tray.rows.some((row) => row.kind === "subagent"),
    )
    expect(snapshot.tray.rows.map((row) => [row.kind, row.depth, row.text, row.agent])).toEqual([
      ["project", 0, "alpha", null],
      ["branch", 1, "trunk", null],
      ["agent", 2, "○ ba9a9f7e16e5ef8c", 1],
      ["subagent", 3, "✓ test-subagent", null],
    ])
    // The model carries them too, so an agent need not parse the drawing.
    expect(snapshot.agents[0]?.subagents).toEqual([
      { session_id: child, label: "test-subagent", state: "done", attention: null, children: [] },
    ])
    expect(((await h.control("orient", { caller: 1 })) as Snapshot).you?.subagents).toHaveLength(1)
  } finally {
    await h.close()
  }
})

test("the internal creation engine refuses requests it cannot honour without drawing anything", async () => {
  const h = await harness("refuse")
  try {
    const missing = await failure(h.start({ directory: join(h.code, "nowhere") }))
    expect(missing.code).toBe("invalid_params")

    // A directory outside any repository is not somewhere an agent can run.
    const loose = join(h.home, "loose")
    await mkdir(loose, { recursive: true })
    const outside = await failure(h.start({ directory: loose }))
    expect(outside.code).toBe("invalid_params")
    expect(outside.message).toContain("not a git repository")

    // The projects here have nothing committed, so nothing to branch from.
    const worktree = await failure(h.start({ directory: join(h.code, "beta"), worktree: true }))
    expect(worktree.code).toBe("failed")
    expect(worktree.message).toContain("no commit to branch from")
    const snapshot = (await h.control("orient")) as Snapshot
    expect(snapshot.surface).toEqual({ kind: "none" })
    expect(snapshot.agents).toEqual([])
  } finally {
    await h.close()
  }
})

test("focuses by position, id, and name, and refuses while something is open", async () => {
  const h = await harness("focus")
  try {
    await h.start()
    await h.start({ focus: false })
    await h.start({ focus: false })
    await h.setup.renderOnce()
    expect(((await h.control("orient")) as Snapshot).active).toBe(1)

    expect(await h.control("focus", { target: "next" })).toMatchObject({ agent: { id: 2 } })
    expect(await h.control("focus", { target: "previous" })).toMatchObject({ agent: { id: 1 } })
    expect(await h.control("focus", { target: "previous" })).toMatchObject({ agent: { id: 3 } })
    expect(await h.control("focus", { target: "2", caller: 1 })).toMatchObject({ agent: { id: 2 } })
    expect(await h.control("focus", { target: "current", caller: 1 })).toMatchObject({ agent: { id: 1 } })
    const identities = ((await h.control("orient")) as Snapshot).agents
    expect(await h.control("focus", { target: identities[1]!.agent_id })).toMatchObject({ agent: { id: 2 } })
    expect(await h.control("focus", { target: identities[2]!.pane_id })).toMatchObject({ agent: { id: 3 } })
    await h.control("focus", { target: "current", caller: 1 })
    await h.setup.renderOnce()
    expect(terminal(h.setup, 1).visible).toBe(true)

    await h.session("p_3", "sess_cafe0123")
    expect(await h.control("focus", { target: "sess_ca" })).toMatchObject({ agent: { id: 3 } })
    expect((await failure(h.control("focus", { target: "nobody" }))).code).toBe("not_found")
    expect((await failure(h.control("focus", { target: "9" }))).code).toBe("not_found")
    expect((await failure(h.control("focus", { target: "current" }))).code).toBe("invalid_params")

    h.setup.mockInput.pressKey("b", { ctrl: true })
    h.setup.mockInput.pressKey("?")
    await h.setup.renderOnce()
    expect(((await h.control("orient")) as Snapshot).surface).toEqual({ kind: "help" })
    const busy = await failure(h.control("focus", { target: "next" }))
    expect(busy.code).toBe("busy")
    expect(busy.data).toEqual({ surface: { kind: "help" } })
  } finally {
    await h.close()
  }
})

test("publishes authoritative member snapshots and presents through modal-safe selection", async () => {
  const h = await harness("runtime-extension-surface")
  const revisions: string[] = []
  const unsubscribe = h.multiplexer.extension.subscribeInvalidation((revision) => revisions.push(revision))
  try {
    expect(revisions).toEqual(["1"])
    await h.start()
    await h.start({ directory: join(h.code, "beta"), focus: false })
    const orientation = (await h.control("orient")) as Snapshot
    const [first, second] = orientation.agents
    await h.report("p_1", "working")

    const snapshot = await h.multiplexer.extension.snapshot()
    expect(snapshot.revision).toMatch(/^[1-9]\d*$/u)
    expect(revisions.at(-1)).toBe(snapshot.revision)
    expect(snapshot.selected_agent_id).toBe(first!.agent_id)
    expect(snapshot.agents).toEqual([
      {
        agent_id: first!.agent_id,
        pane_id: first!.pane_id,
        display_id: 1,
        created_at_ms: expect.any(Number),
        lifecycle: "running",
        state: "working",
        attention: null,
        directory: join(h.code, "alpha"),
        worktree: false,
        fx_conversation: null,
        correlation: null,
      },
      {
        agent_id: second!.agent_id,
        pane_id: second!.pane_id,
        display_id: 2,
        created_at_ms: expect.any(Number),
        lifecycle: "running",
        state: "unknown",
        attention: null,
        directory: join(h.code, "beta"),
        worktree: false,
        fx_conversation: null,
        correlation: null,
      },
    ])

    h.multiplexer.extension.present(second!.agent_id, false)
    const presentedWithoutFocus = await h.multiplexer.extension.snapshot()
    expect(presentedWithoutFocus.selected_agent_id).toBe(second!.agent_id)
    expect(BigInt(presentedWithoutFocus.revision)).toBeGreaterThan(BigInt(snapshot.revision))
    expect(terminal(h.setup, 2).visible).toBe(true)
    expect(terminal(h.setup, 2).focused).toBe(false)
    h.multiplexer.extension.present(first!.agent_id, true)
    expect(terminal(h.setup, 1).focused).toBe(true)

    const semanticRevisionCount = revisions.length
    h.multiplexer.setTheme({ theme: "light", background: "#ffffff", source: "osc11", explicit: false })
    await h.control("tray", { width: 31, hidden: true })
    expect(revisions).toHaveLength(semanticRevisionCount)

    h.setup.mockInput.pressKey("b", { ctrl: true })
    h.setup.mockInput.pressKey("?")
    await h.setup.renderOnce()
    h.multiplexer.extension.present(second!.agent_id, false)
    const presented = await h.multiplexer.extension.snapshot()
    expect(presented.selected_agent_id).toBe(second!.agent_id)
    expect(BigInt(presented.revision)).toBeGreaterThan(BigInt(presentedWithoutFocus.revision))
    expect(revisions.at(-1)).toBe(presented.revision)
    expect(terminal(h.setup, 2).focused).toBe(false)
    expect(() => h.multiplexer.extension.present(first!.agent_id, true)).toThrow(RuntimeExtensionSurfaceError)
    try {
      h.multiplexer.extension.present(first!.agent_id, true)
    } catch (error) {
      expect(error).toMatchObject({ code: "busy" })
    }
    h.setup.mockInput.pressKey("?")
    await h.setup.renderOnce()
    h.multiplexer.extension.present(first!.agent_id, true)
    expect((await h.multiplexer.extension.snapshot()).selected_agent_id).toBe(first!.agent_id)
    expect(() => h.multiplexer.extension.present("f".repeat(32), false)).toThrow("no switchable Agent")

    const duplicateConversation = "1787362101399-1787362101399156000-2897385323da2699"
    await h.session("p_1", duplicateConversation)
    await h.session("p_2", duplicateConversation)
    try {
      await h.multiplexer.extension.snapshot()
      throw new Error("expected duplicate Fx Conversation validation to fail")
    } catch (error) {
      expect(error).toMatchObject({ code: "snapshot_unavailable" })
    }
  } finally {
    unsubscribe()
    await h.close()
  }
})

test("keeps ordinary fmx Agents uncorrelated without a durable correlation source", async () => {
  const h = await harness("runtime-member-correlation-null")
  try {
    await h.start()
    expect((await h.multiplexer.extension.snapshot()).agents).toMatchObject([
      { correlation: null },
    ])
  } finally {
    await h.close()
  }
})

test("joins one correlation-source snapshot to exact Agent identities independent of order", async () => {
  const source = new FakeRuntimeMemberCorrelationSource()
  const h = await harness(
    "runtime-member-correlation-exact",
    undefined,
    undefined,
    source,
  )
  try {
    await h.start()
    await h.start({ directory: join(h.code, "beta"), focus: false })
    const [first, second] = ((await h.control("orient")) as Snapshot).agents
    const firstCorrelation = memberCorrelation(1)
    const secondCorrelation = memberCorrelation(2)
    source.entries = [
      { agent_id: second!.agent_id, correlation: secondCorrelation },
      { agent_id: first!.agent_id, correlation: firstCorrelation },
    ]

    const snapshot = await h.multiplexer.extension.snapshot()
    expect(source.calls).toBe(1)
    expect(snapshot.agents.map(({ agent_id, correlation }) => [agent_id, correlation])).toEqual([
      [first!.agent_id, firstCorrelation],
      [second!.agent_id, secondCorrelation],
    ])
  } finally {
    await h.close()
  }
})

test("refuses conflicting injected correlation data instead of choosing a record", async () => {
  const source = new FakeRuntimeMemberCorrelationSource()
  const h = await harness(
    "runtime-member-correlation-conflict",
    undefined,
    undefined,
    source,
  )
  try {
    await h.start()
    const [agent] = ((await h.control("orient")) as Snapshot).agents
    source.entries = [
      { agent_id: agent!.agent_id, correlation: memberCorrelation(1) },
      { agent_id: agent!.agent_id, correlation: memberCorrelation(2) },
    ]

    await expect(h.multiplexer.extension.snapshot()).rejects.toMatchObject({
      name: "RuntimeExtensionSurfaceError",
      code: "snapshot_unavailable",
    })
    expect(source.calls).toBe(1)
  } finally {
    await h.close()
  }
})

test("refuses invalid injected correlation data even when its Agent exists", async () => {
  const source = new FakeRuntimeMemberCorrelationSource()
  const h = await harness(
    "runtime-member-correlation-invalid",
    undefined,
    undefined,
    source,
  )
  try {
    await h.start()
    const [agent] = ((await h.control("orient")) as Snapshot).agents
    source.entries = [{
      agent_id: agent!.agent_id,
      correlation: {
        ...memberCorrelation(1),
        ensure_digest: "not-a-digest",
      },
    }]

    await expect(h.multiplexer.extension.snapshot()).rejects.toMatchObject({
      name: "RuntimeExtensionSurfaceError",
      code: "snapshot_unavailable",
    })
    expect(source.calls).toBe(1)
  } finally {
    await h.close()
  }
})

test("fails the whole member snapshot when its correlation source fails", async () => {
  const source = new FakeRuntimeMemberCorrelationSource()
  source.failure = new Error("ledger read failed")
  const h = await harness(
    "runtime-member-correlation-failure",
    undefined,
    undefined,
    source,
  )
  try {
    await h.start()
    await expect(h.multiplexer.extension.snapshot()).rejects.toMatchObject({
      name: "RuntimeExtensionSurfaceError",
      code: "snapshot_unavailable",
      message: "Runtime member correlation is unavailable",
    })
    expect(source.calls).toBe(1)
  } finally {
    await h.close()
  }
})

test("adopts native session names over ADE and recovers sequence gaps", async () => {
  const h = await harness("ade-names")
  const firstSession = "1787362101388-1787362101388156000-2897385323da2683"
  const secondSession = "1787362101389-1787362101389156000-2897385323da2684"
  const replacementSession = "1787362101390-1787362101390156000-2897385323da2685"
  const writeName = async (sessionId: string, title: string) => {
    const directory = join(h.home, ".fx", "sessions", sessionId)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, "display.json"),
      `${JSON.stringify({ schema_version: 1, title, preview: null, origin_workspace_root: null })}\n`,
    )
  }

  try {
    await h.start()
    await h.start({ focus: false })
    const ade = h.adeSocket
    const [first, second] = h.options.manifest.entries
    expect(first).toBeDefined()
    expect(second).toBeDefined()

    await sendAde(ade, adeRecord(1, first!.agentId, "FxStarted", firstSession))
    await sendAde(
      ade,
      adeRecord(2, first!.agentId, "SessionMetadataChanged", firstSession, {
        title: "Coordinate the review",
      }),
    )
    let snapshot = await waitForSnapshot(
      () => h.control("orient") as Promise<Snapshot>,
      (current) => current.agents[0]?.name === "Coordinate the review",
    )
    expect(snapshot.agents[0]).toMatchObject({ session_id: firstSession, name: "Coordinate the review" })
    expect(snapshot.tray.rows.find((row) => row.agent === 1)?.text).toContain("Coordinate the review")

    // An unknown additive event still carries authoritative envelope context.
    // This is the first record a restarted fmx could see after fx changed
    // sessions while detached.
    await writeName(replacementSession, "Recovered from additive context")
    await sendAde(ade, adeRecord(3, first!.agentId, "FutureObservation", replacementSession))
    snapshot = await waitForSnapshot(
      () => h.control("orient") as Promise<Snapshot>,
      (current) => current.agents[0]?.name === "Recovered from additive context",
    )
    expect(snapshot.agents[0]?.session_id).toBe(replacementSession)

    // A later gap re-reads fx's durable sidecar before ignoring the event.
    await writeName(replacementSession, "Recovered after gap")
    await sendAde(ade, adeRecord(5, first!.agentId, "FutureObservation", replacementSession))
    snapshot = await waitForSnapshot(
      () => h.control("orient") as Promise<Snapshot>,
      (current) => current.agents[0]?.name === "Recovered after gap",
    )

    await sendAde(ade, adeRecord(1, second!.agentId, "FxStarted", secondSession))
    await sendAde(
      ade,
      adeRecord(2, second!.agentId, "SessionMetadataChanged", secondSession, {
        title: "Recovered after gap",
      }),
    )
    await waitForSnapshot(
      () => h.control("orient") as Promise<Snapshot>,
      (current) => current.agents[1]?.name === "Recovered after gap",
    )
    const ambiguous = await failure(h.control("focus", { target: "Recovered after gap" }))
    expect(ambiguous.code).toBe("ambiguous")
    expect(ambiguous.data).toEqual({ agents: [1, 2] })

    // Exact duplicate names remain ambiguous even when that same text is a
    // unique prefix of another Agent's session id.
    const collidingName = firstSession.slice(0, firstSession.indexOf("-") + 4)
    await sendAde(
      ade,
      adeRecord(6, first!.agentId, "SessionMetadataChanged", replacementSession, {
        title: collidingName,
      }),
    )
    await sendAde(
      ade,
      adeRecord(3, second!.agentId, "SessionMetadataChanged", secondSession, {
        title: collidingName,
      }),
    )
    await waitForSnapshot(
      () => h.control("orient") as Promise<Snapshot>,
      (current) => current.agents.every((agent) => agent.name === collidingName),
    )
    const nameBeforePrefix = await failure(h.control("focus", { target: collidingName }))
    expect(nameBeforePrefix.code).toBe("ambiguous")
    expect(nameBeforePrefix.data).toEqual({ agents: [1, 2] })

    await writeName(firstSession, "Replacement session")
    await sendAde(
      ade,
      adeRecord(7, first!.agentId, "SessionChanged", firstSession, {
        previous_session_id: replacementSession,
        session_id: firstSession,
      }),
    )
    snapshot = await waitForSnapshot(
      () => h.control("orient") as Promise<Snapshot>,
      (current) => current.agents[0]?.session_id === firstSession,
    )
    expect(snapshot.agents[0]?.name).toBe("Replacement session")
  } finally {
    await h.close()
  }
})

test("keeps an ADE session name across a Runtime-extension snapshot during its display-file write window", async () => {
  const h = await harness("ade-name-extension-snapshot")
  const sessionId = "1787362101391-1787362101391156000-2897385323da2686"
  try {
    await h.start()
    const [agent] = h.options.manifest.entries
    expect(agent).toBeDefined()

    await sendAde(
      h.adeSocket,
      adeRecord(1, agent!.agentId, "FxStarted", sessionId),
    )
    await sendAde(
      h.adeSocket,
      adeRecord(2, agent!.agentId, "SessionMetadataChanged", sessionId, {
        title: "phase2-manager",
      }),
    )
    await waitForSnapshot(
      () => h.control("orient") as Promise<Snapshot>,
      (current) => current.agents[0]?.name === "phase2-manager",
    )

    expect(await h.multiplexer.extension.snapshot()).toMatchObject({
      agents: [{
        fx_conversation: {
          conversation_id: sessionId,
          name: "phase2-manager",
        },
      }],
    })
  } finally {
    await h.close()
  }
})

test("does not let delayed child attribution rewind the active main session", async () => {
  const h = await harness("child-attribution")
  const oldSession = "1787362101400-1787362101400156000-2897385323da2686"
  const newSession = "1787362101401-1787362101401156000-2897385323da2687"
  const childSession = "1787362101402-1787362101402156000-2897385323da2688"
  try {
    await h.start()
    const paneId = ((await h.control("orient")) as Snapshot).agents[0]!.pane_id
    h.adeSocket.main(paneId, "FxStarted", { sessionId: oldSession, state: "idle" })
    h.adeSocket.main(paneId, "SessionChanged", { sessionId: newSession, state: "idle" })

    // Child attribution is captured when work is queued and can legitimately
    // name the prior main session after the TUI has moved to a new one.
    h.adeSocket.child(paneId, "TurnStarted", {
      sessionId: childSession,
      parentSessionId: oldSession,
      state: "working",
    })

    expect(((await h.control("orient")) as Snapshot).agents[0]?.session_id).toBe(newSession)
    expect(h.options.manifest.entries[0]?.fxSessionId).toBe(newSession)
  } finally {
    await h.close()
  }
})

test("accepts a new process-local sequence after an orderly Fx relaunch", async () => {
  const h = await harness("sequence-generation")
  const sessionId = "1787362101410-1787362101410156000-2897385323da2689"
  try {
    await h.start()
    const paneId = ((await h.control("orient")) as Snapshot).agents[0]!.pane_id
    const instanceId = paneId.slice(2)
    h.adeSocket.emit(feedRecord("FxStarted", { sequence: 1, instanceId, sessionId, state: "idle" }))
    h.adeSocket.emit(feedRecord("FxStopped", { sequence: 40, instanceId, sessionId, state: "idle" }))
    expect(((await h.control("orient")) as Snapshot).agents[0]?.state).toBe("unknown")

    h.adeSocket.emit(feedRecord("FxStarted", { sequence: 1, instanceId, sessionId, state: "idle" }))
    expect(((await h.control("orient")) as Snapshot).agents[0]?.state).toBe("idle")
    h.adeSocket.emit(feedRecord("PromptQueued", { sequence: 2, instanceId, sessionId, state: "working" }))
    expect(((await h.control("orient")) as Snapshot).agents[0]?.state).toBe("working")
  } finally {
    await h.close()
  }
})

test("configures the Tray", async () => {
  const h = await harness("tray")
  try {
    expect(await h.control("tray", { hidden: true })).toEqual({ visible: false, hidden: true, width: 26 })
    await h.start()
    expect(await h.control("tray", { width: 30 })).toEqual({ visible: false, hidden: true, width: 30 })
    expect(await h.control("tray", { toggle: true })).toEqual({ visible: true, hidden: false, width: 30 })
    expect(await h.control("tray", { width: 400 })).toEqual({ visible: true, hidden: false, width: 50 })
    expect(await h.control("tray", { hidden: false })).toEqual({ visible: true, hidden: false, width: 50 })
    expect(((await h.control("orient")) as Snapshot).tray).toMatchObject({ visible: true, hidden: false })
  } finally {
    await h.close()
  }
})

async function waitForSnapshot(
  read: () => Promise<Snapshot>,
  condition: (snapshot: Snapshot) => boolean,
  timeoutMs = 2_000,
): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const snapshot = await read()
    if (condition(snapshot)) return snapshot
    if (Date.now() >= deadline) throw new Error("snapshot condition timed out")
    await Bun.sleep(10)
  }
}

test("orientation reflects acknowledgement when the human focuses a finished Agent", async () => {
  const h = await harness("focus-ack")
  try {
    await h.start()
    await h.start()
    await h.control("focus", { target: "2" })
    await h.report("p_1", "working")
    await h.report("p_1", "idle")

    // Agent 1 finished off screen, so it reads `done` rather than `idle`.
    expect(((await h.control("orient")) as Snapshot).agents[0]?.state).toBe("done")

    // Looking at it acknowledges the finish without another ADE record.
    await h.control("focus", { target: "1" })
    expect(((await h.control("orient")) as Snapshot).agents[0]?.state).toBe("idle")
  } finally {
    await h.close()
  }
})

test("re-baselines an Agent's feed after a run of records beneath a bad sequence", async () => {
  const h = await harness("stale-sequence")
  try {
    await h.start()
    await h.report("p_1", "working")
    const instanceId = instanceIdForPane(((await h.control("orient")) as Snapshot).agents[0]!.pane_id)
    const state = async () => ((await h.control("orient")) as Snapshot).agents[0]?.state

    // One record with an absurd sequence must not silence the real feed.
    h.adeSocket.emit(feedRecord("TurnStarted", { instanceId, sequence: Number.MAX_SAFE_INTEGER, state: "blocked" }))
    await h.report("p_1", "idle")
    expect(await state()).toBe("blocked")

    // Fx never rewinds, so a run beneath the mark means the mark is wrong.
    await h.report("p_1", "idle")
    await h.report("p_1", "idle")
    expect(await state()).toBe("idle")
  } finally {
    await h.close()
  }
})
