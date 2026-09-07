import "./styles.css"
import { fitLayout, paneGeometries } from "../../src/layout.ts"
import type { Capture, StateSnapshot } from "../../src/protocol.ts"
import { demoCapture, demoSnapshot } from "./demo.ts"
import { appLeaf, planNavigation } from "./navigation.ts"
import { InstanceScene, positionOf, toneOf } from "./scene.ts"
import type { BrowserMessage, Discovery, ExplorerMessage, Navigation } from "./wire.ts"
import { cssFont, defaultAppearance, isDark, type TerminalAppearance } from "./appearance.ts"
import { loadTerminalEngine, TerminalView } from "./terminal-view.ts"

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T
const text = (id: string, value: string) => {
  element(id).textContent = value
}
const show = (id: string, visible: boolean) => {
  element(id).hidden = !visible
}
const button = (id: string) => element<HTMLButtonElement>(id)
const dialog = element<HTMLDialogElement>("instance-dialog")
const token = location.hash.slice(1)
const [engine, appearance] = await Promise.all([
  loadTerminalEngine(),
  token ? fetch("/appearance", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
    .then(async response => response.ok ? await response.json() as TerminalAppearance : defaultAppearance)
    .catch(() => defaultAppearance) : defaultAppearance,
])
await Promise.all([
  document.fonts.load(`${appearance.fontSize * 96 / 72}px ${cssFont(appearance.fontFamily)}`), document.fonts.ready,
])
document.querySelector<HTMLAnchorElement>(".wordmark")!.href = location.href
let snapshot: StateSnapshot | null = null
let selection: string | null = null
let selectedInstance: string | null = null
let demo = false
let online = false
let socket: WebSocket | null = null
let connectionEpoch = 0
let retryTimer: ReturnType<typeof setTimeout> | undefined
let retryDelay = 1000
let discovery: Discovery = { instances: [], skipped: 0, warning: null }
let discovering = false
let filter = "all"
let captureHistory: Capture | null = null
let toastTimer: ReturnType<typeof setTimeout> | undefined
let nextId = 0
const captures = new Map<string, Capture>()
const activity = new Map<string, number[]>()
const requests = new Map<
  string,
  { resolve: (message: ExplorerMessage) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
>()
const scene = new InstanceScene(element("viewport"), selectApp, engine, appearance)
const captureView = new TerminalView(element("capture"), engine, appearance)
const terminalDialog = element<HTMLDialogElement>("terminal-dialog")
const expandedView = new TerminalView(element("expanded-capture"), engine, appearance)
const appearanceMode = element<HTMLSelectElement>("appearance-mode")
const systemTheme = matchMedia("(prefers-color-scheme: dark)")
try { appearanceMode.value = localStorage.getItem("smolmux-appearance") ?? "terminal" } catch { /* Storage can be disabled. */ }
if (!appearanceMode.value) appearanceMode.value = "terminal"
function applyAppearance() {
  const dark = appearanceMode.value === "dark" || (appearanceMode.value === "system" ? systemTheme.matches :
    appearanceMode.value === "terminal" && isDark(appearance.background))
  document.documentElement.dataset.theme = dark ? "dark" : "light"
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content = dark ? "#101820" : "#e9f0f3"
  scene.setDark(dark)
}
applyAppearance()
appearanceMode.addEventListener("change", () => {
  try { localStorage.setItem("smolmux-appearance", appearanceMode.value) } catch { /* Optional preference. */ }
  applyAppearance()
})
systemTheme.addEventListener("change", applyAppearance)
const appearanceDescription = `${appearance.fontFamily} · ${appearance.fontSize} pt · ${appearance.theme}`
text("appearance-note", `${appearance.fontFamily} · ${appearance.fontSize} pt`)
element("appearance-note").title = appearance.warning ?? appearanceDescription
text("terminal-appearance", appearanceDescription)

function toast(message: string, error = false) {
  text("toast", message)
  element("toast").classList.toggle("error", error)
  show("toast", true)
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => show("toast", false), error ? 9000 : 4500)
}

function connection(label: string, state: "live" | "demo" | "offline") {
  text("connection-text", label)
  element("connection-dot").className = `connection-dot ${state}`
}

function selectApp(name: string) {
  selection = name
  captureHistory = null
  scene.selectApp(name)
  renderRoster()
  renderInspector()
}

function applySnapshot(next: StateSnapshot | null) {
  const prior = snapshot
  snapshot = next
  const state = snapshot?.state
  if (!state || !state.apps.some(app => app.name === selection)) {
    terminalDialog.close()
    captureView.setMessage("Choose an App to inspect its terminal.")
    expandedView.setMessage("Choose an App to inspect its terminal.")
  }
  for (const [name, capture] of captures)
    if (!state?.apps.some((app) => app.name === name && app.session?.id === capture.sessionId)) captures.delete(name)
  for (const name of activity.keys()) {
    const before = prior?.state?.apps.find((app) => app.name === name)
    const after = state?.apps.find((app) => app.name === name)
    if (!after || before?.session?.id !== after.session?.id) activity.delete(name)
  }
  if (
    captureHistory &&
    !state?.apps.some((app) => app.name === captureHistory!.name && app.session?.id === captureHistory!.sessionId)
  )
    captureHistory = null
  if (state && !state.apps.some((app) => app.name === selection))
    selection = state.layout.focus ?? state.apps[0]?.name ?? null
  scene.selectApp(selection)
  scene.update(state ?? null)
  for (const capture of captures.values()) scene.capture(capture)
  text("instance-name", state ? state.name : selectedInstance ? "Reconnecting…" : "Choose an Instance")
  text("app-count", String(state?.apps.length ?? 0))
  text("scene-title", state ? state.name : "A place for every App.")
  text("scene-kicker", demo ? "A sample Instance, unfolded" : "Live Instance anatomy")
  const shown = state?.apps.filter((app) => app.shown).length ?? 0
  const hidden = state?.apps.filter((app) => !app.visible).length ?? 0
  const offstage = state?.apps.filter((app) => app.visible && !app.shown).length ?? 0
  text(
    "scene-summary",
    state
      ? `${shown} on Stage · ${hidden} hidden${offstage ? ` · ${offstage} off Stage` : ""}. Every App has a place here.`
      : "Choose an Instance to unfold its terminals.",
  )
  text(
    "status-summary",
    state
      ? `${state.apps.length} Apps  /  ${state.apps.filter((app) => app.session).length} Sessions${demo ? "  /  Demo data" : "  /  Live observation"}${!scene.hasWebGL ? "  /  CSS 3D mode" : ""}`
      : "Waiting for an Instance",
  )
  text(
    "revision",
    state
      ? `Stage ${state.stage.cols} × ${state.stage.rows}  /  Revision ${state.layout.revision}`
      : "Local to this computer",
  )
  show("scene-empty", !!state && !state.apps.length)
  show("demo-banner", demo)
  if (snapshot?.availability !== "ready" && snapshot) {
    connection("Unavailable", "offline")
    text("scene-summary", snapshot.reason ?? "The Instance is temporarily unavailable.")
  } else if (state && online) connection(demo ? "Demo" : "Live", demo ? "demo" : "live")
  renderRoster()
  renderInspector()
}

function renderRoster() {
  const query = element<HTMLInputElement>("app-search").value.toLowerCase()
  const apps = (snapshot?.state?.apps ?? []).filter(
    (app) =>
      `${app.name} ${app.title} ${app.cwd} ${app.state}`.toLowerCase().includes(query) &&
      (filter === "all" || (filter === "hidden" ? !app.visible : app.shown)),
  )
  const list = element("app-list")
  const active = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.app : undefined
  list.replaceChildren()
  for (const app of apps) {
    const row = document.createElement("button")
    row.className = "app-row"
    row.dataset.app = app.name
    row.dataset.tone = toneOf(app)
    row.setAttribute("aria-pressed", String(app.name === selection))
    const glyph = document.createElement("span")
    glyph.className = "app-glyph"
    glyph.textContent = app.session ? (app.state === "paused" ? "Ⅱ" : "›_") : "◇"
    glyph.setAttribute("aria-hidden", "true")
    const body = document.createElement("span")
    body.className = "app-row-body"
    const name = document.createElement("span")
    name.className = "app-row-name"
    name.textContent = app.name
    const state = document.createElement("span")
    state.className = "app-row-state"
    state.textContent = `${positionOf(app)} / ${app.state}`
    body.append(name, state)
    row.append(glyph, body)
    if (app.name === snapshot?.state?.layout.focus) {
      const focus = document.createElement("span")
      focus.className = "focus-mark"
      focus.textContent = "⌖"
      focus.title = "Terminal Focus"
      row.append(focus)
    }
    row.addEventListener("click", () => selectApp(app.name))
    list.append(row)
    if (active === app.name) row.focus({ preventScroll: true })
  }
  if (!apps.length) {
    const empty = document.createElement("p")
    empty.className = "empty-list"
    empty.textContent = query || filter !== "all" ? "No Apps match this view." : "Declared Apps will appear here."
    list.append(empty)
  }
}

function currentApp() {
  return snapshot?.state?.apps.find((app) => app.name === selection)
}

function renderInspector() {
  const app = currentApp()
  show("inspector-empty", !app)
  show("inspector-content", !!app)
  if (!app) {
    text("selected-position", "")
    return
  }
  text("selected-position", positionOf(app))
  text("selected-name", app.name)
  text("selected-state", app.state)
  element("selected-state").dataset.tone = toneOf(app)
  text("selected-title", app.title || "No terminal title")
  const details = element("app-details")
  details.replaceChildren()
  const properties = [
    ["Position", `${positionOf(app)}${snapshot?.state?.layout.focus === app.name ? "; terminal Focus" : ""}`],
    ["Directory", app.cwd],
    ["Command", app.argv ? app.argv.join(" ") : "Not retained after Adoption"],
    ["PTY owner", app.pty === "local" ? "Runtime (local)" : "Companion"],
    [
      "When hidden",
      app.whenHidden === "keep"
        ? "Keep running"
        : app.whenHidden === "pause"
          ? "Pause the Session"
          : "Stop the Session",
    ],
    [
      "Session",
      app.session
        ? `${app.session.id.slice(0, 8)}${app.session.pid === null ? "" : ` / PID ${app.session.pid}`}`
        : "None",
    ],
  ]
  for (const [key, value] of properties) {
    const dt = document.createElement("dt")
    dt.textContent = key!
    const dd = document.createElement("dd")
    dd.textContent = value!
    if (key === "Command" || key === "Session") dd.className = "mono"
    details.append(dt, dd)
  }
  show("app-error", !!app.error || !!app.lastExit)
  text(
    "app-error",
    app.error ??
      (app.lastExit
        ? `${app.lastExit.reason}. Cause: ${app.lastExit.cause}. Exit code: ${app.lastExit.code ?? "unknown"}.`
        : ""),
  )
  const leaf = appLeaf(snapshot!.state!.layout.root, app.name)
  const focused = snapshot!.state!.layout.focus === app.name
  const canFocus = app.shown && leaf?.focusMode !== "never" && !focused
  const canReveal = !leaf
  const action = button("navigate-button")
  action.textContent = !leaf ? "Reveal beside the Layout" : focused ? "Has terminal Focus" : "Focus on Stage"
  action.disabled = !online || snapshot?.availability !== "ready" || !(canFocus || canReveal)
  text(
    "navigate-hint",
    leaf?.focusMode === "never"
      ? "This Pane refuses Focus by its declaration. Its Capture is still available."
      : !leaf
        ? `Adds this App beside the current Layout.${app.whenHidden === "pause" ? " Its Session resumes when visible." : app.whenHidden === "stop" ? " Its command may start a fresh Session when visible." : " Other Apps stay visible."}`
        : !app.shown
          ? "This App is logically visible but has no fitted cells. Enlarge the terminal to bring its Pane back."
          : focused
            ? "Keyboard input in the terminal goes to this App. Selecting here only changes the inspector."
            : "Moves keyboard Focus in the terminal. The Layout and visible Apps are preserved.",
  )
  renderCapture()
  renderActivity()
}

function renderCapture() {
  const app = currentApp()
  if (!app) return
  const capture = captureHistory?.name === app.name ? captureHistory : captures.get(app.name)
  if (capture) {
    captureView.setFit("width")
    captureView.update(capture, !!captureHistory)
    if (terminalDialog.open) expandedView.update(capture, !!captureHistory)
  } else {
    const message = app.session
        ? "Waiting for terminal Capture…"
        : `No current Session.\n\n${app.lastExit?.reason ?? (app.state === "stopped" ? "This App is stopped. Its declaration remains available." : (app.error ?? "Its terminal will appear when execution starts."))}`
    captureView.setMessage(message)
    expandedView.setMessage(message)
  }
  button("expand-capture").disabled = !capture
  text("terminal-dialog-title", `${app.name} / ${captureHistory ? "Recent history" : "Terminal Capture"}`)
  text(
    "capture-state",
    captureHistory
      ? "History (held)"
      : capture
        ? capture.state === "unreachable"
          ? "Last known screen"
          : capture.state === "paused"
            ? "Paused screen"
            : "Live screen"
        : app.session
          ? "Waiting"
          : "No Session",
  )
  text(
    "capture-size",
    capture
      ? `${capture.cols} × ${capture.rows}${captureHistory ? ` / ${capture.screen_start} history lines` : ""}`
      : `${app.cols} × ${app.rows}`,
  )
  button("history-button").disabled = !app.session || !online
  show("history-button", !captureHistory)
  show("live-button", !!captureHistory)
}

function recordActivity(name: string, at: number) {
  const recent = (activity.get(name) ?? []).filter((time) => at - time < 30000)
  recent.push(at)
  activity.set(name, recent.slice(-600))
  scene.activity(name)
  if (name === selection) renderActivity()
}

function renderActivity() {
  const now = Date.now()
  const recent = (activity.get(selection ?? "") ?? []).filter((time) => now - time < 30000)
  const bars = Array.from(
    { length: 30 },
    (_, index) => recent.filter((time) => Math.floor((now - time) / 1000) === 29 - index).length,
  )
  const scale = Math.max(3, ...bars)
  const container = element("activity-bars")
  container.replaceChildren(
    ...bars.map((value) => {
      const bar = document.createElement("span")
      bar.style.height = `${Math.max(2, (value / scale) * 34)}px`
      return bar
    }),
  )
  text("activity-count", `${recent.length} events / 30s`)
  for (const row of document.querySelectorAll<HTMLElement>(".app-row"))
    row.classList.toggle("recent", (activity.get(row.dataset.app!)?.at(-1) ?? 0) > now - 1600)
}

function failRequests(message: string) {
  for (const pending of requests.values()) {
    clearTimeout(pending.timer)
    pending.reject(new Error(message))
  }
  requests.clear()
}

function disconnect() {
  connectionEpoch++
  clearTimeout(retryTimer)
  socket?.close()
  socket = null
  failRequests("The connection changed. Actions are never replayed; inspect the Instance before trying again.")
  online = false
  captures.clear()
  activity.clear()
  captureHistory = null
}

function connectInstance(id: string, retry = false) {
  disconnect()
  demo = false
  selectedInstance = id
  const epoch = connectionEpoch
  applySnapshot(null)
  connection(retry ? "Reconnecting" : "Connecting", "offline")
  const ws = new WebSocket(
    `${location.origin.replace("http:", "ws:")}/live?instance=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`,
  )
  socket = ws
  ws.addEventListener("message", (event) => {
    if (epoch !== connectionEpoch) return
    try {
      const message = JSON.parse(event.data) as ExplorerMessage
      if ("id" in message && message.id) {
        const pending = requests.get(message.id)
        if (pending) {
          clearTimeout(pending.timer)
          requests.delete(message.id)
          if (message.type === "error") pending.reject(new Error(message.message))
          else pending.resolve(message)
        }
        return
      }
      if (message.type === "state") {
        online = !!message.snapshot?.state && message.snapshot.availability === "ready"
        if (online) retryDelay = 1000
        const first = !snapshot?.state
        applySnapshot(message.snapshot)
        if (first) scene.resetCamera()
      } else if (message.type === "capture") {
        const { capture } = message
        if (!snapshot?.state?.apps.some((app) => app.name === capture.name && app.session?.id === capture.sessionId))
          return
        captures.set(capture.name, capture)
        scene.capture(capture)
        if (selection === capture.name && !captureHistory) renderCapture()
      } else if (message.type === "activity") {
        if (snapshot?.state?.apps.some((app) => app.name === message.name && app.session?.id === message.sessionId))
          recordActivity(message.name, message.at)
      } else if (message.type === "error") toast(message.message, true)
    } catch (error) {
      toast(error instanceof Error ? error.message : "The explorer received an invalid update.", true)
    }
  })
  ws.addEventListener("close", () => {
    if (epoch !== connectionEpoch) return
    online = false
    captures.clear()
    failRequests("The Instance disconnected. Check its current Layout before trying again.")
    applySnapshot(null)
    connection("Reconnecting", "offline")
    retryTimer = setTimeout(() => connectInstance(id, true), retryDelay)
    retryDelay = Math.min(8000, retryDelay * 1.6)
  })
  dialog.close()
}

function request(message: BrowserMessage): Promise<ExplorerMessage> {
  if (!socket || socket.readyState !== WebSocket.OPEN || !online)
    return Promise.reject(new Error("The Instance is not connected."))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      requests.delete(message.id)
      reject(
        new Error("No acknowledgment received. The action may have happened; inspect the Instance before retrying."),
      )
    }, 11000)
    requests.set(message.id, { resolve, reject, timer })
    socket!.send(JSON.stringify(message))
  })
}

