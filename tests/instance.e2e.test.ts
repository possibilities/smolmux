import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync as fileExists } from "node:fs"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ApiClient } from "../src/api-client.ts"
import { apiSocketPathFor } from "../src/api-server.ts"
import { resolveInstance } from "../src/instance.ts"
import type { EventFrame, LayoutView, SessionView } from "../src/protocol.ts"
import { CompanionCommand } from "../src/zmx-command.ts"
import { COMPANION_BINARY_NAME } from "../src/zmx-environment.ts"

/**
 * One real Instance: a Companion-held Runtime, the API socket it binds, a
 * terminal Client attached to it, and Sessions that outlive the Runtime that
 * started them. Needs a Companion and Bun's PTY, so it is opt-in.
 */
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const FAKE_APP = join(ROOT, "tests/fixtures/fake-app.ts")
const SMOLMUX_COMMAND = process.env.SMOLMUX_BINARY_PATH
  ? [resolve(ROOT, process.env.SMOLMUX_BINARY_PATH)]
  : [process.execPath, join(ROOT, "src/index.ts")]
const COMPANION = process.env.SMOLMUX_ZMX_PATH ? resolve(ROOT, process.env.SMOLMUX_ZMX_PATH) : Bun.which(COMPANION_BINARY_NAME)
const ENABLED =
  process.env.SMOLMUX_RUN_PTY_TESTS === "1" &&
  typeof Bun.Terminal === "function" &&
  Boolean(COMPANION && fileExists(COMPANION))

const control = (letter: string) => letter.toUpperCase().charCodeAt(0) - 64

/** The Instance a given environment selects, exactly as smolmux resolves it. */
const socketFor = (env: Record<string, string>, name: string | null = null) =>
  apiSocketPathFor(resolveInstance(name, env).id)

function environment(directory: string, name: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    SMOLMUX_THEME: "dark",
    SMOLMUX_CONFIG_PATH: join(directory, "config.toml"),
    SMOLMUX_ZMX_PATH: COMPANION!,
    SMOLMUX_ZMX_DIR: `/tmp/smolmuxz-${createHash("sha256").update(basename(directory)).digest("hex").slice(0, 12)}`,
    XDG_CONFIG_HOME: join(directory, "config"),
    SMOLMUX_TEST_INSTANCE: name,
  }
}

async function smolmux(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([...SMOLMUX_COMMAND, ...args], { cwd: ROOT, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: (await proc.exited) ?? 0, stdout, stderr }
}

const waitUntil = async (check: () => boolean | Promise<boolean>, timeoutMs = 10_000, describe?: () => string) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() >= deadline) throw new Error(`timed out${describe ? `: ${describe()}` : ""}`)
    await Bun.sleep(50)
  }
}

async function endCompanionSessions(env: Record<string, string>): Promise<void> {
  const companion = new CompanionCommand(env.SMOLMUX_ZMX_DIR!, env, COMPANION!)
  for (const session of await companion.list().catch(() => [])) {
    if (session.state === "live") await companion.kill(session.name).catch(() => {})
  }
  await Bun.sleep(300)
  for (const session of await companion.list().catch(() => [])) {
    if (session.state === "exited") await companion.forget(session.name).catch(() => {})
  }
}

