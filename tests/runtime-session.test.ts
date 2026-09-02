import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  currentRuntimeCommand,
  ensureRuntimeSession,
  runtimeSessionIdentity,
  waitForRuntimeBootstrap,
} from "../src/runtime-session.ts"
import type { CompanionCommand, CreateRequest, SessionEntry } from "../src/zmx-command.ts"

const HOME = "0123456789ab"

test("Runtime identity is stable per Home and creation requests final-Client ownership", async () => {
  const identity = runtimeSessionIdentity(HOME, "/tmp/fmx-runtime-test")
  expect(identity).toEqual({
    name: `fmxr-${HOME}`,
    labels: { owner: "fmx", home: HOME, kind: "runtime" },
    bootstrapPath: `/tmp/fmx-runtime-test/.fmxr-${HOME}.bootstrap`,
  })

  let created: CreateRequest | null = null
  const companion = {
    directory: "/tmp/fmx-runtime-test",
    settle: async () => session(identity.name, "absent", {}),
    create: async (request: CreateRequest) => {
      created = request
      return { name: request.name, socketPath: `/tmp/${request.name}`, pid: 4, createdAt: 5 }
    },
  } as unknown as CompanionCommand

  expect(
    await ensureRuntimeSession(companion, {
      homeId: HOME,
      cwd: "/work",
      command: ["fmx"],
      env: { PATH: "/bin" },
    }),
  ).toEqual({ socketPath: `/tmp/fmxr-${HOME}`, bootstrapPath: identity.bootstrapPath })
  expect(created).toMatchObject({
    name: identity.name,
    cwd: "/work",
    command: ["fmx"],
    labels: identity.labels,
    exitOnLastClient: true,
    env: {
      PATH: "/bin",
      FMX_RUNTIME_PROCESS: "1",
      FMX_RUNTIME_BOOTSTRAP_PATH: identity.bootstrapPath,
    },
  })
})

test("cold preparation preserves associated startup authority and final-Client ownership", async () => {
  const identity = runtimeSessionIdentity(HOME, "/tmp/fmx-runtime-associated-test")
  const created: CreateRequest[] = []
  const companion = {
    directory: "/tmp/fmx-runtime-associated-test",
    settle: async () => session(identity.name, "absent", {}),
    create: async (request: CreateRequest) => {
      created.push(request)
      return { name: request.name, socketPath: `/tmp/${request.name}`, pid: 4, createdAt: 5 }
    },
  } as unknown as CompanionCommand

  await ensureRuntimeSession(companion, {
    homeId: HOME,
    cwd: "/work",
    command: ["fmx"],
    env: { PATH: "/bin" },
    prepareCreation: async () => ({
      env: { FMX_RUNTIME_STARTUP_SNAPSHOT: "accepted" },
      labels: { extension: "fixture", workplace: "office" },
    }),
  })
  expect(created[0]).toMatchObject({
    exitOnLastClient: true,
    labels: { ...identity.labels, extension: "fixture", workplace: "office" },
    env: {
      PATH: "/bin",
      FMX_RUNTIME_STARTUP_SNAPSHOT: "accepted",
      FMX_RUNTIME_PROCESS: "1",
      FMX_RUNTIME_BOOTSTRAP_PATH: identity.bootstrapPath,
    },
  })
})

test("a live Runtime joins without consulting later cold-start configuration", async () => {
  const identity = runtimeSessionIdentity(HOME, "/tmp/fmx-runtime-stale-config-test")
  let prepared = false
  const companion = {
    directory: "/tmp/fmx-runtime-stale-config-test",
    settle: async () => session(identity.name, "live", {
      ...identity.labels,
      extension: "accepted-extension",
      workplace: "accepted-workplace",
    }),
  } as unknown as CompanionCommand

  expect(await ensureRuntimeSession(companion, {
    homeId: HOME,
    cwd: "/work",
    command: ["fmx"],
    env: {},
    prepareCreation: async () => {
      prepared = true
      throw new Error("stale disk config")
    },
  })).toEqual({
    socketPath: `/tmp/${identity.name}`,
    bootstrapPath: identity.bootstrapPath,
  })
  expect(prepared).toBe(false)
})

test("a live owned Runtime is joined and a label impostor is refused", async () => {
  const identity = runtimeSessionIdentity(HOME, "/tmp/fmx-runtime-test")
  const makeCompanion = (labels: Record<string, string>) =>
    ({
      directory: "/tmp/fmx-runtime-test",
      settle: async () => session(identity.name, "live", labels),
    }) as unknown as CompanionCommand
  const request = { homeId: HOME, cwd: "/work", command: ["fmx"], env: {} }

  expect(await ensureRuntimeSession(makeCompanion(identity.labels), request)).toEqual({
    socketPath: `/tmp/${identity.name}`,
    bootstrapPath: identity.bootstrapPath,
  })
  await expect(ensureRuntimeSession(makeCompanion({ ...identity.labels, home: "stranger" }), request)).rejects.toThrow(
    "does not belong",
  )
})

