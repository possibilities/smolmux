import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defaultAdeSocketPath } from "../src/ade-events.ts"
import { RuntimeBridge } from "../src/runtime-bridge.ts"
import type { Snapshot } from "../src/control-protocol.ts"
import { RuntimeClient } from "../src/runtime-client.ts"
import { resolveFmxHome } from "../src/home.ts"
import { runtimeSessionIdentity } from "../src/runtime-session.ts"
import { CompanionCommand } from "../src/zmx-command.ts"
import { COMPANION_BINARY_NAME } from "../src/zmx-environment.ts"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const FAKE_FX = resolve(ROOT, "tests/fixtures/fake-fx.ts")
const RUNTIME_EXTENSION_FIXTURE = resolve(ROOT, "tests/fixtures/runtime-extension.ts")
const FMX_COMMAND = process.env.FMX_BINARY_PATH
  ? [resolve(ROOT, process.env.FMX_BINARY_PATH)]
  : [process.execPath, resolve(ROOT, "src/index.ts")]
const COMPANION = process.env.FMX_ZMX_PATH
  ? resolve(ROOT, process.env.FMX_ZMX_PATH)
  : Bun.which(COMPANION_BINARY_NAME)
const PTY_TEST_ENABLED =
  process.env.FMX_RUN_PTY_TESTS === "1" &&
  typeof Bun.Terminal === "function" &&
  Boolean(COMPANION && existsSync(COMPANION))

const control = (letter: string) => letter.toUpperCase().charCodeAt(0) - 64
const homeOf = (temporaryDirectory: string, name: string | null = null) =>
  resolveFmxHome(name, { XDG_CONFIG_HOME: join(temporaryDirectory, "config") }).id
const companionDirectoryFor = (temporaryDirectory: string) =>
  `/tmp/fmxz-${createHash("sha256").update(basename(temporaryDirectory)).digest("hex").slice(0, 12)}`

function privateHome(temporaryDirectory: string): Record<string, string> {
  return {
    XDG_CONFIG_HOME: join(temporaryDirectory, "config"),
    FMX_ZMX_PATH: COMPANION!,
    FMX_ZMX_DIR: companionDirectoryFor(temporaryDirectory),
    FMX_MANIFEST_PATH: join(temporaryDirectory, "agents.json"),
  }
}

test.skipIf(!PTY_TEST_ENABLED)(
  "multiple Clients share one Runtime and hand off sizing ownership",
  async () => {
    await chmod(FAKE_FX, 0o755)
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "fmx-clients-e2e-"))
    const configFile = join(temporaryDirectory, "config.toml")
    await writeFile(configFile, `project_roots = [${JSON.stringify(ROOT)}]\n`)
    const env = {
      ...process.env,
      FMX_FX_PATH: FAKE_FX,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      FMX_CONFIG_PATH: configFile,
      FMX_STATE_PATH: join(temporaryDirectory, "state.json"),
      ...privateHome(temporaryDirectory),
    }
    const spawnClient = (sink: { output: string }, cols: number, rows: number) => {
      const decoder = new TextDecoder()
      return Bun.spawn(FMX_COMMAND, {
        cwd: ROOT,
        env,
        terminal: {
          cols,
          rows,
          data: (_terminal, bytes) => {
            sink.output += decoder.decode(bytes, { stream: true })
          },
        },
      })
    }

    const firstOutput = { output: "" }
    const first = spawnClient(firstOutput, 100, 24)
    let second: ReturnType<typeof spawnClient> | null = null
    try {
      await waitUntil(() => firstOutput.output.includes("no agents"), 8_000, () => firstOutput.output)
      const initial = await orientation(temporaryDirectory, env)
      expect(initial?.fmx).toMatchObject({ cols: 100, rows: 24 })
      const runtimePid = initial!.fmx.pid

      const secondOutput = { output: "" }
      second = spawnClient(secondOutput, 60, 16)
      await waitUntil(
        async () => {
          const snapshot = await orientation(temporaryDirectory, env)
          return snapshot?.fmx.pid === runtimePid && snapshot.fmx.cols === 60 && snapshot.fmx.rows === 16
        },
        8_000,
        () => secondOutput.output,
      )

      first.terminal?.write(new TextEncoder().encode("\x1b[I"))
      await waitUntil(
        async () => {
          const snapshot = await orientation(temporaryDirectory, env)
          return snapshot?.fmx.cols === 100 && snapshot.fmx.rows === 24
        },
        5_000,
        () => firstOutput.output,
      )

      first.terminal?.write(Uint8Array.of(control("b"), "d".charCodeAt(0)))
      expect(await withTimeout(first.exited, 6_000, "first Client did not detach")).toBe(0)
      first.terminal?.close()
      await waitUntil(
        async () => {
          const snapshot = await orientation(temporaryDirectory, env)
          return snapshot?.fmx.pid === runtimePid && snapshot.fmx.cols === 60 && snapshot.fmx.rows === 16
        },
        5_000,
        () => secondOutput.output,
      )

      second.terminal?.write(Uint8Array.of(control("b"), "d".charCodeAt(0)))
      expect(await withTimeout(second.exited, 6_000, "final Client did not detach")).toBe(0)
      second.terminal?.close()
      await waitUntil(
        async () => (await orientation(temporaryDirectory, env)) === null,
        8_000,
        () => secondOutput.output,
      )
    } finally {
      if (first.exitCode === null) first.kill("SIGKILL")
      first.terminal?.close()
      if (second && second.exitCode === null) second.kill("SIGKILL")
      second?.terminal?.close()
      await endCompanionSessions(temporaryDirectory)
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  },
  30_000,
)

