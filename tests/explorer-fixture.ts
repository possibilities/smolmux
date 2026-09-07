import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { ApiServer } from "../src/api-server.ts"
import { fitLayout, paneGeometries } from "../src/layout.ts"
import { ensurePrivateDirectories } from "../src/private-directory.ts"
import { ApiFailure, eventFrame, type Capture, type EventData, type EventName, type Params } from "../src/protocol.ts"
import { demoCapture, demoSnapshot } from "../examples/explorer/demo.ts"
import { socketDirectory } from "../examples/explorer/discovery.ts"

/** A socket-level contract fixture. It starts no PTYs or Companion processes. */
export async function explorerFixture() {
  await ensurePrivateDirectories([socketDirectory], "smolmux")
  const directory = await mkdtemp(join(socketDirectory, "explorer-test-"))
  const id = "0abc00000001"
  const path = join(directory, `${id}.api`)
  const snapshot = demoSnapshot()
  snapshot.instanceId = crypto.randomUUID()
  snapshot.state!.instance_id = id
  snapshot.state!.name = "explorer-check"
  snapshot.state!.socket = path
  const calls: { method: string; params: unknown }[] = []
  let holdCapture: ((capture: Capture) => Promise<Capture>) | null = null
  const server = new ApiServer(path, async (method, params) => {
    calls.push({ method, params })
    if (method === "state.get") return structuredClone(snapshot)
    if (method === "instance.status") return structuredClone(snapshot.state)
    if (method === "app.capture") {
      const target = params as Params<"app.capture">
      const app = snapshot.state!.apps.find((app) => app.name === target.name)
      if (!app) throw new ApiFailure("not_found", "No such App")
      if (target.sessionId && target.sessionId !== app.session?.id) throw new ApiFailure("conflict", "Session changed")
      const capture = demoCapture(app)
      if (!capture) throw new ApiFailure("not_running", "No current Session")
      if (target.scrollback) {
        capture.lines.unshift("A line from earlier in this Session.")
        capture.screen_start = 1
      }
      return holdCapture ? holdCapture(capture) : capture
    }
    if (method === "layout.apply") {
      const next = params as Params<"layout.apply">
      const state = snapshot.state!
      if (next.revision !== state.layout.revision) throw new ApiFailure("conflict", "Layout changed")
      state.layout = {
        ...state.layout,
        root: next.root,
        visible: next.visible,
        focus: next.focus ?? null,
        revision: state.layout.revision + 1,
        panes: paneGeometries(fitLayout(next.root, state.stage), next.focus ?? null),
      }
      for (const app of state.apps) {
        app.visible = next.visible.includes(app.name)
        const pane = state.layout.panes.find((pane) => pane.app === app.name)
        app.shown = !!pane && pane.cols > 0 && pane.rows > 0
        if (pane && app.shown) {
          app.cols = pane.cols
          app.rows = pane.rows
        }
        if (app.visible && app.state === "paused") {
          app.state = "running"
          app.session!.state = "live"
        }
      }
      publish("layout.changed", { layout: state.layout, apps: state.apps, cause: "apply" })
      return state.layout
    }
    throw new ApiFailure("unknown_method", "Fixture does not implement this method")
  })
  function publish<E extends EventName>(event: E, data: EventData<E>) {
    snapshot.sequence++
    server.broadcast(
      eventFrame(event, { ...data, instanceId: snapshot.instanceId, generation: 1, sequence: snapshot.sequence }),
    )
  }
  await server.start()
  return {
    directory,
    id,
    path,
    snapshot,
    calls,
    server,
    publish,
    holdCaptures: (callback: ((capture: Capture) => Promise<Capture>) | null) => {
      holdCapture = callback
    },
    async close() {
      server.stop()
      await rm(directory, { recursive: true, force: true })
    },
  }
}
