import { expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  identityFor,
  AgentManifest,
  isAgentId,
  loadManifest,
  manifestPath,
  mintIdentity,
  parseManifest,
} from "../src/agent-manifest.ts"

const HOME = "abc123def456"
const withDirectory = async (run: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp("/tmp/fmx-manifest-test-")
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
const params = (cwd = "/work") => ({ cwd, fxPath: "/usr/local/bin/fx", fxArgs: [], createdAt: 1_787_420_000_000 })

test("an identity carries one token under three names", () => {
  const identity = mintIdentity()
  expect(isAgentId(identity.agentId)).toBe(true)
  expect(identity.paneId).toBe(`p_${identity.agentId}`)
  expect(identity.zmxName).toBe(`fmx-${identity.agentId}`)
  expect(mintIdentity().agentId).not.toBe(identity.agentId)
  expect(identityFor("0".repeat(32)).zmxName).toBe(`fmx-${"0".repeat(32)}`)
})

test("manifest path honors the override and otherwise sits beside state.json", () => {
  expect(manifestPath({ FMX_MANIFEST_PATH: "/x/m.json" }, "/home/u")).toBe("/x/m.json")
  expect(manifestPath({}, "/home/u")).toBe("/home/u/.config/fmx/agents.json")
  expect(manifestPath({ XDG_CONFIG_HOME: "/cfg" }, "/home/u")).toBe("/cfg/fmx/agents.json")
  expect(manifestPath({ XDG_CONFIG_HOME: "/cfg" }, "/home/u", "foo")).toBe(
    "/cfg/fmx/homes/foo/agents.json",
  )
})

test("parsing keeps valid entries and drops each bad one on its own", () => {
  const good = identityFor("a".repeat(32))
  const other = identityFor("b".repeat(32))
  const document = {
    version: 1,
    homeId: HOME,
    nextDisplayId: 2,
    agents: [
      { ...good, displayId: 4, cwd: "/w", fxPath: "/fx", fxArgs: ["--x"], createdAt: 1, fxSessionId: "s1", phase: "running" },
      { ...other, paneId: "p_wrong", displayId: 5, cwd: "/w", fxPath: "/fx", fxArgs: [], createdAt: 1, phase: "running" },
      { ...identityFor("c".repeat(32)), displayId: 4, cwd: "/w", fxPath: "/fx", fxArgs: [], createdAt: 1, phase: "creating" },
      { ...identityFor("d".repeat(32)), displayId: 7, cwd: "relative", fxPath: "/fx", fxArgs: [], createdAt: 1, phase: "creating" },
      { ...identityFor("e".repeat(32)), displayId: 8, cwd: "/w", fxPath: "/fx", fxArgs: [1], createdAt: 1, phase: "creating" },
      { ...identityFor("f".repeat(32)), displayId: 9, cwd: "/w", fxPath: "/fx", fxArgs: [], createdAt: 1, phase: "dancing" },
      { ...identityFor("1".repeat(32)), displayId: 10, cwd: "/w", fxPath: "/fx", fxArgs: [], fxStateRoot: "relative", createdAt: 1, phase: "running" },
      "garbage",
    ],
  }
  const manifest = parseManifest(JSON.stringify(document), HOME)
  expect(manifest.agents.map((entry) => entry.agentId)).toEqual([good.agentId])
  expect(manifest.agents[0]!.fxSessionId).toBe("s1")
  // A Manifest written before status checkpoints existed remains valid.
  expect(manifest.agents[0]!.agentStatus).toBeNull()
  // A Manifest written before managed state roots existed keeps HOME fallback.
  expect(manifest.agents[0]!.fxStateRoot).toBeNull()
  // The counter never hands out a number an entry already holds.
  expect(manifest.nextDisplayId).toBe(5)
})

test("another Home's manifest, an old version, or garbage reads as empty", () => {
  expect(parseManifest("not json", HOME).agents).toEqual([])
  expect(parseManifest(JSON.stringify({ version: 0, homeId: HOME, agents: [] }), HOME).agents).toEqual([])
  const foreign = { version: 1, homeId: "other", nextDisplayId: 9, agents: [] }
  const manifest = parseManifest(JSON.stringify(foreign), HOME)
  expect(manifest.homeId).toBe(HOME)
  expect(manifest.nextDisplayId).toBe(1)
})

test("migrates the retired recovery attention spelling at the persistence boundary", () => {
  const identity = identityFor("a".repeat(32))
  const document = {
    version: 1,
    homeId: HOME,
    nextDisplayId: 2,
    agents: [{
      ...identity,
      displayId: 1,
      cwd: "/w",
      fxPath: "/fx",
      fxArgs: [],
      createdAt: 1,
      phase: "running",
      agentStatus: { state: "blocked", attention: "recovery", seen: false },
    }],
  }

  expect(parseManifest(JSON.stringify(document), HOME).agents[0]?.agentStatus).toEqual({
    state: "blocked",
    attention: "route_recovery",
    seen: false,
  })
})

test("creation is written before it is acknowledged, and acknowledged in place", async () => {
  await withDirectory(async (dir) => {
    const path = join(dir, "agents.json")
    const manifest = await AgentManifest.open(path, HOME)
    const identity = identityFor("9".repeat(32))
    const workControl = {
      socketPath: "/tmp/fmx-home.agent.fx",
      instanceId: identity.agentId,
      token: "ab".repeat(32),
    }
    const entry = await manifest.beginCreate({ ...params(), identity, workControl })
    expect(entry.phase).toBe("creating")
    expect(entry.displayId).toBe(1)
    expect(entry.workControl).toEqual(workControl)

    // The crash window: what is on disk right now says `creating`.
    const onDisk = await loadManifest(path, HOME)
    expect(onDisk.agents).toHaveLength(1)
    expect(onDisk.agents[0]!.phase).toBe("creating")
    expect(onDisk.agents[0]!.workControl).toEqual(workControl)
    expect((await stat(path)).mode & 0o777).toBe(0o600)

    await manifest.markRunning(entry.agentId)
    expect((await loadManifest(path, HOME)).agents[0]!.phase).toBe("running")

    await manifest.setFxSessionId(entry.agentId, "sess-1")
    expect((await loadManifest(path, HOME)).agents[0]!.fxSessionId).toBe("sess-1")

    await manifest.setAgentStatus(entry.agentId, {
      state: "blocked",
      attention: "question",
      seen: false,
    })
    expect((await loadManifest(path, HOME)).agents[0]!.agentStatus).toEqual({
      state: "blocked",
      attention: "question",
      seen: false,
    })

    await manifest.remove(entry.agentId)
    expect((await loadManifest(path, HOME)).agents).toEqual([])
    // Removed numbers are never reused.
    expect((await manifest.beginCreate(params())).displayId).toBe(2)
  })
})

test("an exact predetermined claim replays in place and a conflicting claim is refused", async () => {
  await withDirectory(async (dir) => {
    const path = join(dir, "managed.json")
    const manifest = await AgentManifest.open(path, HOME)
    const identity = identityFor("8".repeat(32))
    const workControl = {
      socketPath: `/tmp/fmx-managed.${identity.agentId}.fx`,
      instanceId: identity.agentId,
      token: "cd".repeat(32),
    }
    const input = { ...params(), identity, workControl, fxStateRoot: "/var/tmp/fmx-managed-state" }
    const first = manifest.ensureClaim(input)
    await first.saved
    const replay = manifest.ensureClaim({ ...input, createdAt: input.createdAt + 1 })
    await replay.saved

    expect(replay.result).toEqual(first.result)
    expect(manifest.entries).toHaveLength(1)
    expect((await loadManifest(path, HOME)).agents).toEqual([first.result])
    expect(() => manifest.ensureClaim({ ...input, cwd: "/other" })).toThrow(
      "conflicting manifest claim",
    )
    expect(() => manifest.ensureClaim({
      ...input,
      fxStateRoot: "/var/tmp/fmx-other-managed-state",
    })).toThrow("conflicting manifest claim")
  })
})

test("an adopted Agent's arguments may be unknown, and that survives a reload", async () => {
  await withDirectory(async (dir) => {
    const path = join(dir, "m.json")
    const manifest = await AgentManifest.open(path, HOME)
    await manifest.adopt({ ...params(), fxArgs: null, identity: mintIdentity() })
    expect((await loadManifest(path, HOME)).agents[0]!.fxArgs).toBeNull()
  })
})

test("a snapshot handed out does not alias the manifest", async () => {
  await withDirectory(async (dir) => {
    const manifest = await AgentManifest.open(join(dir, "m.json"), HOME)
    const entry = await manifest.beginCreate({ ...params(), fxArgs: ["a"] })
    await manifest.setAgentStatus(entry.agentId, { state: "idle", attention: null, seen: true })
    const snapshot = manifest.get(entry.agentId)!
    entry.fxArgs!.push("b")
    entry.phase = "running"
    snapshot.agentStatus!.state = "working"
    expect(manifest.get(entry.agentId)).toMatchObject({
      fxArgs: ["a"],
      phase: "creating",
      agentStatus: { state: "idle", attention: null, seen: true },
    })
  })
})

test("adopting an unrecorded session gives it a fresh number and no second entry", async () => {
  await withDirectory(async (dir) => {
    const manifest = await AgentManifest.open(join(dir, "m.json"), HOME)
    await manifest.beginCreate(params())
    const identity = mintIdentity()
    const adopted = await manifest.adopt({ ...params("/elsewhere"), identity, fxSessionId: "s9" })
    expect(adopted).toMatchObject({ displayId: 2, phase: "running", fxSessionId: "s9", cwd: "/elsewhere" })
    const again = await manifest.adopt({ ...params(), identity })
    expect(again.displayId).toBe(2)
    expect(manifest.entries).toHaveLength(2)
  })
})

test("writes are atomic and serialized: concurrent mutations all land, no temp file survives", async () => {
  await withDirectory(async (dir) => {
    const path = join(dir, "m.json")
    const manifest = await AgentManifest.open(path, HOME)
    const created = await Promise.all(Array.from({ length: 6 }, () => manifest.beginCreate(params())))
    expect(new Set(created.map((entry) => entry.displayId)).size).toBe(6)
    await Promise.all(created.map((entry) => manifest.markRunning(entry.agentId)))
    const reread = await loadManifest(path, HOME)
    expect(reread.agents).toHaveLength(6)
    expect(reread.agents.every((entry) => entry.phase === "running")).toBe(true)
    expect(readdirSync(dir)).toEqual(["m.json"])
    // Pretty-printed JSON with a trailing newline, like state.json.
    expect((await readFile(path, "utf8")).endsWith("}\n")).toBe(true)
  })
})

test("a write that fails does not wedge the next one", async () => {
  await withDirectory(async (dir) => {
    const manifest = await AgentManifest.open(join(dir, "m.json"), HOME)
    await expect(manifest.markRunning("0".repeat(32))).rejects.toThrow("not in manifest")
    const entry = await manifest.beginCreate(params())
    expect(entry.displayId).toBe(1)
  })
})

test("opening a manifest another Home wrote starts fresh without touching the file until a write", async () => {
  await withDirectory(async (dir) => {
    const path = join(dir, "m.json")
    await writeFile(path, JSON.stringify({ version: 1, homeId: "other", nextDisplayId: 3, agents: [] }))
    const manifest = await AgentManifest.open(path, HOME)
    expect(manifest.entries).toEqual([])
    expect(JSON.parse(await readFile(path, "utf8")).homeId).toBe("other")
  })
})