test.skipIf(!PTY_TEST_ENABLED)(
  "named fmx Runtimes are independent and same-name Clients join",
  async () => {
    await chmod(FAKE_FX, 0o755)
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "fmx-names-e2e-"))
    const configFile = join(temporaryDirectory, "config.toml")
    await writeFile(configFile, `project_roots = [${JSON.stringify(ROOT)}]\n`)
    const env = {
      ...process.env,
      FMX_FX_PATH: FAKE_FX,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      FMX_CONFIG_PATH: configFile,
      XDG_CONFIG_HOME: join(temporaryDirectory, "config"),
      FMX_ZMX_PATH: COMPANION!,
      FMX_ZMX_DIR: companionDirectoryFor(temporaryDirectory),
      FMX_MANIFEST_PATH: undefined,
      FMX_STATE_PATH: undefined,
    }
    const spawnClient = (name: string, sink: { output: string }, cols: number, rows: number) => {
      const decoder = new TextDecoder()
      return Bun.spawn([...FMX_COMMAND, "--name", name], {
        cwd: ROOT,
        env,
        terminal: {
          cols,
          rows,
          data: (_terminal, bytes) => {
            sink.output += decoder.decode(bytes, { stream: true })
          },
        },
      })
    }

    const fooOutput = { output: "" }
    const barOutput = { output: "" }
    const foo = spawnClient("foo", fooOutput, 100, 24)
    const bar = spawnClient("bar", barOutput, 80, 20)
    let secondFoo: ReturnType<typeof spawnClient> | null = null
    try {
      await waitUntil(() => fooOutput.output.includes("no agents"), 8_000, () => fooOutput.output)
      await waitUntil(() => barOutput.output.includes("no agents"), 8_000, () => barOutput.output)

      const fooInitial = await orientation(temporaryDirectory, env, "foo")
      const barInitial = await orientation(temporaryDirectory, env, "bar")
      expect(fooInitial?.fmx).toMatchObject({ name: "foo", cols: 100, rows: 24 })
      expect(barInitial?.fmx).toMatchObject({ name: "bar", cols: 80, rows: 20 })
      expect(fooInitial!.fmx.pid).not.toBe(barInitial!.fmx.pid)

      const fooAgent = await runtimeRequest(temporaryDirectory, env, "foo", "agent.create", {
        directory: ROOT,
      }) as { agent: Snapshot["agents"][number] }
      const barAgent = await runtimeRequest(temporaryDirectory, env, "bar", "agent.create", {
        directory: ROOT,
      }) as { agent: Snapshot["agents"][number] }
      expect(fooAgent.agent.display_id).toBe(1)
      expect(barAgent.agent.display_id).toBe(1)
      expect(fooAgent.agent.agent_id).not.toBe(barAgent.agent.agent_id)

      const secondFooOutput = { output: "" }
      secondFoo = spawnClient("foo", secondFooOutput, 60, 16)
      await waitUntil(
        async () => {
          const snapshot = await orientation(temporaryDirectory, env, "foo")
          return snapshot?.fmx.pid === fooInitial!.fmx.pid &&
            snapshot.fmx.cols === 60 && snapshot.fmx.rows === 16 &&
            snapshot.agents.length === 1 && snapshot.agents[0]?.agent_id === fooAgent.agent.agent_id
        },
        8_000,
        () => secondFooOutput.output,
      )
      expect((await orientation(temporaryDirectory, env, "bar"))?.agents[0]?.agent_id).toBe(
        barAgent.agent.agent_id,
      )

      foo.terminal?.write(Uint8Array.of(control("b"), "d".charCodeAt(0)))
      expect(await withTimeout(foo.exited, 6_000, "first foo Client did not detach")).toBe(0)
      foo.terminal?.close()
      expect((await orientation(temporaryDirectory, env, "foo"))?.fmx.pid).toBe(fooInitial!.fmx.pid)

      secondFoo.terminal?.write(Uint8Array.of(control("b"), "d".charCodeAt(0)))
      expect(await withTimeout(secondFoo.exited, 6_000, "final foo Client did not detach")).toBe(0)
      secondFoo.terminal?.close()
      await waitUntil(
        async () => (await orientation(temporaryDirectory, env, "foo")) === null,
        8_000,
        () => secondFooOutput.output,
      )
      expect(await orientation(temporaryDirectory, env, "bar")).not.toBeNull()

      bar.terminal?.write(Uint8Array.of(control("b"), "d".charCodeAt(0)))
      expect(await withTimeout(bar.exited, 6_000, "bar Client did not detach")).toBe(0)
      bar.terminal?.close()
      await waitUntil(
        async () => (await orientation(temporaryDirectory, env, "bar")) === null,
        8_000,
        () => barOutput.output,
      )
    } finally {
      if (foo.exitCode === null) foo.kill("SIGKILL")
      foo.terminal?.close()
      if (bar.exitCode === null) bar.kill("SIGKILL")
      bar.terminal?.close()
      if (secondFoo && secondFoo.exitCode === null) secondFoo.kill("SIGKILL")
      secondFoo?.terminal?.close()
      await endCompanionSessions(temporaryDirectory)
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  },
  45_000,
)