test.skipIf(!ENABLED)(
  "an Instance is started, driven, attached to, and stopped entirely over its socket",
  async () => {
    await chmod(FAKE_APP, 0o755)
    const directory = await mkdtemp(join(tmpdir(), "smolmux-e2e-"))
    const env = environment(directory, "default")
    const socketPath = socketFor(env)
    let client: ApiClient | null = null
    let attached: ReturnType<typeof Bun.spawn> | null = null

    try {
      // Start is headless: no terminal, and it prints the socket to drive.
      const started = await smolmux(["start"], env)
      expect(started.code).toBe(0)
      expect(started.stdout.trim()).toBe(socketPath)

      const events: EventFrame[] = []
      client = await ApiClient.connect(socketPath, { onEvent: (event) => events.push(event) })
      await client.request("event.subscribe")

      const snapshot = await client.request("state.get")
      expect(snapshot.availability).toBe("ready")
      const status = snapshot.state!
      expect(status).toMatchObject({ name: "default", sessions: [], theme: "dark" })
      expect(status.layout.root).toEqual({ text: "no sessions" })

      // Two Sessions, then a Layout that shows both.
      const tray = await client.request("session.create", {
        name: "tray",
        argv: [FAKE_APP],
        cwd: ROOT,
        env: { SMOLMUX_TEST_TITLE: "the tray", SMOLMUX_TEST_BANNER: "tray ready" },
        labels: { role: "list" },
      })
      // Nobody has applied a Layout, so the Runtime's own one shows the first
      // Session rather than an empty state that claims nothing is running.
      expect(tray).toMatchObject({ name: "tray", shown: true, state: "live" })
      await client.request("session.create", {
        name: "main",
        argv: [FAKE_APP],
        cwd: ROOT,
        env: { SMOLMUX_TEST_BANNER: "main ready" },
      })

      const layout = await client.request("layout.apply", {
        root: { row: [{ session: "tray", size: 26, min: 20 }, { session: "main", min: 20 }] },
        focus: "main",
      })
      expect(layout.focus).toBe("main")
      expect(layout.panes.map((pane) => pane.session)).toEqual(["tray", "main"])
      expect(layout.revision).toBeGreaterThan(0)

      // Capture reads a Session's screen whether or not a Pane shows it. The
      // Pane's size reaches the PTY on a render frame rather than inside the
      // apply, so wait for the width this asserts and not only for the banner.
      await waitUntil(async () => {
        const capture = await client!.request("session.capture", { name: "tray" })
        return capture.lines.join("").includes("tray ready") && capture.cols === 26
      })
      const capture = await client.request("session.capture", { name: "tray" })
      expect(capture.title).toBe("the tray")
      expect(capture.cols).toBe(26)
      expect(capture.screen_start).toBe(0)

      // History crosses the socket whole, and the visible screen is its tail.
      const withHistory = await client.request("session.capture", { name: "tray", scrollback: 200 })
      expect(withHistory.lines.slice(withHistory.screen_start)).toEqual(capture.lines)
      await expect(
        client.request("session.capture", { name: "tray", scrollback: 100_000 }),
      ).rejects.toMatchObject({ code: "invalid_params" })

      // Input crosses the socket as intent and reaches the PTY as bytes: the
      // fake app echoes a completed line back, so `got:` proves the whole
      // path, encoder included.
      await client.request("session.input", {
        name: "main",
        events: [{ text: "hello" }, { key: "enter" }],
      })
      await waitUntil(async () => {
        const screen = await client!.request("session.capture", { name: "main" })
        return screen.lines.join("\n").includes("got:hello")
      })

      // Mouse needs the coordinates only a Pane gives it.
      await expect(
        client.request("session.input", { name: "tray", events: [{ mouse: { action: "down", x: 0, y: 0 } }] }),
      ).resolves.toBeDefined()
      await expect(
        client.request("session.input", { name: "nosuch", events: [{ text: "x" }] }),
      ).rejects.toMatchObject({ code: "not_found" })

      // A stale Layout write is refused rather than clobbering what moved.
      await expect(
        client.request("layout.apply", { root: { session: "main" }, revision: layout.revision - 1 }),
      ).rejects.toMatchObject({ code: "conflict" })

      // A human attaches, sees the Layout, and detaches without ending anything.
      let output = ""
      const decoder = new TextDecoder()
      attached = Bun.spawn([...SMOLMUX_COMMAND, "attach"], {
        cwd: ROOT,
        env,
        terminal: {
          cols: 100,
          rows: 30,
          data: (_terminal, bytes) => {
            output += decoder.decode(bytes, { stream: true })
          },
        },
      })
      await waitUntil(
        () => output.includes("tray ready") && output.includes("main ready"),
        10_000,
        () => JSON.stringify(output.slice(-400)),
      )
      await waitUntil(async () => (await client!.request("instance.status")).stage.cols === 100)

      // A copy reaches the terminal the human sits at, wherever that is: the
      // Runtime writes OSC 52 and the Client relays it like any other byte.
      const copiedText = "copied over the wire ✓"
      expect(await client.request("client.copy", { text: copiedText })).toEqual({ written: true })
      const payload = Buffer.from(copiedText, "utf8").toString("base64")
      await waitUntil(
        () => output.includes("\x1b]52;") && output.includes(payload),
        10_000,
        () => JSON.stringify(output.slice(-400)),
      )

      // The Client receives Kitty keyboard protocol from the host terminal,
      // but the focused Session receives the legacy byte it understands.
      attached.terminal?.write(new TextEncoder().encode("\x1b[99;5u"))
      await waitUntil(() =>
        events.some(
          (event) => event.event === "session.exited" && (event.data as { name: string }).name === "main",
        ),
      )

      attached.terminal?.write(Uint8Array.of(control("b"), "d".charCodeAt(0)))
      expect(await attached.exited).toBe(0)
      attached.terminal?.close()
      attached = null

      // Detaching a Client never ends a Session or the Runtime.
      const afterDetach = await client.request("session.list")
      expect(afterDetach.sessions.map((session) => session.name)).toEqual(["tray"])

      // Nothing of the copy is kept: a Client attaching later gets the screen
      // through Restore and no OSC 52 with it.
      let later = ""
      const laterDecoder = new TextDecoder()
      attached = Bun.spawn([...SMOLMUX_COMMAND, "attach"], {
        cwd: ROOT,
        env,
        terminal: {
          cols: 100,
          rows: 30,
          data: (_terminal, bytes) => {
            later += laterDecoder.decode(bytes, { stream: true })
          },
        },
      })
      await waitUntil(() => later.includes("tray ready"), 10_000, () => JSON.stringify(later.slice(-400)))
      await Bun.sleep(300)
      expect(later).not.toContain("\x1b]52;")
      attached.terminal?.write(Uint8Array.of(control("b"), "d".charCodeAt(0)))
      expect(await attached.exited).toBe(0)
      attached.terminal?.close()
      attached = null

      // A Session that ends is reported and leaves the roster.
      await client.request("session.kill", { name: "tray" })
      await waitUntil(() =>
        events.some(
          (event) => event.event === "session.exited" && (event.data as { name: string }).name === "tray",
        ),
      )
      const exited = events.find(
        (event) => event.event === "session.exited" && (event.data as { name: string }).name === "tray",
      )!.data as { name: string }
      expect(exited.name).toBe("tray")
      await waitUntil(async () => (await client!.request("session.list")).sessions.length === 0)

      // Stop is total: every Session and the Runtime.
      await client.request("instance.stop")
      await waitUntil(async () => !(await answers(socketPath)))
      const gone = await smolmux(["status"], env)
      expect(gone.code).toBe(1)
      expect(gone.stderr).toContain("no smolmux Runtime is running for default")
    } finally {
      client?.close()
      if (attached && attached.exitCode === null) attached.kill("SIGKILL")
      attached?.terminal?.close()
      await endCompanionSessions(env)
      await rm(directory, { recursive: true, force: true })
    }
  },
  60_000,
)

