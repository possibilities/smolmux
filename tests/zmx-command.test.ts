import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import {
  CompanionCommand,
  CompanionCreateError,
  CompanionError,
  decodeOsc7Cwd,
  formatLabels,
  readEntry,
  splitShellWords,
  type SpawnResult,
} from "../src/zmx-command.ts"

test("decodes the Companion's OSC 7 cwd into a path, and only a local one", () => {
  expect(decodeOsc7Cwd("file://greybird.local/Users/me/src")).toBe("/Users/me/src")
  expect(decodeOsc7Cwd("file:///tmp/a%20b")).toBe("/tmp/a b")
  expect(decodeOsc7Cwd("/already/a/path")).toBe("/already/a/path")
  expect(decodeOsc7Cwd("file://elsewhere/tmp", "here")).toBeNull()
  expect(decodeOsc7Cwd("file://here/tmp", "here")).toBe("/tmp")
  expect(decodeOsc7Cwd("nonsense")).toBeNull()
})

test("splits the Companion's single-quoted command back into argv", () => {
  expect(splitShellWords("'/usr/bin/fx' '--flag' 'it'\\''s here'")).toEqual(["/usr/bin/fx", "--flag", "it's here"])
  expect(splitShellWords("sh -c 'echo hi'")).toEqual(["sh", "-c", "echo hi"])
  expect(splitShellWords("  ''  ")).toEqual([""])
})

test("formats labels as one space-separated argument and refuses what the Companion would", () => {
  expect(formatLabels({ owner: "smolmux", home: "h1" })).toBe("owner=smolmux home=h1")
  expect(() => formatLabels({ "bad key": "x" })).toThrow("invalid label key")
  expect(() => formatLabels({ k: "has space" })).toThrow("invalid label value")
  expect(() => formatLabels({ k: "a=b" })).toThrow("invalid label value")
})

test("reads every discovery state, tolerating what each omits", () => {
  expect(readEntry({ name: "x", state: "absent" })).toMatchObject({ name: "x", state: "absent", labels: {}, exit: null })
  expect(readEntry({ name: "x", state: "refused", socketPath: "/s", detail: "ConnectionRefused" })).toMatchObject({ detail: "ConnectionRefused" })
  const exited = readEntry({ name: "x", state: "exited", pid: 1, createdAt: 2, labels: { a: "b" }, exit: { code: 7, endedAt: 9 } })
  expect(exited?.exit).toEqual({ code: 7, signal: 0, reason: "unknown", endedAt: 9 })
  expect(exited?.labels).toEqual({ a: "b" })
  const unknown = { code: null, signal: null, reason: "requested", endedAt: 10 }
  expect(readEntry({ name: "migrated", state: "exited", exit: unknown })?.exit).toEqual(unknown)
  expect(readEntry({ name: "x", state: "dancing" })).toBeNull()
  expect(readEntry({ state: "live" })).toBeNull()
})

/** A Companion scripted by argv: the first matching prefix answers. */
function scripted(answers: [string[], SpawnResult][]) {
  const calls: { args: string[]; cwd?: string; env: Record<string, string> }[] = []
  const spawner = async (args: string[], options: { cwd?: string; env: Record<string, string> }) => {
    calls.push({ args, ...options })
    const match = answers.find(([prefix]) => prefix.every((word, index) => args[index] === word))
    return match?.[1] ?? { exitCode: 1, stdout: "", stderr: "unscripted" }
  }
  return { spawner, calls }
}