test.skipIf(!PTY_TEST_ENABLED)(
  "associated Runtime ends with its final Client, then restores its extension and surviving Agent",
  async () => {
    await chmod(FAKE_FX, 0o755)
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "fmx-extension-e2e-"))
    const fixture = await writeAssociatedRuntimeFixture(temporaryDirectory)
    const fxLog = join(temporaryDirectory, "fx.log")
    const alphaExtensionLog = join(temporaryDirectory, "alpha-extension.log")
    const betaExtensionLog = join(temporaryDirectory, "beta-extension.log")
    const baseEnv = {
      ...process.env,
      FMX_FX_PATH: FAKE_FX,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      XDG_CONFIG_HOME: join(temporaryDirectory, "config"),
      FMX_ZMX_PATH: COMPANION!,
      FMX_ZMX_DIR: companionDirectoryFor(temporaryDirectory),
      FMX_CONFIG_PATH: undefined,
      FMX_MANIFEST_PATH: undefined,
      FMX_STATE_PATH: undefined,
      FMX_TEST_LOG: fxLog,
      FMX_TEST_RECORD_LAUNCH_ENV: "1",
    }
    const alphaExtensionEnv = {
      FMX_FIXTURE_EXTENSION_LOG: alphaExtensionLog,
      FMX_FIXTURE_EXTENSION_MODE: "ready",
      FMX_FIXTURE_EXTENSION_AUTO_SNAPSHOT: "1",
      FMX_FIXTURE_EXTENSION_PRESENT_FOCUS: "true",
      FMX_FIXTURE_EXTENSION_PRESENT_DELAY_MS: "750",
      FMX_FIXTURE_EXTENSION_CLEAR_AFTER_ACTION: "1",
      FMX_FIXTURE_EXTENSION_SCRIPT: recoveryCardScript("alpha"),
    }
    const spawnClient = (
      name: string,
      sink: { output: string },
      extensionEnv: Record<string, string | undefined> = {},
      flags: string[] = [],
      cols = 100,
      rows = 24,
    ) => {
      const decoder = new TextDecoder()
      return Bun.spawn([...FMX_COMMAND, "--name", name, ...flags], {
        cwd: ROOT,
        env: { ...baseEnv, ...extensionEnv },
        terminal: {
          cols,
          rows,
          data: (_terminal, bytes) => {
            sink.output += decoder.decode(bytes, { stream: true })
          },
        },
      })
    }

    const alphaOutput = { output: "" }
    const alpha = spawnClient(
      "alpha",
      alphaOutput,
      alphaExtensionEnv,
      ["--agent-picker", "--hide-single-agent-picker"],
    )
    let secondAlpha: ReturnType<typeof spawnClient> | null = null
    let restartedAlpha: ReturnType<typeof spawnClient> | null = null
    let beta: ReturnType<typeof spawnClient> | null = null
    try {
      await waitUntil(
        () => alphaOutput.output.includes("Member unavailable"),
        12_000,
        () => alphaOutput.output,
      )
      await waitUntil(
        async () => {
          const snapshot = await orientation(temporaryDirectory, baseEnv, "alpha")
          return snapshot?.fmx.name === "alpha" && snapshot.fmx.cols === 100 && snapshot.fmx.rows === 24
        },
        8_000,
        () => alphaOutput.output,
      )
      const initial = await orientation(temporaryDirectory, baseEnv, "alpha")
      expect(initial?.fmx).toMatchObject({ name: "alpha", cols: 100, rows: 24 })
      expect(await orientation(temporaryDirectory, baseEnv, "beta")).toBeNull()
      const runtimePid = initial!.fmx.pid

      const created = await runtimeRequest(temporaryDirectory, baseEnv, "alpha", "agent.create", {
        directory: ROOT,
      }) as { agent: Snapshot["agents"][number] }
      await waitUntil(
        async () => {
          const log = await readableFile(fxLog)
          return log.includes(`start 1 ["--state-dir","${fixture.stateDirectory}"]`) &&
            log.includes('launch-defaults 1 ["fixture/model","max"]')
        },
        8_000,
        () => "configured fake Fx did not report its launch defaults",
      )
      await waitUntil(
        async () => (await extensionMessages(alphaExtensionLog)).some((message) =>
          message.message_type === "snapshot_result" &&
          Array.isArray(message.agents) && message.agents.length === 1
        ),
        8_000,
        () => "fixture did not receive the authoritative Agent snapshot",
      )

      // The fixture waits after observing the Agent snapshot. Put the help
      // modal up before its focus=true request arrives, so the exact private
      // present seam must return busy rather than stealing terminal focus.
      alpha.terminal?.write(Uint8Array.of(control("b"), "?".charCodeAt(0)))
      await waitUntil(
        async () => (await extensionMessages(alphaExtensionLog)).some((message) =>
          message.message_type === "response" &&
          message.operation === "present" &&
          message.ok === false &&
          isRecord(message.error) && message.error.code === "busy"
        ),
        8_000,
        () => alphaOutput.output,
      )
      alpha.terminal?.write(Uint8Array.of(0x1b))
      await Bun.sleep(50)
      alpha.terminal?.write(Uint8Array.of(0x0d))
      await waitUntil(
        async () => {
          const messages = await extensionMessages(alphaExtensionLog)
          return messages.some((message) => message.message_type === "unavailable_slot_action") &&
            messages.some((message) =>
              message.message_type === "response" &&
              message.operation === "unavailable_slot_clear" &&
              message.ok === true
            )
        },
        8_000,
        () => alphaOutput.output,
      )
      await waitUntil(
        async () => (await orientation(temporaryDirectory, baseEnv, "alpha"))?.active === created.agent.id,
        5_000,
        () => alphaOutput.output,
      )

      // A live Runtime wins over a now-invalid disk association. The plain
      // Client also joins the inherited picker Runtime without restating its
      // view flags, and no second extension child is launched.
      await writeFile(fixture.configPath, fixture.invalidConfig)
      const secondOutput = { output: "" }
      secondAlpha = spawnClient("alpha", secondOutput, {}, [], 70, 18)
      await waitUntil(
        async () => {
          const snapshot = await orientation(temporaryDirectory, baseEnv, "alpha")
          return snapshot?.fmx.pid === runtimePid && snapshot.fmx.cols === 70 && snapshot.fmx.rows === 18
        },
        8_000,
        () => secondOutput.output,
      )
      expect((await extensionMessages(alphaExtensionLog)).filter((message) =>
        message.message_type === "initialize"
      )).toHaveLength(1)
      await writeFile(fixture.configPath, fixture.config)

      const companion = new CompanionCommand(
        companionDirectoryFor(temporaryDirectory),
        process.env,
        COMPANION!,
      )
      const runtimeName = runtimeSessionIdentity(
        homeOf(temporaryDirectory, "alpha"),
        companionDirectoryFor(temporaryDirectory),
      ).name
      const agentName = `fmx-${created.agent.agent_id}`
      const initialAgentSession = await companion.inspect(agentName)
      expect(initialAgentSession.state).toBe("live")
      expect(initialAgentSession.pid).not.toBeNull()

      alpha.terminal?.write(Uint8Array.of(control("b"), "d".charCodeAt(0)))
      expect(await withTimeout(alpha.exited, 6_000, "first associated Client did not detach")).toBe(0)
      alpha.terminal?.close()
      secondAlpha.terminal?.write(Uint8Array.of(control("b"), "d".charCodeAt(0)))
      expect(await withTimeout(secondAlpha.exited, 6_000, "final associated Client did not detach")).toBe(0)
      secondAlpha.terminal?.close()
      const ended = await companion.settle(runtimeName, 8_000)
      expect(ended.state).toBe("exited")
      await waitUntil(
        async () => (await orientation(temporaryDirectory, baseEnv, "alpha")) === null,
        5_000,
        () => "ended Runtime bridge remained reachable",
      )
      expect(await companion.inspect(agentName)).toMatchObject({
        state: "live",
        pid: initialAgentSession.pid,
      })

      const restartedOutput = { output: "" }
      restartedAlpha = spawnClient(
        "alpha",
        restartedOutput,
        alphaExtensionEnv,
        ["--agent-picker", "--hide-single-agent-picker"],
        82,
        20,
      )
      await waitUntil(
        async () => {
          const snapshot = await orientation(temporaryDirectory, baseEnv, "alpha")
          return snapshot !== null && snapshot.fmx.pid !== runtimePid &&
            snapshot.fmx.cols === 82 && snapshot.fmx.rows === 20 &&
            snapshot.agents.some((agent) => agent.agent_id === created.agent.agent_id)
        },
        15_000,
        () => restartedOutput.output,
      )
      await waitUntil(
        async () => (await extensionMessages(alphaExtensionLog)).filter((message) =>
          message.message_type === "initialize"
        ).length === 2,
        5_000,
        () => "restarted Runtime did not repeat exact extension readiness",
      )
      expect(await companion.inspect(agentName)).toMatchObject({
        state: "live",
        pid: initialAgentSession.pid,
      })
      restartedAlpha.terminal?.write(Uint8Array.of(control("b"), "d".charCodeAt(0)))
      expect(await withTimeout(restartedAlpha.exited, 6_000, "restarted Client did not detach")).toBe(0)
      restartedAlpha.terminal?.close()
      await waitUntil(
        async () => (await orientation(temporaryDirectory, baseEnv, "alpha")) === null,
        8_000,
        () => restartedOutput.output,
      )

      // Starting the absent peer later is independent and succeeds; it never
      // had to exist for alpha's readiness or restart.
      const betaOutput = { output: "" }
      beta = spawnClient("beta", betaOutput, {
        FMX_FIXTURE_EXTENSION_LOG: betaExtensionLog,
        FMX_FIXTURE_EXTENSION_MODE: "ready",
        FMX_FIXTURE_EXTENSION_AUTO_SNAPSHOT: "1",
      })
      await waitUntil(
        async () => (await orientation(temporaryDirectory, baseEnv, "beta")) !== null,
        12_000,
        () => betaOutput.output,
      )
      expect(await orientation(temporaryDirectory, baseEnv, "alpha")).toBeNull()
      beta.terminal?.write(Uint8Array.of(control("b"), "d".charCodeAt(0)))
      expect(await withTimeout(beta.exited, 6_000, "peer Client did not detach")).toBe(0)
      beta.terminal?.close()
      await waitUntil(
        async () => (await orientation(temporaryDirectory, baseEnv, "beta")) === null,
        8_000,
        () => betaOutput.output,
      )
    } finally {
      if (alpha.exitCode === null) alpha.kill("SIGKILL")
      alpha.terminal?.close()
      for (const client of [secondAlpha, restartedAlpha, beta]) {
        if (client?.exitCode === null) client.kill("SIGKILL")
        client?.terminal?.close()
      }
      await endCompanionSessions(temporaryDirectory)
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  },
  90_000,
)

