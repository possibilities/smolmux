import { afterEach, expect, spyOn, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveInstance } from "../src/instance.ts"
import { waitForRuntimeExit } from "../src/lifecycle.ts"
import type { InstanceStatus } from "../src/protocol.ts"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

test("a headless lifecycle barrier follows the exact owned Runtime from live to exited", async () => {
  const fixture = await fakeCompanion()
  const instance = resolveInstance("default", fixture.env)
  fixture.env.FAKE_INSTANCE = instance.id
  fixture.env.FAKE_PID = "4242"
  const status = { name: instance.name, instance_id: instance.id, pid: 4242, host: "headless" } as InstanceStatus

  await waitForRuntimeExit(status, { env: fixture.env, timeoutMs: 1_000 })
  expect(Number(await Bun.file(fixture.count).text())).toBeGreaterThanOrEqual(2)
})

test("a headless lifecycle barrier refuses a live PID replacement", async () => {
  const fixture = await fakeCompanion()
  const instance = resolveInstance("default", fixture.env)
  fixture.env.FAKE_INSTANCE = instance.id
  fixture.env.FAKE_PID = "9999"
  fixture.env.FAKE_ALWAYS_LIVE = "1"
  const status = { name: instance.name, instance_id: instance.id, pid: 4242, host: "headless" } as InstanceStatus

  await expect(waitForRuntimeExit(status, { env: fixture.env, timeoutMs: 1_000 }))
    .rejects.toThrow("now belongs to pid 9999")
})

test("a lifecycle barrier refuses status from another resolved Instance", async () => {
  const fixture = await fakeCompanion()
  const status = { name: "default", instance_id: "not-this-one", pid: 4242, host: "headless" } as InstanceStatus
  await expect(waitForRuntimeExit(status, { env: fixture.env })).rejects.toThrow("Runtime identity mismatch")
})

test("a foreground lifecycle probe rethrows errors that do not prove exit", async () => {
  const fixture = await fakeCompanion()
  const instance = resolveInstance("default", fixture.env)
  const status = { name: instance.name, instance_id: instance.id, pid: 4242, host: "foreground" } as InstanceStatus
  const failure = Object.assign(new Error("probe failed"), { code: "EIO" })
  const kill = spyOn(process, "kill").mockImplementation(() => { throw failure })
  try {
    await expect(waitForRuntimeExit(status, { env: fixture.env })).rejects.toBe(failure)
  } finally { kill.mockRestore() }
})

async function fakeCompanion(): Promise<{ env: NodeJS.ProcessEnv; count: string }> {
  const root = await mkdtemp(join(tmpdir(), "smolmux-lifecycle-"))
  roots.push(root)
  const binary = join(root, "smolmux-zmx")
  const count = join(root, "count")
  await writeFile(binary, `#!/bin/sh
set -eu
[ "$1" = inspect ]
n=0
[ ! -f "$FAKE_COUNT" ] || n=$(cat "$FAKE_COUNT")
n=$((n + 1))
printf '%s' "$n" > "$FAKE_COUNT"
state=exited
[ "$n" -gt 1 ] || state=live
[ "\${FAKE_ALWAYS_LIVE:-}" != 1 ] || state=live
printf '{"name":"smolmuxr-%s","state":"%s","pid":%s,"labels":{"owner":"smolmux","instance":"%s","kind":"runtime"}}\n' "$FAKE_INSTANCE" "$state" "$FAKE_PID" "$FAKE_INSTANCE"
`)
  await chmod(binary, 0o755)
  return {
    count,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(root, "config"),
      SMOLMUX_ZMX_DIR: join(root, "zmx"),
      SMOLMUX_ZMX_PATH: binary,
      FAKE_COUNT: count,
    },
  }
}
