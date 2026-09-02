import { expect, test } from "bun:test"
import { lstat, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { join } from "node:path"
import { identityFor, AgentManifest, type ManifestEntry } from "../src/agent-manifest.ts"
import { ownedAgentId, ownershipLabels, reconcile, reconcileAgents } from "../src/agent-reconcile.ts"
import { mintFxWorkControlBinding } from "../src/fx-work-control.ts"
import type { CompanionCommand, SessionEntry } from "../src/zmx-command.ts"

const HOME = "1234567890ab"
const ID_A = "a".repeat(32)
const ID_B = "b".repeat(32)
const ID_C = "c".repeat(32)

const entry = (agentId: string, phase: ManifestEntry["phase"] = "running"): ManifestEntry => ({
  ...identityFor(agentId),
  displayId: 1,
  cwd: "/work",
  fxPath: "/fx",
  fxArgs: [],
  fxStateRoot: null,
  createdAt: 0,
  fxSessionId: null,
  agentStatus: null,
  workControl: null,
  phase,
})

const { join: joinPath } = await import("node:path")
const session = (
  agentId: string,
  state: SessionEntry["state"] = "live",
  overrides: Partial<SessionEntry> = {},
): SessionEntry => ({
  name: identityFor(agentId).zmxName,
  state,
  socketPath: null,
  pid: 42,
  clients: 0,
  createdAt: 1_787_420_000,
  command: ["/fx", "--x"],
  cwd: "/work",
  labels: state === "live" || state === "exited" ? ownershipLabels(HOME, agentId) : {},
  exit: state === "exited" ? { code: 0, signal: 0, reason: "natural", endedAt: 1 } : null,
  detail: null,
  ...overrides,
})

test("ownership needs every label and the name to agree", () => {
  expect(ownedAgentId(session(ID_A), HOME)).toBe(ID_A)
  expect(ownedAgentId(session(ID_A, "live", { labels: { ...ownershipLabels("other", ID_A) } }), HOME)).toBeNull()
  expect(ownedAgentId(session(ID_A, "live", { labels: { ...ownershipLabels(HOME, ID_A), owner: "me" } }), HOME)).toBeNull()
  expect(ownedAgentId(session(ID_A, "live", { name: "fmx-renamed" }), HOME)).toBeNull()
  expect(ownedAgentId(session(ID_A, "live", { labels: { ...ownershipLabels(HOME, ID_A), pane: "p_1" } }), HOME)).toBeNull()
  expect(ownedAgentId(session(ID_A, "live", { labels: {} }), HOME)).toBeNull()
})

test("every crash-window combination lands in one bucket", () => {
  const foreignLive = session(ID_C, "live", { labels: ownershipLabels("other", ID_C) })
  const unowned = session(ID_C, "live", { name: "unowned", labels: {} })
  const plan = reconcile(
    [entry(ID_A), entry(ID_B, "creating"), entry(ID_C)],
    [session(ID_A), session(ID_B, "exited"), foreignLive, unowned],
    HOME,
  )
  expect(plan.attach.map((item) => item.entry.agentId)).toEqual([ID_A])
  expect(plan.remove.map((item) => [item.entry.agentId, item.session?.state ?? null])).toEqual([
    [ID_B, "exited"],
    [ID_C, null],
  ])
  expect(plan.adopt).toEqual([])
  expect(plan.unresolved).toEqual([])
  expect(plan.ignored.map((item) => item.name)).toEqual([foreignLive.name, "unowned"])
})

test("a live owned session nobody wrote down is adopted; an entry with no session is removed", () => {
  const plan = reconcile([entry(ID_A, "creating")], [session(ID_B)], HOME)
  expect(plan.remove.map((item) => item.entry.agentId)).toEqual([ID_A])
  expect(plan.adopt.map((item) => item.agentId)).toEqual([ID_B])
})

test("refused and unreachable are unresolved, never removed, whether or not there is an entry", () => {
  const plan = reconcile(
    [entry(ID_A)],
    [session(ID_A, "refused", { labels: {} }), session(ID_B, "unreachable", { labels: {} }), session(ID_C, "refused", { name: "stranger", labels: {} })],
    HOME,
  )
  expect(plan.remove).toEqual([])
  expect(plan.unresolved.map((item) => [item.entry?.agentId ?? null, item.session.name])).toEqual([
    [ID_A, identityFor(ID_A).zmxName],
    [null, identityFor(ID_B).zmxName],
  ])
  expect(plan.ignored.map((item) => item.name)).toEqual(["stranger"])
})

test("an entry whose name is now a stranger's live session is dropped and the session left alone", () => {
  const plan = reconcile([entry(ID_A)], [session(ID_A, "live", { labels: {} })], HOME)
  expect(plan.attach).toEqual([])
  expect(plan.remove.map((item) => item.entry.agentId)).toEqual([ID_A])
  expect(plan.ignored).toHaveLength(1)
})

test("an exited session with a malformed record still counts as ended", () => {
  const plan = reconcile([entry(ID_A)], [session(ID_A, "exited", { exit: null, detail: "MalformedExitRecord", labels: {} })], HOME)
  expect(plan.remove[0]?.session?.detail).toBe("MalformedExitRecord")
})

const FAIL = [] as SessionEntry[]

/** A Companion that answers from a script of `list` results and records what was forgotten. */
function fakeCompanion(lists: SessionEntry[][]) {
  const forgotten: string[] = []
  let calls = 0
  const companion = {
    list: async () => {
      const answer = lists[Math.min(calls++, lists.length - 1)] ?? []
      if (answer === FAIL) throw new Error("list failed")
      return answer
    },
    forget: async (name: string) => {
      forgotten.push(name)
    },
  } as unknown as CompanionCommand
  return { companion, forgotten, calls: () => calls }
}

test("reconcileAgents applies the join: adopts, removes, consumes exit records, and seeds the registry's facts", async () => {
  const dir = await mkdtemp("/tmp/fmx-reconcile-test-")
  try {
    const manifest = await AgentManifest.open(join(dir, "m.json"), HOME)
    // A: acknowledged by the Companion, but fmx died before writing it down.
    await manifest.beginCreate({ cwd: "/work", fxPath: "/fx", fxArgs: [], createdAt: 0, identity: identityFor(ID_A) })
    await manifest.beginCreate({ cwd: "/work", fxPath: "/fx", fxArgs: [], createdAt: 0, identity: identityFor(ID_B) })
    const { companion, forgotten } = fakeCompanion([[session(ID_A), session(ID_B, "exited"), session(ID_C, "live", { cwd: "/adopted" })]])

    const outcome = await reconcileAgents(manifest, companion)
    expect(outcome.attached.map((item) => item.entry.agentId)).toEqual([ID_A])
    expect(outcome.attached[0]?.entry.phase).toBe("running")
    expect(outcome.attached[0]?.session.name).toBe(identityFor(ID_A).zmxName)
    expect(manifest.get(ID_A)?.phase).toBe("running")
    // The Companion's cmd is a truncated display string: the executable is trusted, the arguments are not.
    expect(outcome.adopted.map((item) => [item.entry.agentId, item.entry.cwd, item.entry.fxPath, item.entry.fxArgs, item.entry.displayId])).toEqual([
      [ID_C, "/adopted", "/fx", null, 3],
    ])
    expect(outcome.removed.map((item) => item.entry.agentId)).toEqual([ID_B])
    expect(forgotten).toEqual([identityFor(ID_B).zmxName])
    expect(manifest.entries.map((item) => item.agentId).sort()).toEqual([ID_A, ID_C])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("reconciliation clears a dead Agent's exact work-control socket before forgetting it", async () => {
  const dir = await mkdtemp("/tmp/fmx-reconcile-test-")
  const runtimeSocketPath = join(dir, "home.bus")
  const binding = mintFxWorkControlBinding(runtimeSocketPath, ID_A)
  const server = createServer()
  try {
    const manifest = await AgentManifest.open(join(dir, "m.json"), HOME)
    await manifest.beginCreate({
      cwd: "/work",
      fxPath: "/fx",
      fxArgs: [],
      createdAt: 0,
      identity: identityFor(ID_A),
      workControl: binding,
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(binding.socketPath, resolve)
    })
    const { companion } = fakeCompanion([[session(ID_A, "exited")]])

    const outcome = await reconcileAgents(manifest, companion, { runtimeSocketPath })
    expect(outcome.removed.map((item) => item.entry.agentId)).toEqual([ID_A])
    expect(manifest.entries).toEqual([])
    expect(await unixSocketExists(binding.socketPath)).toBe(false)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test("reconciliation never unlinks an endpoint beside a live foreign session", async () => {
  const dir = await mkdtemp("/tmp/fmx-reconcile-test-")
  const runtimeSocketPath = join(dir, "home.bus")
  const binding = mintFxWorkControlBinding(runtimeSocketPath, ID_A)
  const server = createServer()
  try {
    const manifest = await AgentManifest.open(join(dir, "m.json"), HOME)
    await manifest.beginCreate({
      cwd: "/work",
      fxPath: "/fx",
      fxArgs: [],
      createdAt: 0,
      identity: identityFor(ID_A),
      workControl: binding,
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(binding.socketPath, resolve)
    })
    const foreign = session(ID_A, "live", { labels: ownershipLabels("other", ID_A) })
    const { companion } = fakeCompanion([[foreign]])
    const removals: unknown[] = []

    const outcome = await reconcileAgents(manifest, companion, {
      runtimeSocketPath,
      beforeRemove: (removal) => {
        removals.push(removal)
      },
    })
    expect(outcome.removed.map((item) => item.entry.agentId)).toEqual([ID_A])
    expect(outcome.ignored).toEqual([foreign])
    expect(removals).toEqual([{ entry: manifestEntryForRemoval(ID_A, binding), reason: "foreign", session: foreign }])
    expect(manifest.entries).toEqual([])
    expect(await unixSocketExists(binding.socketPath)).toBe(true)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test("reconciliation fails closed before removing an exited managed identity", async () => {
  const dir = await mkdtemp("/tmp/fmx-reconcile-test-")
  try {
    const manifest = await AgentManifest.open(join(dir, "m.json"), HOME)
    await manifest.beginCreate({
      cwd: "/work",
      fxPath: "/fx",
      fxArgs: [],
      createdAt: 0,
      identity: identityFor(ID_A),
    })
    const exited = session(ID_A, "exited")
    const { companion, forgotten } = fakeCompanion([[exited]])
    let removal: unknown = null

    await expect(reconcileAgents(manifest, companion, {
      beforeRemove: (candidate) => {
        removal = candidate
        throw new Error("final receipt persistence failed")
      },
    })).rejects.toThrow("final receipt persistence failed")

    expect(removal).toEqual({ entry: manifestEntryForRemoval(ID_A, null), reason: "exited", session: exited })
    expect(manifest.get(ID_A)).not.toBeNull()
    expect(forgotten).toEqual([])

    const retry = await reconcileAgents(manifest, companion, {
      beforeRemove: () => {},
    })
    expect(retry.removed.map(({ entry }) => entry.agentId)).toEqual([ID_A])
    expect(manifest.get(ID_A)).toBeNull()
    expect(forgotten).toEqual([identityFor(ID_A).zmxName])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("an exact preserve disposition retains the candidate without touching its residue", async () => {
  const dir = await mkdtemp("/tmp/fmx-reconcile-test-")
  try {
    const manifest = await AgentManifest.open(join(dir, "m.json"), HOME)
    await manifest.beginCreate({
      cwd: "/work",
      fxPath: "/fx",
      fxArgs: [],
      createdAt: 0,
      identity: identityFor(ID_A),
    })
    const { companion, forgotten } = fakeCompanion([[session(ID_A, "exited")]])

    const outcome = await reconcileAgents(manifest, companion, {
      beforeRemove: () => "preserve",
    })

    expect(outcome.removed).toEqual([])
    expect(outcome.preserved).toEqual([{
      entry: manifestEntryForRemoval(ID_A, null),
      reason: "exited",
      session: session(ID_A, "exited"),
    }])
    expect(manifest.get(ID_A)).not.toBeNull()
    expect(forgotten).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("startup isolation returns live survivors when another removal fails after finalization", async () => {
  const dir = await mkdtemp("/tmp/fmx-reconcile-test-")
  try {
    const manifest = await AgentManifest.open(join(dir, "m.json"), HOME)
    await manifest.beginCreate({
      cwd: "/work-a",
      fxPath: "/fx",
      fxArgs: [],
      createdAt: 0,
      identity: identityFor(ID_A),
    })
    await manifest.beginCreate({
      cwd: "/work-b",
      fxPath: "/fx",
      fxArgs: [],
      createdAt: 1,
      identity: identityFor(ID_B),
    })
    const exited = session(ID_B, "exited")
    const replacement = session(ID_B, "live", {
      labels: ownershipLabels("foreign-home", ID_B),
    })
    const { companion, forgotten } = fakeCompanion([
      [session(ID_A), exited],
      [session(ID_A), replacement],
    ])
    const failures: Array<{ removal: unknown; error: string }> = []

    const outcome = await reconcileAgents(manifest, companion, {
      beforeRemove: async () => {},
      continueAfterRemoveFailure: (removal, error) => {
        failures.push({ removal, error: String(error) })
      },
    })

    expect(outcome.attached.map(({ entry }) => entry.agentId)).toEqual([ID_A])
    expect(outcome.preserved.map(({ entry }) => entry.agentId)).toEqual([ID_B])
    expect(outcome.removed).toEqual([])
    expect(manifest.get(ID_A)?.phase).toBe("running")
    expect(manifest.get(ID_B)).not.toBeNull()
    expect(failures).toEqual([{
      removal: {
        entry: {
          ...manifestEntryForRemoval(ID_B, null),
          displayId: 2,
          cwd: "/work-b",
          createdAt: 1,
        },
        reason: "exited",
        session: exited,
      },
      error: `Error: Companion session ${identityFor(ID_B).zmxName} changed while its managed identity was finalized`,
    }])
    expect(forgotten).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("reconciliation revalidates after a managed finalizer and preserves a replacement session", async () => {
  const dir = await mkdtemp("/tmp/fmx-reconcile-test-")
  const runtimeSocketPath = join(dir, "home.bus")
  const binding = mintFxWorkControlBinding(runtimeSocketPath, ID_A)
  const server = createServer()
  try {
    const manifest = await AgentManifest.open(join(dir, "m.json"), HOME)
    await manifest.beginCreate({
      cwd: "/work",
      fxPath: "/fx",
      fxArgs: [],
      createdAt: 0,
      identity: identityFor(ID_A),
      workControl: binding,
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(binding.socketPath, resolve)
    })
    const exited = session(ID_A, "exited")
    const replacement = session(ID_A, "live", {
      labels: ownershipLabels("foreign-home", ID_A),
    })
    const { companion, forgotten } = fakeCompanion([[exited], [replacement]])

    await expect(reconcileAgents(manifest, companion, {
      runtimeSocketPath,
      beforeRemove: async () => {
        await Promise.resolve()
      },
    })).rejects.toThrow("changed while its managed identity was finalized")

    expect(manifest.get(ID_A)).not.toBeNull()
    expect(await unixSocketExists(binding.socketPath)).toBe(true)
    expect(forgotten).toEqual([])
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test("reconcileAgents waits for a refused session to settle, then decides", async () => {
  const dir = await mkdtemp("/tmp/fmx-reconcile-test-")
  try {
    const manifest = await AgentManifest.open(join(dir, "m.json"), HOME)
    await manifest.beginCreate({ cwd: "/work", fxPath: "/fx", fxArgs: [], createdAt: 0, identity: identityFor(ID_A) })
    const refused = session(ID_A, "refused", { labels: {}, detail: "ConnectionRefused" })
    const { companion, forgotten, calls } = fakeCompanion([[refused], [refused], [session(ID_A, "exited")]])
    const outcome = await reconcileAgents(manifest, companion, { settleMs: 2000 })
    // Three settle reads, then one fresh proof before each destructive effect.
    expect(calls()).toBe(6)
    expect(outcome.removed.map((item) => item.entry.agentId)).toEqual([ID_A])
    expect(outcome.unresolved).toEqual([])
    expect(forgotten).toHaveLength(1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("unreachable after the settle window is left for the next start, entry intact", async () => {
  const dir = await mkdtemp("/tmp/fmx-reconcile-test-")
  try {
    const manifest = await AgentManifest.open(join(dir, "m.json"), HOME)
    await manifest.beginCreate({ cwd: "/work", fxPath: "/fx", fxArgs: [], createdAt: 0, identity: identityFor(ID_A) })
    const { companion } = fakeCompanion([[session(ID_A, "unreachable", { labels: {} })]])
    let clock = 0
    const outcome = await reconcileAgents(manifest, companion, { settleMs: 100, now: () => (clock += 60) })
    expect(outcome.unresolved.map((item) => item.name)).toEqual([identityFor(ID_A).zmxName])
    expect(manifest.entries).toHaveLength(1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("refused after the settle window is a dead socket: entry removed, file cleared, nothing held forever", async () => {
  const dir = await mkdtemp("/tmp/fmx-reconcile-test-")
  try {
    const manifest = await AgentManifest.open(join(dir, "m.json"), HOME)
    await manifest.beginCreate({ cwd: "/work", fxPath: "/fx", fxArgs: [], createdAt: 0, identity: identityFor(ID_A) })
    const socketPath = joinPath(dir, identityFor(ID_A).zmxName)
    await Bun.write(socketPath, "")
    const strangerPath = joinPath(dir, identityFor(ID_B).zmxName)
    await Bun.write(strangerPath, "")
    const { companion } = fakeCompanion([
      [session(ID_A, "refused", { labels: {}, socketPath }), session(ID_B, "refused", { labels: {}, socketPath: strangerPath })],
    ])
    let clock = 0
    const outcome = await reconcileAgents(manifest, companion, { settleMs: 100, now: () => (clock += 60) })
    expect(outcome.removed.map((item) => item.entry.agentId)).toEqual([ID_A])
    expect(outcome.cleared.map((item) => item.name).sort()).toEqual([identityFor(ID_A).zmxName, identityFor(ID_B).zmxName])
    expect(outcome.unresolved).toEqual([])
    expect(manifest.entries).toEqual([])
    expect(await Bun.file(socketPath).exists()).toBe(false)
    expect(await Bun.file(strangerPath).exists()).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("an exit record of ours that no entry claims is consumed, not carried forever", async () => {
  const dir = await mkdtemp("/tmp/fmx-reconcile-test-")
  try {
    const manifest = await AgentManifest.open(join(dir, "m.json"), HOME)
    const { companion, forgotten } = fakeCompanion([[session(ID_A, "exited"), session(ID_B, "exited", { labels: ownershipLabels("other", ID_B) })]])
    const plan = reconcile([], await companion.list(), HOME)
    expect(plan.forget.map((item) => item.name)).toEqual([identityFor(ID_A).zmxName])
    expect(plan.ignored.map((item) => item.name)).toEqual([identityFor(ID_B).zmxName])
    await reconcileAgents(manifest, companion)
    expect(forgotten).toEqual([identityFor(ID_A).zmxName])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a Companion that cannot list is an error, never an empty Companion", async () => {
  const dir = await mkdtemp("/tmp/fmx-reconcile-test-")
  try {
    const manifest = await AgentManifest.open(join(dir, "m.json"), HOME)
    await manifest.beginCreate({ cwd: "/work", fxPath: "/fx", fxArgs: [], createdAt: 0, identity: identityFor(ID_A) })
    const { companion } = fakeCompanion([FAIL])
    await expect(reconcileAgents(manifest, companion)).rejects.toThrow("list failed")
    expect(manifest.entries).toHaveLength(1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

async function unixSocketExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSocket()
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

function manifestEntryForRemoval(
  agentId: string,
  workControl: ManifestEntry["workControl"],
): ManifestEntry {
  return {
    ...entry(agentId, "creating"),
    workControl,
  }
}