test.skipIf(!PTY_TEST_ENABLED)(
  "either uniform association member can cold-start before its absent peer",
  async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "fmx-extension-order-e2e-"))
    await writeAssociatedRuntimeFixture(temporaryDirectory)
    const env = {
      ...process.env,
      FMX_FX_PATH: FAKE_FX,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      XDG_CONFIG_HOME: join(temporaryDirectory, "config"),
      FMX_ZMX_PATH: COMPANION!,
      FMX_ZMX_DIR: companionDirectoryFor(temporaryDirectory),
      FMX_CONFIG_PATH: undefined,
      FMX_MANIFEST_PATH: undefined,
      FMX_STATE_PATH: undefined,
      FMX_FIXTURE_EXTENSION_MODE: "ready",
      FMX_FIXTURE_EXTENSION_AUTO_SNAPSHOT: "1",
    }
    const spawnClient = (name: string, output: { value: string }) => {
      const decoder = new TextDecoder()
      return Bun.spawn([...FMX_COMMAND, "--name", name], {
        cwd: ROOT,
        env: {
          ...env,
          FMX_FIXTURE_EXTENSION_LOG: join(temporaryDirectory, `${name}-extension.log`),
        },
        terminal: {
          cols: 80,
          rows: 20,
          data: (_terminal, bytes) => {
            output.value += decoder.decode(bytes, { stream: true })
          },
        },
      })
    }
    const betaOutput = { value: "" }
    const alphaOutput = { value: "" }
    const beta = spawnClient("beta", betaOutput)
    let alpha: ReturnType<typeof spawnClient> | null = null
    try {
      await waitUntil(
        async () => (await orientation(temporaryDirectory, env, "beta")) !== null,
        12_000,
        () => betaOutput.value,
      )
      expect(await orientation(temporaryDirectory, env, "alpha")).toBeNull()
      alpha = spawnClient("alpha", alphaOutput)
      await waitUntil(
        async () => (await orientation(temporaryDirectory, env, "alpha")) !== null,
        12_000,
        () => alphaOutput.value,
      )
      beta.terminal?.write(Uint8Array.of(control("b"), "d".charCodeAt(0)))
      expect(await withTimeout(beta.exited, 6_000, "beta-first Client did not detach")).toBe(0)
      beta.terminal?.close()
      alpha.terminal?.write(Uint8Array.of(control("b"), "d".charCodeAt(0)))
      expect(await withTimeout(alpha.exited, 6_000, "alpha peer Client did not detach")).toBe(0)
      alpha.terminal?.close()
      await waitUntil(
        async () => (await orientation(temporaryDirectory, env, "beta")) === null,
        8_000,
        () => betaOutput.value,
      )
      await waitUntil(
        async () => (await orientation(temporaryDirectory, env, "alpha")) === null,
        8_000,
        () => alphaOutput.value,
      )
    } finally {
      if (beta.exitCode === null) beta.kill("SIGKILL")
      beta.terminal?.close()
      if (alpha?.exitCode === null) alpha.kill("SIGKILL")
      alpha?.terminal?.close()
      await endCompanionSessions(temporaryDirectory)
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  },
  45_000,
)

