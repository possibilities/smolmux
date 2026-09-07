import { chromium, expect } from "@playwright/test"
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { explorerFixture } from "../../tests/explorer-fixture.ts"
import { buildExplorer } from "./build.ts"
import { startBridge } from "./bridge.ts"
import { socketDirectory } from "./discovery.ts"

// A dedicated browser with an ephemeral profile. It never touches an operator's tab.
const fixture = await explorerFixture()
const bridge = startBridge({
  port: 0,
  directory: fixture.directory,
  assets: await buildExplorer(),
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
  await page.screenshot({ path: join(evidence, "desktop.png") })
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
    `Explorer browser checks passed: live discovery, hidden Captures, history, navigation, filters, demo isolation, responsive layout, and reconnect.\nScreens: ${evidence}`,
  )
} finally {
  await browser?.close()
  await bridge.stop()
  await fixture.close()
}
