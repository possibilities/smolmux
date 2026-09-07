import * as THREE from "three"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"
import { CSS3DObject, CSS3DRenderer } from "three/addons/renderers/CSS3DRenderer.js"
import type { AppView, Capture, InstanceStatus, PaneGeometry } from "../../src/protocol.ts"
import type { Ghostty } from "ghostty-web"
import type { TerminalAppearance } from "./appearance.ts"
import { measureTerminalCells, TerminalView, type TerminalCells } from "./terminal-view.ts"
import { stageSurface } from "./stage-surface.ts"

type Card = {
  object: CSS3DObject
  body: THREE.Mesh<THREE.BoxGeometry, THREE.MeshPhongMaterial>
  edge: THREE.LineSegments
  tether: THREE.Line
  element: HTMLButtonElement
  content: TerminalView
  title: HTMLElement
  status: HTMLElement
  foot: HTMLElement
  target: THREE.Vector3
  rotation: number
  width: number
  height: number
  pulseUntil: number
  sessionId: string | null
}

export const toneOf = (app: AppView) =>
  ["paused", "pausing", "stopped", "stopping", "exited", "failed", "unreachable"].includes(app.state)
    ? "quiet"
    : !app.visible
      ? "hidden"
      : "shown"
export const positionOf = (app: AppView) => (!app.visible ? "Hidden" : app.shown ? "On Stage" : "Off Stage")