async function writeAssociatedRuntimeFixture(temporaryDirectory: string) {
  const configDirectory = join(temporaryDirectory, "config", "fmx")
  const configPath = join(configDirectory, "config.toml")
  const registrationPath = join(configDirectory, "runtime-extensions", "fixture-extension.toml")
  const stateDirectory = join(temporaryDirectory, "fx-state-alpha")
  const config = [
    `project_roots = [${JSON.stringify(ROOT)}]`,
    "",
    "[agent_defaults.alpha]",
    `state_dir = ${JSON.stringify(stateDirectory)}`,
    'model = "fixture/model"',
    'effort = "max"',
    "",
    "[workplace_instances.fixture]",
    "schema_version = 1",
    'extension = "fixture-extension"',
    'configuration = "fixture-configuration"',
    "",
    "[workplace_instances.fixture.role_surfaces]",
    'first = "alpha"',
    'second = "beta"',
    "",
  ].join("\n")
  const invalidConfig = [
    `project_roots = [${JSON.stringify(ROOT)}]`,
    "",
    "[workplace_instances.fixture]",
    "schema_version = 1",
    'extension = "fixture-extension"',
    'configuration = "fixture-configuration"',
    "",
    "[workplace_instances.fixture.role_surfaces]",
    'only = "alpha"',
    "",
  ].join("\n")
  const registration = [
    "schema_version = 1",
    'extension_id = "fixture-extension"',
    `argv = [${JSON.stringify(process.execPath)}, ${JSON.stringify(RUNTIME_EXTENSION_FIXTURE)}]`,
    "",
    "[protocol]",
    "minimum = 1",
    "maximum = 1",
    "",
    "[capabilities]",
    "headless_liveness = true",
    "",
  ].join("\n")
  await mkdir(dirname(registrationPath), { recursive: true })
  await Promise.all([
    writeFile(configPath, config),
    writeFile(registrationPath, registration),
  ])
  return { config, configPath, invalidConfig, registrationPath, stateDirectory }
}