function useDemo() {
  disconnect()
  demo = true
  online = true
  selectedInstance = null
  selection = null
  const next = demoSnapshot()
  applySnapshot(next)
  for (const app of next.state!.apps) {
    const capture = demoCapture(app)
    if (capture) {
      captures.set(app.name, capture)
      scene.capture(capture)
    }
  }
  renderCapture()
  connection("Demo", "demo")
  scene.resetCamera()
  dialog.close()
}

async function navigate() {
  const app = currentApp()
  if (!app || !snapshot?.state) return
  const action = appLeaf(snapshot.state.layout.root, app.name) ? "focus" : "reveal"
  const message: Navigation = {
    type: "navigate",
    id: String(++nextId),
    action,
    name: app.name,
    instanceId: snapshot.instanceId,
    revision: snapshot.state.layout.revision,
  }
  button("navigate-button").disabled = true
  try {
    if (demo) {
      const params = planNavigation(snapshot, message)
      const state = snapshot.state
      state.layout = {
        ...state.layout,
        root: params.root,
        visible: params.visible,
        focus: params.focus ?? null,
        revision: state.layout.revision + 1,
        panes: paneGeometries(fitLayout(params.root, state.stage), params.focus ?? null),
      }
      for (const candidate of state.apps) {
        candidate.visible = params.visible.includes(candidate.name)
        const pane = state.layout.panes.find((pane) => pane.app === candidate.name)
        candidate.shown = !!pane && pane.cols > 0 && pane.rows > 0
        if (candidate.shown && pane) {
          candidate.cols = pane.cols
          candidate.rows = pane.rows
        }
        if (candidate.visible && candidate.state === "paused") {
          candidate.state = "running"
          if (candidate.session) candidate.session.state = "live"
        }
      }
      applySnapshot(structuredClone(snapshot))
      for (const candidate of state.apps) {
        const capture = demoCapture(candidate)
        if (capture) {
          captures.set(candidate.name, capture)
          scene.capture(capture)
        }
      }
      renderCapture()
    } else await request(message)
    toast(`${demo ? "Demo: " : ""}${action === "reveal" ? "Revealed" : "Focused"} ${app.name} on Stage.`)
  } catch (error) {
    toast((error as Error).message, true)
  } finally {
    renderInspector()
  }
}