test("explicit picker preferences refuse incompatible live Runtimes while less specific Clients join", async () => {
  const tray = runtimeSessionIdentity(HOME, "/tmp/fmx-runtime-test")
  const picker = runtimeSessionIdentity(HOME, "/tmp/fmx-runtime-test", { agentPicker: true })
  const hiddenSingle = runtimeSessionIdentity(HOME, "/tmp/fmx-runtime-test", {
    agentPicker: true,
    hideSingleAgentPicker: true,
  })
  expect(picker.labels).toEqual({ ...tray.labels, view: "agent-picker" })
  expect(hiddenSingle.labels).toEqual({ ...picker.labels, picker: "hide-single" })

  const makeCompanion = (labels: Record<string, string>) =>
    ({
      directory: "/tmp/fmx-runtime-test",
      settle: async () => session(tray.name, "live", labels),
    }) as unknown as CompanionCommand
  const request = { homeId: HOME, cwd: "/work", command: ["fmx"], env: {} }

  await expect(ensureRuntimeSession(makeCompanion(tray.labels), { ...request, agentPicker: true })).rejects.toThrow(
    "detach every Client",
  )
  await expect(
    ensureRuntimeSession(makeCompanion(tray.labels), {
      ...request,
      agentPicker: true,
      hideSingleAgentPicker: true,
    }),
  ).rejects.toThrow("--agent-picker --hide-single-agent-picker")
  await expect(
    ensureRuntimeSession(makeCompanion(picker.labels), {
      ...request,
      agentPicker: true,
      hideSingleAgentPicker: true,
    }),
  ).rejects.toThrow("keeps its Agent picker visible for one Agent")
  expect(await ensureRuntimeSession(makeCompanion(picker.labels), request)).toEqual({
    socketPath: `/tmp/${tray.name}`,
    bootstrapPath: tray.bootstrapPath,
  })
  expect(await ensureRuntimeSession(makeCompanion(hiddenSingle.labels), { ...request, agentPicker: true })).toEqual({
    socketPath: `/tmp/${tray.name}`,
    bootstrapPath: tray.bootstrapPath,
  })
  expect(() => runtimeSessionIdentity(HOME, "/tmp/fmx-runtime-test", { hideSingleAgentPicker: true })).toThrow(
    "requires --agent-picker",
  )
})

test("an explicit Agent picker request replaces an exited Tray Runtime", async () => {
  const tray = runtimeSessionIdentity(HOME, "/tmp/fmx-runtime-test")
  let forgotten = false
  let created: CreateRequest | null = null
  const companion = {
    directory: "/tmp/fmx-runtime-test",
    settle: async () => session(tray.name, "exited", tray.labels),
    forget: async () => {
      forgotten = true
    },
    create: async (request: CreateRequest) => {
      created = request
      return { name: request.name, socketPath: `/tmp/${request.name}`, pid: 4, createdAt: 5 }
    },
  } as unknown as CompanionCommand

  expect(
    await ensureRuntimeSession(companion, {
      homeId: HOME,
      cwd: "/work",
      command: ["fmx", "--agent-picker"],
      env: {},
      agentPicker: true,
    }),
  ).toEqual({ socketPath: `/tmp/${tray.name}`, bootstrapPath: tray.bootstrapPath })
  expect(forgotten).toBe(true)
  expect(created).toMatchObject({ labels: { ...tray.labels, view: "agent-picker" } })
})

test("Runtime bootstrap waits for a first Client marker and consumes it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fmx-runtime-bootstrap-"))
  const marker = join(directory, "ready")
  try {
    setTimeout(() => void writeFile(marker, ""), 20)
    // The safety probe cannot fire within this deadline: success comes from
    // the directory notification (or the post-watch race check) alone.
    await waitForRuntimeBootstrap(marker, 1_000, 10_000)
    await expect(Bun.file(marker).exists()).resolves.toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("the Runtime command distinguishes a source checkout from a compiled binary", () => {
  expect(currentRuntimeCommand({ executable: "/bin/bun", main: "/work/src/index.ts" })).toEqual([
    "/bin/bun",
    "/work/src/index.ts",
  ])
  expect(currentRuntimeCommand({ executable: "/bin/fmx", main: "/$bunfs/root/index.js" })).toEqual(["/bin/fmx"])
  expect(currentRuntimeCommand({ executable: "/bin/bun", main: "/work/src/index.ts", name: "foo" })).toEqual([
    "/bin/bun",
    "/work/src/index.ts",
    "--name",
    "foo",
  ])
  expect(currentRuntimeCommand({ executable: "/bin/fmx", main: "/$bunfs/root/index.js", name: "foo" })).toEqual([
    "/bin/fmx",
    "--name",
    "foo",
  ])
  expect(currentRuntimeCommand({
    executable: "/bin/bun",
    main: "/work/src/index.ts",
    name: "foo",
    agentPicker: true,
  })).toEqual(["/bin/bun", "/work/src/index.ts", "--name", "foo", "--agent-picker"])
  expect(currentRuntimeCommand({
    executable: "/bin/fmx",
    main: "/$bunfs/root/index.js",
    agentPicker: true,
  })).toEqual(["/bin/fmx", "--agent-picker"])
  expect(currentRuntimeCommand({
    executable: "/bin/fmx",
    main: "/$bunfs/root/index.js",
    agentPicker: true,
    hideSingleAgentPicker: true,
  })).toEqual(["/bin/fmx", "--agent-picker", "--hide-single-agent-picker"])
  expect(() => currentRuntimeCommand({ hideSingleAgentPicker: true })).toThrow("requires --agent-picker")
})

function session(name: string, state: SessionEntry["state"], labels: Record<string, string>): SessionEntry {
  return {
    name,
    state,
    socketPath: state === "absent" ? null : `/tmp/${name}`,
    pid: null,
    clients: null,
    createdAt: null,
    command: null,
    cwd: null,
    labels,
    exit: null,
    detail: null,
  }
}