function recoveryCardScript(fmxSession: string): string {
  return JSON.stringify([{
    schema_id: "fmx.runtime-extension",
    schema_version: 1,
    message_type: "unavailable_slot_publish",
    request_id: "fixture-card-publish",
    fmx_session: fmxSession,
    card: {
      slot_id: "fixture-slot",
      card_revision: "1",
      title: "Member unavailable",
      message: "The exact managed member could not be restored.",
      action: {
        action_id: "fixture-fresh-start",
        label: "Start fresh",
      },
    },
  }])
}

async function readableFile(path: string): Promise<string> {
  try {
    if (!(await Bun.file(path).exists())) return ""
    return await Bun.file(path).text()
  } catch {
    return ""
  }
}

async function extensionMessages(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await readableFile(path)
  const messages: Array<Record<string, unknown>> = []
  for (const line of text.split("\n")) {
    if (line.length === 0) continue
    try {
      const value: unknown = JSON.parse(line)
      if (isRecord(value)) messages.push(value)
    } catch {
      // A polling read may catch the final append between bytes. The next
      // read sees the complete newline-terminated record.
    }
  }
  return messages
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function orientation(
  temporaryDirectory: string,
  env: NodeJS.ProcessEnv,
  name: string | null = null,
): Promise<Snapshot | null> {
  const socketPath = RuntimeBridge.pathFor(defaultAdeSocketPath(homeOf(temporaryDirectory, name)))
  try {
    return await new RuntimeClient({ env: { ...env, FMX_SOCKET_PATH: socketPath } })
      .request("orient", {}, new AbortController().signal) as Snapshot
  } catch {
    return null
  }
}

async function runtimeRequest(
  temporaryDirectory: string,
  env: NodeJS.ProcessEnv,
  name: string,
  method: Parameters<RuntimeClient["request"]>[0],
  params: Record<string, unknown>,
): Promise<unknown> {
  const socketPath = RuntimeBridge.pathFor(defaultAdeSocketPath(homeOf(temporaryDirectory, name)))
  return await new RuntimeClient({ env: { ...env, FMX_SOCKET_PATH: socketPath } })
    .request(method, params, new AbortController().signal)
}

async function endCompanionSessions(temporaryDirectory: string): Promise<void> {
  const companion = new CompanionCommand(companionDirectoryFor(temporaryDirectory), process.env, COMPANION!)
  let sessions = await companion.list().catch(() => [])
  for (const session of sessions) {
    if (session.state === "live") await companion.kill(session.name).catch(() => {})
  }
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    sessions = await companion.list().catch(() => [])
    if (sessions.every((session) => session.state === "exited" || session.state === "absent")) break
    await Bun.sleep(50)
  }
  for (const session of sessions) {
    if (session.state === "exited") await companion.forget(session.name).catch(() => {})
  }
  await rm(companionDirectoryFor(temporaryDirectory), { recursive: true, force: true })
}

async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  diagnostic: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(`condition timed out\n${diagnostic()}`)
    await Bun.sleep(20)
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