async function history() {
  const app = currentApp()
  if (!app?.session) return
  button("history-button").disabled = true
  try {
    const message = demo
      ? { type: "history" as const, id: "demo", capture: captures.get(app.name)! }
      : await request({ type: "history", id: String(++nextId), name: app.name, sessionId: app.session.id })
    if (message.type === "history" && currentApp()?.session?.id === message.capture.sessionId) {
      captureHistory = structuredClone(message.capture)
      renderCapture()
      const capture = element("capture")
      capture.scrollTop = capture.scrollHeight
    }
  } catch (error) {
    toast((error as Error).message, true)
  } finally {
    button("history-button").disabled = !currentApp()?.session || !online
  }
}

function renderInstances() {
  const list = element("instance-list")
  const query = element<HTMLInputElement>("instance-search").value.toLowerCase()
  list.replaceChildren()
  for (const instance of discovery.instances.filter((instance) => `${instance.name} ${instance.id}`.includes(query))) {
    const option = document.createElement("button")
    option.className = "instance-option"
    const glyph = document.createElement("span")
    glyph.textContent = "◈"
    glyph.setAttribute("aria-hidden", "true")
    const body = document.createElement("span")
    const name = document.createElement("strong")
    name.textContent = instance.name
    const detail = document.createElement("small")
    detail.textContent = `${instance.host} / ${instance.id} / ${instance.hidden} hidden`
    body.append(name, detail)
    const count = document.createElement("span")
    count.textContent = `${instance.apps} Apps`
    option.append(glyph, body, count)
    option.addEventListener("click", () => connectInstance(instance.id))
    list.append(option)
  }
  text(
    "discovery-note",
    discovery.warning ??
      (discovery.instances.length
        ? `${discovery.instances.length} running ${discovery.instances.length === 1 ? "Instance" : "Instances"} on this computer. Discovery refreshes automatically.`
        : token
          ? "No running Instances found. Start your smolmux application, or run smolmux start in a terminal. You can explore the demo in the meantime."
          : "Open the full local URL printed by bun run explorer to connect to your Instances. The demo is available here."),
  )
}

