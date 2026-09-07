import { fitLayout, paneGeometries } from "../../src/layout.ts"
import type { AppView, Capture, StateSnapshot } from "../../src/protocol.ts"

const ids = Array.from({ length: 6 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`)
export function demoSnapshot(): StateSnapshot {
  const names = ["editor", "preview", "tests", "api", "traces", "build"]
  const apps: AppView[] = names.map((name, index) => ({
    name,
    pty: index === 3 ? "companion" : "local",
    whenHidden: index === 4 ? "pause" : "keep",
    cwd: `/projects/observatory${index === 3 ? "/service" : ""}`,
    argv: [
      ["nvim", "scene.ts"],
      ["bun", "dev"],
      ["bun", "test", "--watch"],
      ["bun", "serve.ts"],
      ["tail", "-f", "trace.log"],
      ["bun", "run", "build"],
    ][index]!,
    created_at: Date.now() - 3600000,
    title: [
      "scene.ts — observatory",
      "Preview on localhost:5173",
      "Watching for changes",
      "Listening on :8080",
      "trace.log",
      "Build complete",
    ][index]!,
    cols: 96,
    rows: 28,
    visible: index < 3,
    shown: index < 3,
    state: index === 4 ? "paused" : index === 5 ? "exited" : "running",
    session:
      index === 5
        ? null
        : {
            id: ids[index]!,
            pid: 24100 + index,
            created_at: Date.now() - 3600000,
            state: index === 4 ? "paused" : "live",
          },
    lastExit:
      index === 5
        ? { code: 0, signal: null, reason: "Process exited", sessionId: ids[index]!, cause: "natural" }
        : null,
    error: null,
    labels: {},
  }))
  const stage = { cols: 180, rows: 50 }
  const root = { row: [{ app: "editor" }, { column: [{ app: "preview" }, { app: "tests" }] }] }
  const panes = paneGeometries(fitLayout(root, stage), "editor")
  for (const pane of panes) {
    const app = apps.find((candidate) => candidate.name === pane.app)!
    app.cols = pane.cols
    app.rows = pane.rows
  }
  return {
    instanceId: "demo-runtime",
    generation: 1,
    sequence: 0,
    availability: "ready",
    reason: null,
    state: {
      version: "demo",
      pid: 24000,
      name: "observatory",
      instance_id: "demo",
      socket: "",
      stage,
      theme: "dark",
      apps,
      host: "foreground",
      capabilities: { local: true, companion: true },
      layout: { root, visible: ["editor", "preview", "tests"], focus: "editor", revision: 1, stage, panes },
    },
  }
}

const screens: Record<string, string[]> = {
  editor: [
    "  scene.ts",
    "",
    "  import { PerspectiveCamera } from 'three'",
    "",
    "  // A little room to see the whole system.",
    "  export function unfold(instance) {",
    "    const stage = instance.layout",
    "    const apps = instance.apps",
    "",
    "    for (const app of apps) {",
    "      const terminal = capture(app)",
    "      const position = locate(app, stage)",
    "",
    "      scene.add({",
    "        terminal,",
    "        position,",
    "        visible: app.visible,",
    "      })",
    "    }",
    "  }",
    "",
    "  // Hidden is a position, not an absence.",
    "",
    "  NORMAL                         scene.ts",
  ],
  preview: [
    "$ bun dev",
    "",
    "  Preview ready",
    "",
    "  Local   http://localhost:5173",
    "",
    "  Watching scene.ts and styles.css",
    "",
    "  ✓ connected to development preview",
  ],
  tests: [
    "$ bun test --watch",
    "",
    "  ✓ discovers live Instances",
    "  ✓ captures hidden Apps",
    "  ✓ keeps a paused Session's history",
    "  ✓ refuses stale Layout writes",
    "",
    "  4 pass   0 fail",
    "",
    "  Waiting for file changes…",
  ],
  api: [
    "$ bun serve.ts",
    "",
    "  Listening on 127.0.0.1:8080",
    "",
    "  GET /health                 200",
    "  GET /assets/scene.js        200",
    "  GET /health                 200",
    "",
    "  Connections remain open while hidden.",
  ],
  traces: [
    "$ tail -f trace.log",
    "",
    "  capture editor 90 × 50",
    "  layout applied, revision 1",
    "  output received from preview",
    "  traces hidden → paused",
    "",
    "  Session retained. Resumes when revealed.",
  ],
}
export function demoCapture(app: AppView): Capture | null {
  if (!app.session) return null
  return {
    name: app.name,
    sessionId: app.session.id,
    lines: [...(screens[app.name] ?? [])],
    screen_start: 0,
    cols: app.cols,
    rows: app.rows,
    title: app.title,
    state: app.state === "paused" ? "paused" : "running",
    cursor: { x: 2, y: 5, visible: false },
  }
}
