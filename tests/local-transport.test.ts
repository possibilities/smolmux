import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { LocalPtyOwner } from "../src/local-transport.ts"
import { sessionIdentity } from "../src/session-identity.ts"
import type { SessionExit, SessionTransport } from "../src/session-transport.ts"

let directory: string
let helper: string
beforeAll(async () => {
  const root = `/tmp/smolmux-${process.getuid!()}`
  await mkdir(root, { recursive: true, mode: 0o700 })
  directory = await mkdtemp(join(root, "local-test-"))
  helper = join(directory, "smolmux-local-pty")
  const build = Bun.spawn(["cc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", new URL("../native/local-pty.c", import.meta.url).pathname, "-o", helper, ...(process.platform === "linux" ? ["-lutil"] : [])], { stdout: "pipe", stderr: "pipe" })
  const error = await new Response(build.stderr).text()
  expect(await build.exited, error).toBe(0)
})
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

async function until(check: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await Bun.sleep(10)
  expect(check()).toBe(true)
}
function listen(transport: SessionTransport) {
  const observed = { output: "", exit: null as SessionExit | null, lost: null as Error | null }
  transport.bind({
    output: (bytes) => { observed.output += new TextDecoder().decode(bytes) },
    exit: (status) => { observed.exit = status }, lost: (error) => { observed.lost = error }, restoreBegin: () => {}, ready: () => {},
  })
  return observed
}
function request(name: string, script: string) {
  return { identity: sessionIdentity("local-tests", name), command: ["/bin/sh", "-c", script], cwd: directory, env: { PATH: process.env.PATH ?? "/bin:/usr/bin" }, size: { cols: 80, rows: 24 } }
}

test("local ownership starts, captures bytes, accepts input and confirms termination", async () => {
  const errors: string[] = []
  const owner = new LocalPtyOwner({ helper, report: (line) => errors.push(line) })
  const start = request("echo", "printf ready; read answer; printf 'got:%s' \"$answer\"; sleep 30")
  try {
    const transport = await owner.start(start)
    const observed = listen(transport)
    expect(transport.pid).toBeGreaterThan(0)
    await until(() => observed.output.includes("ready"))
    transport.write(new TextEncoder().encode("hello\n"))
    await until(() => observed.output.includes("got:hello"))
    await owner.terminate(start.identity)
    expect(observed.exit).not.toBeNull()
    expect(observed.lost).toBeNull()
    expect(errors).toEqual([])
  } finally { await owner.close() }
})

test("pause acknowledges stopped execution and resume preserves the same process", async () => {
  const errors: string[] = []
  const owner = new LocalPtyOwner({ helper, report: (line) => errors.push(line) })
  const start = request("ticker", "while :; do printf tick; sleep 0.03; done")
  try {
    const transport = await owner.start(start), observed = listen(transport)
    await until(() => observed.output.includes("tick"))
    try { await owner.pause(start.identity, true) } catch (error) { throw new Error(`${error}; exit=${JSON.stringify(observed.exit)}; log=${errors.join("\n")}`) }
    await Bun.sleep(60)
    const before = observed.output
    await Bun.sleep(120)
    expect(observed.output).toBe(before)
    await owner.pause(start.identity, false)
    await until(() => observed.output.length > before.length)
    await owner.pause(start.identity, true)
    await owner.terminate(start.identity)
    expect(observed.exit).not.toBeNull()
  } finally { await owner.close() }
})

test("natural exit delivers final output before exit and cleans up shell descendants", async () => {
  const owner = new LocalPtyOwner({ helper, report: () => {} })
  const start = request("short", "sleep 30 & printf goodbye; exit 7")
  try {
    const observed = listen(await owner.start(start))
    await until(() => observed.exit !== null)
    expect(observed.output).toContain("goodbye")
    expect(observed.exit?.code).toBe(7)
  } finally { await owner.close() }
})

test("exec failures are startup errors, while a program may deliberately exit 127", async () => {
  const owner = new LocalPtyOwner({ helper, report: () => {} })
  try {
    await expect(owner.start({ ...request("missing", ""), command: ["/smolmux/no-such-command"] })).rejects.toThrow("exec failed")
    const observed = listen(await owner.start(request("status", "exit 127")))
    await until(() => observed.exit !== null)
    expect(observed.exit).toEqual({ code: 127, signal: 0, reason: "natural" })
  } finally { await owner.close() }
})

test("Runtime SIGKILL kills paused local shell job-control groups through liveness EOF", async () => {
  const script = join(directory, "owner.ts")
  const modulePath = new URL("../src/local-transport.ts", import.meta.url).pathname
  const identityPath = new URL("../src/session-identity.ts", import.meta.url).pathname
  await Bun.write(script, `
import { LocalPtyOwner } from ${JSON.stringify(modulePath)};
import { sessionIdentity } from ${JSON.stringify(identityPath)};
const owner = new LocalPtyOwner({ helper: ${JSON.stringify(helper)}, report: () => {} });
const identity = sessionIdentity("death-test", "jobs");
const transport = await owner.start({ identity, command: ["/bin/bash", "-c", "set -m; sleep 30 & echo child:$!; wait"], cwd: "/", env: { PATH: "/bin:/usr/bin" }, size: { cols: 80, rows: 24 } });
let output = "";
transport.bind({ output: bytes => output += new TextDecoder().decode(bytes), ready: () => {}, restoreBegin: () => {}, exit: () => {}, lost: () => {} });
const deadline = Date.now() + 3000;
while (!output.includes("child:") && Date.now() < deadline) await Bun.sleep(10);
await owner.pause(identity, true);
console.log(JSON.stringify({ leader: transport.pid, child: Number(/child:(\\d+)/.exec(output)?.[1]) }));
await new Promise(() => {});
`)
  const runtime = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" })
  let pids: number[] = []
  try {
    const reader = runtime.stdout.getReader()
    const first = await Promise.race([reader.read(), Bun.sleep(5000).then(() => { throw new Error("owner did not start") })])
    const result = JSON.parse(new TextDecoder().decode(first.value)) as { leader: number; child: number }
    pids = [result.leader, result.child]
    expect(pids.every(pid => Number.isInteger(pid) && pid > 1)).toBe(true)
    runtime.kill("SIGKILL")
    await runtime.exited
    await until(() => pids.every(pid => { try { process.kill(pid, 0); return false } catch { return true } }), 6000)
  } finally {
    runtime.kill("SIGKILL"); await runtime.exited
    for (const pid of pids) { try { process.kill(pid, "SIGKILL") } catch { /* Already reaped. */ } }
  }
}, 15000)