/** Ghostty terminal canvases occupy CSS 3D faces; WebGL supplies the Stage and depth. */
export class InstanceScene {
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.1, 250)
  private readonly webgl: THREE.WebGLRenderer | null
  private readonly css = new CSS3DRenderer()
  private readonly controls: OrbitControls
  private readonly cards = new Map<string, Card>()
  private readonly structure = new THREE.Group()
  private readonly stageObject = new CSS3DObject(document.createElement("div"))
  private readonly cells: TerminalCells
  private readonly labelObjects: CSS3DObject[] = []
  private readonly reduced = matchMedia("(prefers-reduced-motion: reduce)")
  private readonly resizeObserver: ResizeObserver
  private status: InstanceStatus | null = null
  private spatial = true
  private separation = 0.65
  private selected: string | null = null
  private frame = 0
  private lastDraw = 0
  private targetCamera = new THREE.Vector3(21, 13, 33)
  private targetLook = new THREE.Vector3(0, -1, 1)
  private flying = true
  private disposed = false
  private dark = false

  constructor(
    private readonly container: HTMLElement,
    private readonly select: (name: string) => void,
    private readonly engine: Ghostty,
    private readonly appearance: TerminalAppearance,
  ) {
    this.cells = measureTerminalCells(appearance)
    let renderer: THREE.WebGLRenderer | null = null
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" })
      renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75))
      renderer.setClearColor(0xe9f0f3, 0)
      container.append(renderer.domElement)
    } catch {
      /* CSS 3D retains all inspection/navigation when WebGL is unavailable. */
    }
    this.webgl = renderer
    this.css.domElement.style.position = "absolute"
    this.css.domElement.style.inset = "0"
    container.append(this.css.domElement)
    this.camera.position.copy(this.targetCamera)
    // OrbitControls captures the pointer on its root, so pointerup/click may
    // never return to the terminal face. Pick across that capture boundary.
    let pick: { name: string; x: number; y: number; pointer: number } | null = null
    const pointers = new Set<number>()
    this.css.domElement.addEventListener(
      "pointerdown",
      (event) => {
        pointers.add(event.pointerId)
        const face = (event.target as Element).closest<HTMLButtonElement>("[data-scene-app]")
        pick =
          pointers.size === 1 && event.button === 0 && face
            ? { name: face.dataset.sceneApp!, x: event.clientX, y: event.clientY, pointer: event.pointerId }
            : null
      },
      true,
    )
    this.css.domElement.addEventListener(
      "pointermove",
      (event) => {
        if (pick && Math.hypot(event.clientX - pick.x, event.clientY - pick.y) >= 7) pick = null
      },
      true,
    )
    this.css.domElement.addEventListener(
      "pointerup",
      (event) => {
        pointers.delete(event.pointerId)
        if (pick?.pointer === event.pointerId && Math.hypot(event.clientX - pick.x, event.clientY - pick.y) < 7)
          this.select(pick.name)
        pick = null
      },
      true,
    )
    this.css.domElement.addEventListener(
      "pointercancel",
      (event) => {
        pointers.delete(event.pointerId)
        pick = null
      },
      true,
    )
    this.controls = new OrbitControls(this.camera, this.css.domElement)
    this.controls.target.copy(this.targetLook)
    this.controls.enableDamping = !this.reduced.matches
    this.controls.dampingFactor = 0.09
    this.controls.minDistance = 7
    this.controls.maxDistance = 140
    this.controls.maxPolarAngle = Math.PI * 0.79
    this.controls.minPolarAngle = 0.28
    this.controls.addEventListener("start", () => {
      this.flying = false
    })
    this.scene.add(new THREE.AmbientLight(0xe1efff, 2.2))
    const light = new THREE.DirectionalLight(0xffffff, 3)
    light.position.set(10, 18, 25)
    // Add the Stage before App faces so coplanar CSS surfaces compose in paint order.
    this.scene.add(light, this.structure, this.stageObject)
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.animate(0)
  }

  get hasWebGL() {
    return this.webgl !== null
  }

  private resize() {
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    this.camera.aspect = width / Math.max(height, 1)
    this.camera.updateProjectionMatrix()
    this.webgl?.setSize(width, height)
    this.css.setSize(width, height)
    if (!this.spatial) this.resetCamera()
  }

  update(status: InstanceStatus | null) {
    const resized = status?.stage.cols !== this.status?.stage.cols || status?.stage.rows !== this.status?.stage.rows
    this.status = status
    for (const [name, card] of this.cards)
      if (!status?.apps.some((app) => app.name === name)) {
        this.removeCard(card)
        this.cards.delete(name)
      }
    for (const app of status?.apps ?? []) {
      const card = this.cards.get(app.name) ?? this.createCard(app)
      if (card.sessionId !== (app.session?.id ?? null)) {
        card.sessionId = app.session?.id ?? null
        card.content.setMessage(app.session ? "Waiting for terminal Capture…" : "No current Session")
      }
      card.element.dataset.tone = toneOf(app)
      card.title.textContent = app.name
      card.status.textContent = app.name === status?.layout.focus ? "Focus" : positionOf(app)
      card.foot.textContent = `${app.cols} × ${app.rows}  /  ${app.state}`
      card.body.material.color.set(toneOf(app) === "quiet" ? 0x7a817e : app.visible ? 0x527ca5 : 0x6c9d88)
      card.element.classList.toggle("selected", app.name === this.selected)
      if (!app.session)
        card.content.setMessage(app.error ?? (app.lastExit ? `Session ended\n${app.lastExit.reason}` : `No current Session\n${app.state}`))
    }
    this.positionCards()
    if (resized) this.resetCamera()
  }

  private createCard(app: AppView): Card {
    const element = document.createElement("button")
    element.type = "button"
    element.tabIndex = -1
    element.className = "terminal-face"
    element.dataset.sceneApp = app.name
    element.setAttribute("aria-label", `Inspect ${app.name}`)
    const head = document.createElement("div")
    head.className = "terminal-face-head"
    const dot = document.createElement("i")
    const title = document.createElement("strong")
    const status = document.createElement("span")
    head.append(dot, title, status)
    const screen = document.createElement("div")
    screen.className = "terminal-face-screen"
    const content = new TerminalView(screen, this.engine, this.appearance, this.cells)
    content.setMessage("Waiting for terminal Capture…")
    const foot = document.createElement("div")
    foot.className = "terminal-face-foot"
    element.append(head, screen, foot)
    element.addEventListener("click", (event) => {
      if (event.detail === 0) this.select(app.name) // keyboard/assistive activation
    })
    const object = new CSS3DObject(element)
    object.scale.setScalar(1 / 64)
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshPhongMaterial({ color: 0x527ca5, transparent: true, opacity: 0.58, shininess: 65 }),
    )
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0x779cb5, transparent: true, opacity: 0.65 }),
    )
    const tether = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({
        color: 0x8ba9b7,
        dashSize: 0.09,
        gapSize: 0.12,
        transparent: true,
        opacity: 0.45,
      }),
    )
    const card: Card = {
      object,
      body,
      edge,
      tether,
      element,
      content,
      title,
      status,
      foot,
      target: new THREE.Vector3(),
      rotation: 0,
      width: 1,
      height: 1,
      pulseUntil: 0,
      sessionId: null,
    }
    this.cards.set(app.name, card)
    this.scene.add(object, body, edge, tether)
    return card
  }

  capture(capture: Capture) {
    const card = this.cards.get(capture.name)
    if (!card) return
    card.content.update(capture)
  }

  activity(name: string) {
    const card = this.cards.get(name)
    if (card) {
      card.pulseUntil = performance.now() + 800
      card.element.classList.add("output-active")
    }
  }

  selectApp(name: string | null) {
    this.selected = name
    for (const [key, card] of this.cards) card.element.classList.toggle("selected", key === name)
  }

  setMode(spatial: boolean) {
    this.spatial = spatial
    this.container.dataset.mode = spatial ? "spatial" : "stage"
    this.controls.enableRotate = spatial
    this.controls.mouseButtons.LEFT = spatial ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN
    this.positionCards()
    this.resetCamera()
  }

  setSeparation(value: number) {
    this.separation = value
    this.positionCards()
  }

  setDark(dark: boolean) {
    this.dark = dark
    this.positionCards()
  }

  resetCamera() {
    const count = this.status?.apps.filter((app) => !app.shown).length ?? 0
    if (!this.spatial) {
      const { width, height } = this.stageSize()
      const top = height / 2 + 1.2
      const bottom = count ? -height / 2 - 6 - (Math.ceil(count / 5) - 1) * 4.7 : -height / 2 - 0.4
      const span = Math.max(width + 1, Math.min(5, count) * 6)
      const center = (top + bottom) / 2
      const halfFov = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))
      const distance = Math.max((top - bottom) / 2, span / (2 * this.camera.aspect)) / halfFov * 1.08
      // A perpendicular camera keeps every cell at the same projected scale.
      this.targetCamera.set(0, center, distance)
      this.targetLook.set(0, center, 0)
      this.flying = true
      return
    }
    const extra = Math.max(0, Math.ceil(count / 5) - 1) * 5
    const narrow = this.container.clientWidth / Math.max(this.container.clientHeight, 1) < 0.85
    this.targetCamera.set(19, 11, 34 + extra + (narrow ? 9 : 0))
    this.targetLook.set(0, -1.7 - extra / 2, 1.5)
    this.flying = true
  }

  private positionCards() {
    this.clearStructure()
    const state = this.status
    this.stageObject.visible = !!state
    if (!state) return
    const { width, height, scale } = this.stageSize()
    const hidden = state.apps.filter((app) => !app.shown)
    const shown = state.apps.filter((app) => app.shown)
    const spread = this.spatial ? this.separation : 0
    stageSurface(state, this.appearance, this.cells, this.stageObject.element)
    this.stageObject.scale.setScalar(scale)
    this.outline(-width / 2, -height / 2, width, height, -0.01, 0x7b9aad, 0.6)
    this.label(
      `<strong>Stage</strong>  ${state.stage.cols} × ${state.stage.rows}`,
      new THREE.Vector3(-width / 2, height / 2 + 1.1, 0),
    )
    if (hidden.length)
      this.label(`${hidden.length} beyond the Stage`,
        new THREE.Vector3(-Math.min(5, hidden.length) * 3 + 0.45, -height / 2 - 1.55, this.spatial ? 3 : 0), true)
    const floorY = -height / 2 - 6 - Math.max(0, Math.ceil(hidden.length / 5) - 1) * 4.5
    const grid = new THREE.GridHelper(70, 70, this.dark ? 0x617a91 : 0xa5bac6, this.dark ? 0x344f63 : 0xc3d2da)
    grid.position.set(0, floorY, -4)
    const materials = Array.isArray(grid.material) ? grid.material : [grid.material]
    materials.forEach((material) => {
      material.transparent = true
      material.opacity = 0.22
    })
    this.structure.add(grid)
    const ring = new THREE.EllipseCurve(0, 0, 14, 8, 0, Math.PI * 2, false, 0).getPoints(100)
    this.line(
      ring.map((point) => new THREE.Vector3(point.x, floorY + 0.02, point.y)),
      0x9cb6c4,
      0.32,
    )
    for (const app of state.apps) {
      const card = this.cards.get(app.name)!
      const pane = state.layout.panes.find((pane) => pane.app === app.name)
      const fitted = app.shown && pane && pane.cols > 0 && pane.rows > 0
      const composed = !!fitted && spread === 0
      card.element.dataset.composed = String(composed)
      card.element.dataset.fitted = String(!!fitted)
      card.body.visible = card.edge.visible = !composed
      let original: THREE.Vector3
      if (fitted) {
        const rect = this.paneRect(pane, width, height, state)
        original = new THREE.Vector3(rect.x, rect.y, 0)
        card.width = rect.width
        card.height = rect.height
        const index = shown.indexOf(app)
        card.target.set(
          rect.x * (1 + spread * 0.12),
          rect.y * (1 + spread * 0.18),
          spread * (1.7 + index * 1.65),
        )
        card.rotation = 0
        if (spread) this.outline(rect.x - rect.width / 2, rect.y - rect.height / 2, rect.width, rect.height, 0.01, 0x89a6b7, 0.4)
      } else {
        const index = hidden.indexOf(app)
        const row = Math.floor(index / 5)
        const n = Math.min(5, hidden.length - row * 5)
        const column = index % 5
        const angle = n === 1 ? 0 : (column / (n - 1) - 0.5) * 1.5
        card.width = 5.1
        card.height = 3.2
        card.target.set(
          (column - (n - 1) / 2) * 6,
          -height / 2 - 4 - row * 4.7,
          this.spatial ? 4 + Math.cos(angle) * 1.6 : 0,
        )
        card.rotation = this.spatial ? -angle * 0.2 : 0
        original = new THREE.Vector3(card.target.x, floorY, card.target.z)
      }
      const faceScale = fitted ? scale : 1 / 64
      card.object.scale.setScalar(faceScale)
      card.element.style.width = `${card.width / faceScale}px`
      card.element.style.height = `${card.height / faceScale}px`
      card.element.style.setProperty("--label-scale", String(1 / (64 * faceScale)))
      card.content.setFit(fitted ? "cells" : "contain")
      card.tether.geometry.dispose()
      card.tether.geometry = new THREE.BufferGeometry().setFromPoints([original, card.target])
      card.tether.computeLineDistances()
      card.tether.visible = spread > 0
      if (card.object.position.lengthSq() === 0 || this.reduced.matches) card.object.position.copy(card.target)
    }
  }

  private stageSize() {
    const stage = this.status?.stage ?? { cols: 80, rows: 24 }
    const pixelWidth = stage.cols * this.cells.width, pixelHeight = stage.rows * this.cells.height
    // Limit scene size with one uniform scale; never clamp width and height independently.
    const scale = Math.min(18 / pixelWidth, 14 / pixelHeight)
    return { width: pixelWidth * scale, height: pixelHeight * scale, scale }
  }

  private paneRect(pane: PaneGeometry, width: number, height: number, state: InstanceStatus) {
    return {
      x: ((pane.x + pane.cols / 2) / state.stage.cols - 0.5) * width,
      y: (0.5 - (pane.y + pane.rows / 2) / state.stage.rows) * height,
      width: (pane.cols / state.stage.cols) * width,
      height: (pane.rows / state.stage.rows) * height,
    }
  }

  private line(points: THREE.Vector3[], color: number, opacity: number) {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
    )
    this.structure.add(line)
  }

  private outline(x: number, y: number, width: number, height: number, z: number, color: number, opacity: number) {
    this.line(
      [
        [x, y],
        [x + width, y],
        [x + width, y + height],
        [x, y + height],
        [x, y],
      ].map(([a, b]) => new THREE.Vector3(a!, b!, z)),
      color,
      opacity,
    )
  }

  private label(text: string, position: THREE.Vector3, hidden = false) {
    const element = document.createElement("div")
    element.className = `scene-label${hidden ? " hidden-label" : ""}`
    element.innerHTML = text // Only local labels and numeric Stage dimensions reach this branch.
    const label = new CSS3DObject(element)
    label.position.copy(position)
    label.scale.setScalar(0.025)
    this.labelObjects.push(label)
    this.scene.add(label)
  }

  private clearStructure() {
    this.structure.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
        object.geometry.dispose()
        const materials = Array.isArray(object.material) ? object.material : [object.material]
        materials.forEach((material) => material.dispose())
      }
    })
    this.structure.clear()
    for (const label of this.labelObjects.splice(0)) {
      this.scene.remove(label)
      label.element.remove()
    }
  }

  private animate = (time: number) => {
    if (this.disposed) return
    this.frame = requestAnimationFrame(this.animate)
    if (document.hidden || time - this.lastDraw < 1000 / 40) return
    this.lastDraw = time
    if (this.flying) {
      const speed = this.reduced.matches ? 1 : 0.085
      this.camera.position.lerp(this.targetCamera, speed)
      this.controls.target.lerp(this.targetLook, speed)
      if (this.camera.position.distanceTo(this.targetCamera) < 0.02 && this.controls.target.distanceTo(this.targetLook) < 0.02) {
        this.camera.position.copy(this.targetCamera)
        this.controls.target.copy(this.targetLook)
        this.flying = false
      }
    }
    for (const card of this.cards.values()) {
      card.object.position.lerp(card.target, this.reduced.matches ? 1 : 0.13)
      card.object.rotation.y = THREE.MathUtils.lerp(
        card.object.rotation.y,
        card.rotation,
        this.reduced.matches ? 1 : 0.13,
      )
      card.body.position.copy(card.object.position)
      card.body.position.z -= 0.09
      card.body.rotation.copy(card.object.rotation)
      card.body.scale.set(card.width, card.height, 0.18)
      card.edge.position.copy(card.body.position)
      card.edge.rotation.copy(card.body.rotation)
      card.edge.scale.copy(card.body.scale)
      if (time > card.pulseUntil) card.element.classList.remove("output-active")
    }
    this.controls.update()
    this.webgl?.render(this.scene, this.camera)
    this.css.render(this.scene, this.camera)
  }

  private removeCard(card: Card) {
    card.content.dispose()
    this.scene.remove(card.object, card.body, card.edge, card.tether)
    card.element.remove()
    for (const object of [card.body, card.edge, card.tether]) {
      object.geometry.dispose()
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      materials.forEach((material) => material.dispose())
    }
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.frame)
    this.resizeObserver.disconnect()
    this.controls.dispose()
    for (const card of this.cards.values()) this.removeCard(card)
    this.clearStructure()
    this.stageObject.element.remove()
    this.webgl?.dispose()
    this.webgl?.domElement.remove()
    this.css.domElement.remove()
  }
}