async function discover(initial = false) {
  if (discovering) return
  if (!token) {
    renderInstances()
    if (initial) useDemo()
    return
  }
  discovering = true
  button("refresh-instances").disabled = true
  try {
    const response = await fetch("/instances", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "Reopen the full local URL printed by bun run explorer."
          : "Could not discover Instances. Check the local explorer process.",
      )
    discovery = (await response.json()) as Discovery
    renderInstances()
    if (initial) {
      if (discovery.instances.length === 1) connectInstance(discovery.instances[0]!.id)
      else {
        useDemo()
        if (discovery.instances.length > 1) dialog.showModal()
      }
    }
  } catch (error) {
    discovery.warning = (error as Error).message
    renderInstances()
    if (initial) useDemo()
  } finally {
    discovering = false
    button("refresh-instances").disabled = false
  }
}

button("instance-switch").addEventListener("click", () => {
  renderInstances()
  dialog.showModal()
  void discover().catch((error) => toast(String(error), true))
})
button("close-dialog").addEventListener("click", () => dialog.close())
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) {
    const box = dialog.getBoundingClientRect()
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)
      dialog.close()
  }
})
button("demo-button").addEventListener("click", useDemo)
button("dialog-demo").addEventListener("click", useDemo)
button("refresh-instances").addEventListener("click", () => {
  void discover().catch((error) => toast(String(error), true))
})
element("instance-search").addEventListener("input", renderInstances)
element("app-search").addEventListener("input", renderRoster)
element("filters").addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-filter]")
  if (!target) return
  filter = target.dataset.filter!
  for (const item of element("filters").querySelectorAll("button"))
    item.setAttribute("aria-pressed", String(item === target))
  renderRoster()
})
button("spatial-view").addEventListener("click", () => setMode(true))
button("stage-view").addEventListener("click", () => setMode(false))
function setMode(spatial: boolean) {
  button("spatial-view").setAttribute("aria-pressed", String(spatial))
  button("stage-view").setAttribute("aria-pressed", String(!spatial))
  element<HTMLInputElement>("spread").disabled = !spatial
  element("viewport").parentElement!.querySelector(".gesture-hint")!.textContent =
    spatial ? "Drag to orbit · Scroll to zoom" : "Drag to pan · Scroll to zoom"
  element("viewport").setAttribute("aria-label",
    `${spatial ? "3D scene. Drag to orbit" : "Composed Stage. Drag to pan"}, scroll to zoom. Use the App list to select with the keyboard.`)
  scene.setMode(spatial)
}
element("spread").addEventListener("input", (event) =>
  scene.setSeparation(Number((event.target as HTMLInputElement).value) / 100),
)
button("reset-view").addEventListener("click", () => scene.resetCamera())
button("navigate-button").addEventListener("click", () => {
  void navigate().catch((error) => toast(String(error), true))
})
button("history-button").addEventListener("click", () => {
  void history().catch((error) => toast(String(error), true))
})
button("live-button").addEventListener("click", () => {
  captureHistory = null
  renderCapture()
})
button("expand-capture").addEventListener("click", () => {
  terminalDialog.showModal()
  renderCapture()
  expandedView.fit()
})
button("close-terminal").addEventListener("click", () => terminalDialog.close())
button("terminal-fit").addEventListener("click", () => {
  expandedView.setFit("contain")
  button("terminal-fit").setAttribute("aria-pressed", "true")
  button("terminal-native").setAttribute("aria-pressed", "false")
})
button("terminal-native").addEventListener("click", () => {
  expandedView.setFit("native")
  button("terminal-fit").setAttribute("aria-pressed", "false")
  button("terminal-native").setAttribute("aria-pressed", "true")
})
button("copy-capture").addEventListener("click", () => {
  const app = currentApp()
  const capture = captureHistory ?? (app ? captures.get(app.name) : null)
  if (capture) void navigator.clipboard.writeText(capture.lines.join("\n"))
    .then(() => toast("Terminal text copied."))
    .catch(() => toast("The browser could not copy terminal text.", true))
})
const discoveryTimer = setInterval(() => {
  if (!document.hidden) void discover().catch((error) => toast(String(error), true))
}, 5000)
const activityTimer = setInterval(() => {
  if (!document.hidden) renderActivity()
}, 1000)
let demoTick = 0
const demoTimer = setInterval(() => {
  if (!demo || document.hidden) return
  const app = snapshot?.state?.apps.find((app) => app.name === "api")
  if (!app) return
  recordActivity(app.name, Date.now())
  const capture = captures.get(app.name)
  if (capture) {
    capture.lines = [
      ...capture.lines.slice(0, 5),
      ...capture.lines.slice(5).slice(-6),
      `  GET /health                 200  #${++demoTick}`,
    ]
    scene.capture(capture)
    if (selection === app.name && !captureHistory) renderCapture()
  }
}, 3400)
window.addEventListener("pagehide", () => {
  disconnect()
  clearInterval(discoveryTimer)
  clearInterval(activityTimer)
  clearInterval(demoTimer)
  scene.dispose()
  captureView.dispose()
  expandedView.dispose()
  systemTheme.removeEventListener("change", applyAppearance)
})
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload()
})
void discover(true).catch((error) => toast(String(error), true))