test("create passes identity, labels, the command after `--`, and the Companion's own environment", async () => {
  const { spawner, calls } = scripted([
    [["create"], { exitCode: 0, stdout: '{"ok":true,"name":"smolmux-1","socketPath":"/d/smolmux-1","pid":5,"createdAt":10}\n', stderr: "" }],
    [["list"], { exitCode: 0, stdout: "[]", stderr: "" }],
  ])
  // smolmux's own environment carries an outer surface's names; the fx environment built for the
  // agent must win, with only the Companion's variables replaced.
  const companion = new CompanionCommand("/tmp/smolmux-cmd-test-dir", { PATH: "/outer", HERDR_PANE_ID: "stranger", TERM: "outer" }, spawner)
  const created = await companion.create({
    name: "smolmux-1",
    command: ["/fx", "--x"],
    cwd: "/work",
    env: { PATH: "/bin", TERM: "xterm-256color", HERDR_PANE_ID: "p_1", ZMX_DIR: "/theirs", ZMX_SESSION: "theirs" },
    labels: { owner: "smolmux" },
    timeoutMs: 500,
    exitOnLastClient: true,
  })
  expect(created).toEqual({ name: "smolmux-1", socketPath: "/d/smolmux-1", pid: 5, createdAt: 10 })
  expect(calls[0]).toEqual({
    args: ["create", "--json", "--labels", "owner=smolmux", "--timeout-ms", "500", "--exit-on-last-client", "smolmux-1", "--", "/fx", "--x"],
    cwd: "/work",
    env: { PATH: "/bin", TERM: "xterm-256color", HERDR_PANE_ID: "p_1", ZMX_DIR: "/tmp/smolmux-cmd-test-dir" },
  })
  await companion.list()
  expect(calls[1]?.env).toEqual({ PATH: "/outer", HERDR_PANE_ID: "stranger", TERM: "outer", ZMX_DIR: "/tmp/smolmux-cmd-test-dir" })
  await rm("/tmp/smolmux-cmd-test-dir", { recursive: true, force: true })
})

test("a refused create is a typed error; only Timeout may have left a session", async () => {
  const { spawner } = scripted([
    [["create", "--json", "taken"], { exitCode: 1, stdout: '{"ok":false,"name":"taken","error":"AlreadyExists","message":"taken"}', stderr: "" }],
    [["create", "--json", "slow"], { exitCode: 1, stdout: '{"ok":false,"name":"slow","error":"Timeout","message":"slow","timeoutMs":5}', stderr: "" }],
    [["create", "--json", "odd"], { exitCode: 1, stdout: '{"ok":false,"name":"odd","error":"Martian","message":"?"}', stderr: "" }],
    [["create", "--json", "crash"], { exitCode: 134, stdout: "", stderr: "panic" }],
  ])
  const companion = new CompanionCommand("/tmp/smolmux-cmd-test-dir2", {}, spawner)
  const request = (name: string) => companion.create({ name, command: ["x"], cwd: "/", env: {} })
  const taken = await request("taken").catch((error) => error)
  expect(taken).toBeInstanceOf(CompanionCreateError)
  expect(taken.code).toBe("AlreadyExists")
  expect(taken.sessionMayExist).toBe(false)
  const slow = await request("slow").catch((error) => error)
  expect(slow.code).toBe("Timeout")
  expect(slow.sessionMayExist).toBe(true)
  expect((await request("odd").catch((error) => error)).code).toBe("Internal")
  const crash = await request("crash").catch((error) => error)
  expect(crash).toBeInstanceOf(CompanionError)
  expect(crash.message).toContain("panic")
  await rm("/tmp/smolmux-cmd-test-dir2", { recursive: true, force: true })
})

test("list passes --where through, and a Companion that cannot list is an error, not an empty list", async () => {
  const { spawner, calls } = scripted([
    [["list", "--json", "--where"], { exitCode: 0, stdout: '[{"name":"a","state":"live","labels":{"owner":"smolmux"}}]', stderr: "" }],
    [["list"], { exitCode: 1, stdout: "", stderr: "error: AccessDenied" }],
  ])
  const companion = new CompanionCommand("/d", {}, spawner)
  const failure = await companion.list().catch((error) => error)
  expect(failure).toBeInstanceOf(CompanionError)
  expect(failure.message).toContain("AccessDenied")
  expect((await companion.list({ owner: "smolmux" })).map((entry) => entry.name)).toEqual(["a"])
  expect(calls[1]?.args).toEqual(["list", "--json", "--where", "owner=smolmux"])
})

test("settle polls inspect until the state is no longer refused", async () => {
  let asked = 0
  const spawner = async () => ({
    exitCode: 0,
    stdout: ++asked < 3 ? '{"name":"s","state":"refused","detail":"ConnectionRefused"}' : '{"name":"s","state":"absent"}',
    stderr: "",
  })
  const companion = new CompanionCommand("/d", {}, spawner)
  expect((await companion.settle("s", 1000, 5)).state).toBe("absent")
  expect(asked).toBe(3)
})