test.skipIf(!ENABLED)(
  "Sessions outlive the Runtime that started them and are adopted by the next one",
  async () => {
    await chmod(FAKE_APP, 0o755)
    const directory = await mkdtemp(join(tmpdir(), "smolmux-e2e-adopt-"))
    const env = environment(directory, "default")
    const socketPath = socketFor(env)
    let client: ApiClient | null = null

    try {
      await smolmux(["start"], env)
      client = await ApiClient.connect(socketPath)
      await client.request("session.create", {
        name: "survivor",
        argv: [FAKE_APP],
        cwd: ROOT,
        env: { SMOLMUX_TEST_BANNER: "still here" },
        labels: { role: "worker" },
      })
      await client.request("event.subscribe")
      const beforeSnapshot = await client.request("state.get")
      const before = beforeSnapshot.state!
      client.close()
      client = null

      // End the Runtime the way a crash would: its process, not its Sessions.
      process.kill(before.pid, "SIGKILL")
      await waitUntil(async () => !(await answers(socketPath)))

      // The next start finds the Session by the labels the Companion holds.
      const restarted = await smolmux(["start"], env)
      expect(restarted.code).toBe(0)
      client = await ApiClient.connect(socketPath)
      await client.request("event.subscribe")
      const afterSnapshot = await client.request("state.get")
      expect(afterSnapshot.instanceId).not.toBe(beforeSnapshot.instanceId)
      expect(afterSnapshot.generation).toBe(1)
      const status = afterSnapshot.state!
      expect(status.instance_id).toBe(before.instance_id)
      expect(status.pid).not.toBe(before.pid)
      const survivor = status.sessions.find((session: SessionView) => session.name === "survivor")
      expect(survivor).toMatchObject({ name: "survivor", state: "live", labels: { role: "worker" } })
      // Its argv is not recoverable from the Companion's display string.
      expect(survivor!.argv).toBeNull()
      // A Runtime with Sessions shows one rather than its empty state.
      expect((status.layout as LayoutView).root).toEqual({ session: "survivor" })

      await waitUntil(async () => {
        const capture = await client!.request("session.capture", { name: "survivor" })
        return capture.lines.join("").includes("still here")
      })

      await client.request("instance.stop")
      await waitUntil(async () => !(await answers(socketPath)))
    } finally {
      client?.close()
      await endCompanionSessions(env)
      await rm(directory, { recursive: true, force: true })
    }
  },
  60_000,
)

