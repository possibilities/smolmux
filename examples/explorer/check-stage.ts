import { expect, type Page } from "@playwright/test"
import { join } from "node:path"
import { fitLayout, paneGeometries } from "../../src/layout.ts"
import type { LayoutNode } from "../../src/protocol.ts"
import type { explorerFixture } from "../../tests/explorer-fixture.ts"

/** Compare actual projected browser bounds to the Runtime's cell rectangles. */
export async function checkStageGeometry(page: Page, fixture: Awaited<ReturnType<typeof explorerFixture>>, evidence: string) {
  const state = fixture.snapshot.state!
  const original = structuredClone(state)
  const mutations = fixture.calls.filter(call => call.method === "layout.apply").length
  fixture.holdCaptures(async capture => {
    const lines = Array.from({ length: capture.rows }, (_, row) => row === 0 || row === capture.rows - 1
      ? "█".repeat(capture.cols) : "█" + " ".repeat(capture.cols - 2) + "█")
    return { ...capture, lines, ansi: lines.map(line => `\x1b[38;2;130;170;255m${line}\x1b[0m`) }
  })
  await page.locator("#stage-view").click()
  for (const [name, cols, rows, editorCols] of [
    ["composed", 180, 50, 103], ["wide", 400, 24, 103], ["tall", 72, 120, 24],
  ] as const) {
    const root: LayoutNode = { column: [
      { text: "A real Text Pane", size: 1 },
      { row: [{ app: "editor", size: editorCols }, { column: [{ app: "preview" }, { app: "tests", size: 1 }] }], size: rows - 5 },
    ] }
    state.stage = { cols, rows }
    state.layout = { ...state.layout, root, stage: state.stage, revision: state.layout.revision + 1,
      panes: paneGeometries(fitLayout(root, state.stage), state.layout.focus) }
    for (const app of state.apps) {
      const pane = state.layout.panes.find(pane => pane.app === app.name)
      app.shown = !!pane && pane.cols > 0 && pane.rows > 0
      if (app.shown) { app.cols = pane!.cols; app.rows = pane!.rows }
    }
    fixture.publish("layout.changed", { layout: state.layout, apps: state.apps, cause: "resize" })
    const panes = state.layout.panes.filter(pane => pane.app)
    for (const pane of panes) {
      const raster = page.locator(`[data-scene-app="${pane.app}"] canvas`)
      await expect(raster).toHaveAttribute("data-cols", String(pane.cols))
      await expect(raster).toHaveAttribute("data-rows", String(pane.rows))
    }
    const measure = () => page.evaluate(({ panes, cols, rows }) => {
      const stage = document.querySelector<HTMLElement>(".stage-surface")!.getBoundingClientRect()
      const errors: number[] = []
      for (const pane of panes) {
        const face = document.querySelector<HTMLElement>(`[data-scene-app="${pane.app}"]`)!
        const image = face.querySelector<HTMLCanvasElement>("canvas")!
        const rect = image.getBoundingClientRect()
        const box = face.getBoundingClientRect()
        // Content, not the decorative button, must occupy every fitted cell.
        errors.push(Math.abs(rect.left - stage.left - pane.x / cols * stage.width),
          Math.abs(rect.top - stage.top - pane.y / rows * stage.height),
          Math.abs(rect.width - pane.cols / cols * stage.width),
          Math.abs(rect.height - pane.rows / rows * stage.height),
          Math.abs(rect.left - box.left), Math.abs(rect.top - box.top),
          Math.abs(rect.width - box.width), Math.abs(rect.height - box.height))
        // Pixel shape comes from the actual Ghostty font, with no per-Pane fit.
        const aspect = Number(image.dataset.cellWidth) / Number(image.dataset.cellHeight)
        errors.push(Math.abs(stage.width / cols / (stage.height / rows) - aspect))
      }
      return Math.max(...errors)
    }, { panes, cols, rows })
    await expect.poll(measure).toBeLessThan(0.1)
    await expect(page.locator('[data-fitted="true"] .terminal-face-head:visible')).toHaveCount(0)
    await expect(page.locator('[data-fitted="true"] .terminal-face-foot:visible')).toHaveCount(0)
    const textRect = await page.locator(".stage-text-pane").evaluate(node => {
      const rect = node.getBoundingClientRect(), stage = node.parentElement!.getBoundingClientRect()
      return { x: rect.left - stage.left, y: rect.top - stage.top, width: rect.width / stage.width, height: rect.height / stage.height }
    })
    expect(textRect.x).toBeCloseTo(0, 1)
    expect(textRect.y).toBeCloseTo(0, 1)
    expect(textRect.width).toBeCloseTo(1, 4)
    expect(textRect.height).toBeCloseTo(1 / rows, 4)
    // Both Divider axes are painted in their reserved one-cell bands.
    expect(await page.locator(".stage-dividers").evaluate((node, { cols, rows, editorCols }) => {
      const canvas = node as HTMLCanvasElement, ctx = canvas.getContext("2d")!
      const painted = (col: number, row: number) => {
        const x = (col + .5) / cols * canvas.width, y = (row + .5) / rows * canvas.height
        return ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3]! > 0
      }
      return painted(0, 1) && painted(editorCols, 3)
    }, { cols, rows, editorCols })).toBe(true)
    await page.screenshot({ path: join(evidence, `stage-${name}.png`) })
    if (name === "composed") {
      // Selecting even a one-row terminal cannot hit the Stage surface behind it.
      await page.locator('[data-scene-app="tests"]').click()
      await expect(page.locator("#selected-name")).toHaveText("tests")
      await expect.poll(measure).toBeLessThan(0.1)
      const viewport = await page.locator("#viewport").boundingBox()
      await page.mouse.move(viewport!.x + 20, viewport!.y + 30)
      await page.mouse.down()
      await page.mouse.move(viewport!.x + 50, viewport!.y + 60, { steps: 5 })
      await page.mouse.up()
      await expect.poll(measure).toBeLessThan(0.1)
    }
  }
  // Separation changes position/depth, never the terminal's 2D dimensions.
  const sizes = () => page.locator('[data-fitted="true"]').evaluateAll(faces => faces.map(face => ({
    width: (face as HTMLElement).style.width, height: (face as HTMLElement).style.height,
    canvas: (face.querySelector("canvas") as HTMLCanvasElement).dataset.scale,
  })))
  const composed = await sizes()
  await page.locator("#spatial-view").click()
  await expect(page.locator('[data-fitted="true"] .terminal-face-head:visible')).toHaveCount(3)
  expect(await sizes()).toEqual(composed)
  await page.locator("#spread").fill("0")
  await expect(page.locator('[data-fitted="true"] .terminal-face-head:visible')).toHaveCount(0)
  expect(await sizes()).toEqual(composed)
  await page.locator("#spread").fill("65")
  Object.assign(state, original)
  fixture.holdCaptures(null)
  fixture.publish("layout.changed", { layout: state.layout, apps: state.apps, cause: "resize" })
  expect(fixture.calls.filter(call => call.method === "layout.apply")).toHaveLength(mutations)
}