/**
 * Against the real Companion, when SMOLMUX_ZMX_PATH names it. Everything runs in
 * a private ZMX_DIR under /tmp and is killed and removed at the end.
 */
const ZMX = process.env.SMOLMUX_ZMX_PATH
const ENABLED = Boolean(ZMX && existsSync(ZMX))
let dir = ""
let live: CompanionCommand
const created: string[] = []

beforeAll(async () => {
  if (!ENABLED) return
  dir = await mkdtemp("/tmp/smolmuxz-cmd-")
  live = new CompanionCommand(dir, { PATH: process.env.PATH, HOME: process.env.HOME, TERM: "xterm" }, ZMX!)
})

afterAll(async () => {
  if (!ENABLED) return
  for (const name of created) await live.kill(name).catch(() => {})
  for (const name of created) await live.settle(name)
  expect((await live.list()).filter((entry) => entry.state === "live")).toEqual([])
  await rm(dir, { recursive: true, force: true })
})

test.skipIf(!ENABLED)("live: create, list with labels, inspect, kill, settle, forget", async () => {
  const name = "smolmux-" + "1".repeat(32)
  const result = await live.create({
    name,
    command: ["sh", "-c", "echo hi; sleep 30"],
    cwd: "/tmp",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ZMX_SESSION: "stranger" },
    labels: { owner: "smolmux", home: "h1", agent: "1".repeat(32), pane: "p_" + "1".repeat(32) },
  })
  created.push(name)
  expect(result.socketPath).toBe(join(dir, name))
  expect(existsSync(result.socketPath)).toBe(true)

  const [entry] = await live.list({ owner: "smolmux", home: "h1" })
  expect(entry).toMatchObject({ name, state: "live", pid: result.pid, cwd: "/private/tmp", labels: { owner: "smolmux", home: "h1" } })
  expect(entry?.command).toEqual(["sh", "-c", "echo hi; sleep 30"])

  const again = await live.create({ name, command: ["sleep", "1"], cwd: "/tmp", env: {} }).catch((error) => error)
  expect(again.code).toBe("AlreadyExists")

  await live.kill(name)
  const settled = await live.settle(name)
  expect(settled.state).toBe("exited")
  expect(settled.exit?.reason).toBe("requested")
  await live.forget(name)
  expect((await live.inspect(name)).state).toBe("absent")
  created.pop()
})

test.skipIf(!ENABLED)("live: a command that cannot start reports ExecFailed and leaves an exit record, not a socket", async () => {
  const name = "smolmux-" + "2".repeat(32)
  const failure = await live.create({ name, command: ["/nonexistent/fx"], cwd: "/tmp", env: {} }).catch((error) => error)
  expect(failure.code).toBe("ExecFailed")
  const settled = await live.settle(name)
  expect(settled.state).toBe("exited")
  expect(settled.exit?.reason).toBe("exec_failure")
  expect(existsSync(join(dir, name))).toBe(false)
  await live.forget(name)
})

test("a Companion command that wedges is bounded rather than hanging the Runtime", async () => {
  const { CompanionCommand, CompanionError, spawnCompanion } = await import("../src/zmx-command.ts")
  const { writeFile, chmod, mkdtemp, rm } = await import("node:fs/promises")
  const { join } = await import("node:path")
  const directory = await mkdtemp("/tmp/smolmux-wedged-")
  try {
    const wedged = join(directory, "smolmux-zmx")
    // exec, so the shell leaves no child holding the inherited pipe open.
    await writeFile(wedged, "#!/bin/sh\nexec sleep 300\n")
    await chmod(wedged, 0o755)
    const companion = new CompanionCommand(directory, { PATH: "/usr/bin:/bin" }, spawnCompanion(wedged, 250))
    const started = Date.now()
    // Without a deadline a wedged `list` leaves a Runtime that has bound its
    // socket, reported ready, and will never answer a request.
    await expect(companion.list()).rejects.toBeInstanceOf(CompanionError)
    expect(Date.now() - started).toBeLessThan(3_000)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)