test.skipIf(!ENABLED)(
  "named Instances are independent and a second Runtime for one is refused",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "smolmux-e2e-named-"))
    const env = environment(directory, "review")
    const defaultSocket = socketFor(env)
    const namedSocket = socketFor(env, "review")
    let first: ApiClient | null = null
    let second: ApiClient | null = null

    try {
      expect((await smolmux(["start"], env)).stdout.trim()).toBe(defaultSocket)
      expect((await smolmux(["start", "--name", "review"], env)).stdout.trim()).toBe(namedSocket)
      expect(defaultSocket).not.toBe(namedSocket)

      first = await ApiClient.connect(defaultSocket)
      second = await ApiClient.connect(namedSocket)
      await first.request("session.create", { name: "only-here", argv: [FAKE_APP], cwd: ROOT })
      expect((await first.request("session.list")).sessions.map((session: SessionView) => session.name)).toEqual([
        "only-here",
      ])
      expect((await second.request("session.list")).sessions).toEqual([])
      expect((await second.request("instance.status")).name).toBe("review")

      // Starting a name that is already running joins it rather than racing.
      expect((await smolmux(["start", "--name", "review"], env)).code).toBe(0)
      expect((await second.request("instance.status")).name).toBe("review")

      await first.request("instance.stop")
      await second.request("instance.stop")
      await waitUntil(async () => !(await answers(defaultSocket)) && !(await answers(namedSocket)))
    } finally {
      first?.close()
      second?.close()
      await endCompanionSessions(env)
      await rm(directory, { recursive: true, force: true })
    }
  },
  60_000,
)

async function answers(path: string): Promise<boolean> {
  try {
    const client = await ApiClient.connect(path)
    client.close()
    return true
  } catch {
    return false
  }
}
