import { chromium, expect } from "@playwright/test"
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { explorerFixture } from "../../tests/explorer-fixture.ts"
import { buildExplorer } from "./build.ts"
import { startBridge } from "./bridge.ts"
import { socketDirectory } from "./discovery.ts"
import { loadGhosttyAppearance } from "./ghostty-config.ts"
import type { Capture } from "../../src/protocol.ts"

// A dedicated browser with an ephemeral profile. It never touches an operator's tab.
const fixture = await explorerFixture()
const bridge = startBridge({
  port: 0,
  directory: fixture.directory,
  assets: await buildExplorer(),
  appearance: await loadGhosttyAppearance(),
  html: await Bun.file(new URL("index.html", import.meta.url)).text(),
})
const evidence = await mkdtemp(join(socketDirectory, "explorer-browser-"))
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
      (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined),
  })
  const page = await browser.newPage({ viewport: { width: 1512, height: 982 }, deviceScaleFactor: 1 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  await page.goto(bridge.url)
  await expect(page.locator("#connection-text")).toHaveText("Live")
  await expect(page.locator(".app-row")).toHaveCount(6)
  await expect(page.locator(".terminal-face")).toHaveCount(6)
  await expect(page.locator("#capture")).toContainText("PerspectiveCamera")
  await page.evaluate(() => document.fonts.ready)
  await page.locator("#appearance-mode").selectOption("dark")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await page.screenshot({ path: join(evidence, "desktop.png") })
  await page.locator("#appearance-mode").selectOption("light")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  await page.screenshot({ path: join(evidence, "light.png") })
  await page.locator("#appearance-mode").selectOption("system")
  await page.emulateMedia({ colorScheme: "dark" })
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  // Inspection is read-only, including a paused hidden App.
  await page.getByRole("button", { name: "Inspect traces", exact: true }).click()
  await expect(page.locator("#selected-state")).toHaveText("paused")
  await expect(page.locator("#capture")).toContainText("Session retained")
  expect(fixture.calls.filter((call) => call.method === "layout.apply")).toHaveLength(0)
  await page.locator("#history-button").click()
  await expect(page.locator("#capture-state")).toHaveText("History (held)")
  await expect(page.locator("#capture")).toContainText("A line from earlier")
  await page.locator("#live-button").click()
  await page.locator("#navigate-button").click()
  await expect(page.locator("#selected-position")).toHaveText("On Stage")
  await expect(page.locator("#selected-state")).toHaveText("running")
  expect(fixture.snapshot.state!.layout.visible).toEqual(["editor", "preview", "tests", "traces"])
  await page.locator('[data-app="tests"]').click()
  await page.locator("#navigate-button").click()
  await expect(page.locator("#navigate-button")).toHaveText("Has terminal Focus")
  expect(fixture.snapshot.state!.layout.focus).toBe("tests")
  await page.locator('[data-filter="hidden"]').click()
  await expect(page.locator(".app-row")).toHaveCount(2)
  await page.locator('[data-filter="all"]').click()
  await page.locator("#app-search").fill("no-match")
  await expect(page.locator(".app-row")).toHaveCount(0)
  await page.locator("#app-search").fill("")
  await page.locator("#stage-view").click()
  await expect(page.locator("#stage-view")).toHaveAttribute("aria-pressed", "true")
  await expect(page.locator("#spread")).toBeDisabled()
  await page.locator("#spatial-view").click()
  await page.locator("#instance-switch").click()
  await expect(page.locator(".instance-option")).toHaveCount(1)
  await page.screenshot({ path: join(evidence, "instances.png") })
  await page.locator("#dialog-demo").click()
  await expect(page.locator("#demo-banner")).toBeVisible()
  const revision = fixture.snapshot.state!.layout.revision
  await page.locator('[data-app="api"]').click()
  await page.locator("#navigate-button").click()
  await expect(page.locator("#navigate-button")).toHaveText("Has terminal Focus")
  expect(fixture.snapshot.state!.layout.revision).toBe(revision)
  await page.locator("#demo-button").click()
  await page.locator("#reset-view").click()
  await page.screenshot({ path: join(evidence, "demo.png") })
  // The navigation list and inspector stay accessible on small screens.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.locator("#reset-view").click()
  await expect(page.locator("#scene-title")).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.locator('[data-app="build"]').click()
  await expect(page.locator("#capture")).toContainText("No current Session")
  await page.screenshot({ path: join(evidence, "mobile.png"), fullPage: true })
  await page.setViewportSize({ width: 1512, height: 982 })
  await page.reload()
  await expect(page.locator("#connection-text")).toHaveText("Live")
  // Full-width box drawing, Unicode and repeated output, including a hidden App.
  let tick = 0
  const framed = (capture: Capture): Capture => {
    const middle = (value: string) => `│${value}${" ".repeat(Math.max(0, capture.cols - 2 - Bun.stringWidth(value)))}│`
    const lines = ["┌" + "─".repeat(capture.cols - 2) + "┐", middle(` Live output frame ${tick}`),
      middle(" Unicode: e\u0301 界 🙂 / full grid"),
      ...Array.from({ length: capture.rows - 4 }, () => middle("")), "└" + "─".repeat(capture.cols - 2) + "┘"]
    return { ...capture, lines, ansi: lines.map(line => `\x1b[0;38;2;130;170;255m${line}\x1b[0m`) }
  }
  fixture.holdCaptures(async capture => ["editor", "api"].includes(capture.name) ? framed(capture) : capture)
  await page.locator('[data-app="editor"]').click()
  const emit = (name: string) => fixture.publish("session.changed", {
    name, sessionId: fixture.snapshot.state!.apps.find(app => app.name === name)!.session!.id, title: "",
  })
  const canvas = page.locator('[data-scene-app="editor"] canvas')
  emit("editor"); emit("api")
  await expect(page.locator("#capture")).toContainText("Live output frame 0")
  await expect(page.locator('[data-scene-app="api"]')).toContainText("Live output frame 0")
  await expect(canvas).toHaveAttribute("data-cols", String(fixture.snapshot.state!.apps.find(app => app.name === "editor")!.cols))
  const beforeImage = await canvas.evaluate(node => (node as HTMLCanvasElement).toDataURL())
  const beforeTransform = await page.locator('[data-scene-app="editor"]').getAttribute("style")
  const capturesBefore = fixture.calls.filter(call => call.method === "app.capture").length
  for (tick = 1; tick <= 20; tick++) { emit("editor"); emit("api") }
  tick = 20
  await expect(page.locator("#capture")).toContainText("Live output frame 20")
  await expect(page.locator('[data-scene-app="api"]')).toContainText("Live output frame 20")
  await expect.poll(() => canvas.evaluate(node => (node as HTMLCanvasElement).toDataURL())).not.toBe(beforeImage)
  expect(fixture.calls.filter(call => call.method === "app.capture").length - capturesBefore).toBeLessThanOrEqual(4)
  expect(await page.locator('[data-scene-app="editor"]').getAttribute("style")).toBe(beforeTransform)
  await expect(page.locator("#selected-name")).toHaveText("editor")
  const fitted = await page.locator(".terminal-face-screen, #capture").evaluateAll(hosts => hosts.map(host => {
    const raster = host.querySelector<HTMLCanvasElement>("canvas")!
    const css = getComputedStyle(host)
    const scale = Number(raster.dataset.scale)
    return { width: parseFloat(raster.style.width) * scale,
      available: host.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight) }
  }).filter(size => size.width > 0))
  expect(fitted.every(size => size.width <= size.available + .5)).toBe(true)
  // The geometric left border is continuous across every row boundary, on the actual raster.
  const border = await canvas.evaluate(node => {
    const image = node as HTMLCanvasElement, ctx = image.getContext("2d")!
    const ratio = image.width / parseFloat(image.style.width)
    const cw = Number(image.dataset.cellWidth) * ratio
    const ch = Number(image.dataset.cellHeight) * image.height / parseFloat(image.style.height)
    const x = Math.floor(cw / 2), start = Math.ceil(ch), end = Math.floor(image.height - ch)
    const pixels = ctx.getImageData(x, start, 1, end - start).data
    let gaps = 0
    for (let y = 0; y < pixels.length; y += 4) if (pixels[y + 2]! < 80 || pixels[y + 2]! < pixels[y]! * 1.3) gaps++
    const edge = ctx.getImageData(Math.floor(image.width - cw), Math.ceil(ch), Math.max(1, Math.floor(cw)), Math.max(1, Math.floor(ch))).data
    return { gaps, rightEdgePainted: Array.from(edge).some((value, i) => i % 4 === 2 && value > 100) }
  })
  expect(border.gaps).toBe(0)
  expect(border.rightEdgePainted).toBe(true)
  await page.locator("#expand-capture").click()
  await expect(page.locator("#terminal-dialog")).toBeVisible()
  await expect(page.locator("#expanded-capture")).toContainText("Unicode: e\u0301 界 🙂")
  await page.screenshot({ path: join(evidence, "terminal-fit.png") })
  await page.locator("#terminal-native").click()
  await expect(page.locator("#expanded-capture")).toHaveAttribute("data-fit", "native")
  await page.screenshot({ path: join(evidence, "terminal-font-size.png") })
  await page.keyboard.press("Escape")
  await expect(page.locator("#terminal-dialog")).toBeHidden()
  await page.screenshot({ path: join(evidence, "live-output.png") })
  // A Runtime disappearing must immediately remove stale terminal content.
  fixture.server.stop()
  await expect(page.locator("#connection-text")).toHaveText("Reconnecting")
  await expect(page.locator(".terminal-face")).toHaveCount(0)
  await expect(page.locator("#inspector-content")).toBeHidden()
  await fixture.server.start()
  await expect(page.locator("#connection-text")).toHaveText("Live", { timeout: 15000 })
  await expect(page.locator(".terminal-face")).toHaveCount(6)
  expect(errors).toEqual([])
  console.log(
    `Explorer browser checks passed: live discovery, hidden Captures, history, navigation, filters, demo isolation, responsive layout, reconnect, Ghostty appearance, light/dark/system, full columns, solid borders, expanded terminal and coalesced live output.\nScreens: ${evidence}`,
  )
} finally {
  await browser?.close()
  await bridge.stop()
  await fixture.close()
}
