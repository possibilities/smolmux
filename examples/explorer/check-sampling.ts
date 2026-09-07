import { expect, type Page } from "@playwright/test"
import { join } from "node:path"
import type { explorerFixture } from "../../tests/explorer-fixture.ts"

type Point = { x: number; y: number }
type Line = { from: Point; to: Point }

// Integrate brightness across the projected stroke so ordinary edge antialiasing
// is not mistaken for striping. A disappearing line cannot pass by being uniformly black.
async function lineProfiles(page: Page, png: Buffer, lines: Line[]) {
  return page.evaluate(async ({ base64, lines }) => {
    const image = new Image()
    image.src = `data:image/png;base64,${base64}`
    await image.decode()
    const canvas = document.createElement("canvas")
    canvas.width = image.width; canvas.height = image.height
    const ctx = canvas.getContext("2d")!
    ctx.drawImage(image, 0, 0)
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    const ratio = image.width / innerWidth
    const sample = (x: number, y: number) => {
      const ix = Math.floor(x), iy = Math.floor(y), a = x - ix, b = y - iy
      const value = (x: number, y: number) => {
        const i = (y * canvas.width + x) * 4
        return (pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3
      }
      return value(ix, iy) * (1 - a) * (1 - b) + value(ix + 1, iy) * a * (1 - b)
        + value(ix, iy + 1) * (1 - a) * b + value(ix + 1, iy + 1) * a * b
    }
    return lines.map(({ from, to }) => {
      const dx = (to.x - from.x) * ratio, dy = (to.y - from.y) * ratio, length = Math.hypot(dx, dy)
      const values: number[] = []
      for (let s = 0; s < Math.floor(length); s++) {
        const x = from.x * ratio + dx * s / length, y = from.y * ratio + dy * s / length
        let energy = 0
        for (let n = -3; n <= 3; n++) energy += sample(x + dy / length * n, y - dx / length * n)
        values.push(energy)
      }
      const mean = values.reduce((a, b) => a + b, 0) / values.length
      const variation = Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length) / mean
      return { mean, variation, gaps: values.filter(v => v < mean * .3).length }
    })
  }, { base64: png.toString("base64"), lines })
}

export async function checkTerminalSampling(page: Page, fixture: Awaited<ReturnType<typeof explorerFixture>>, evidence: string) {
  const original = fixture.snapshot.state!
  const state = structuredClone(original), editor = state.apps.find(app => app.name === "editor")!
  editor.cols = 120; editor.rows = 42; editor.visible = editor.shown = true
  state.apps = [editor]
  state.stage = { cols: editor.cols, rows: editor.rows }
  state.layout = { ...state.layout, root: { app: "editor" }, focus: "editor", visible: ["editor"], stage: state.stage,
    panes: [{ app: "editor", text: null, x: 0, y: 0, cols: editor.cols, rows: editor.rows, focused: true }] }
  fixture.snapshot.state = state
  let frame = 0
  fixture.holdCaptures(async capture => {
    const lines = Array.from({ length: capture.rows }, (_, y) => {
      const line: string[] = Array.from({ length: capture.cols }, (_, x) => y === 2 || y === capture.rows - 3 ? "─"
        : x === 6 || x === 110 ? "│" : " ")
      if (y === 10) `Thin lines / frame ${frame}`.split("").forEach((c, i) => { line[12 + i] = c })
      return line.join("")
    })
    return { ...capture, cursor: { x: 0, y: 0, visible: false }, lines,
      ansi: lines.map(line => `\x1b[38;2;255;255;255m${line}\x1b[0m`) }
  })
  let retina: Page | undefined
  try {
    retina = await page.context().browser()!.newPage({ viewport: { width: 1512, height: 982 }, deviceScaleFactor: 2 })
    for (const [target, density] of [[page, 1], [retina, 2]] as const) {
      await target.emulateMedia({ reducedMotion: "reduce" })
      if (target === page) await target.reload()
      else await target.goto(page.url())
      await expect(target.locator(".terminal-face")).toHaveCount(1)
      await expect(target.locator("#capture")).toContainText(`Thin lines / frame ${frame}`)
      const raster = target.locator('[data-scene-app="editor"] canvas')
      for (const angle of ["initial", "orbited", "zoomed"]) {
        if (angle === "orbited") {
          const viewport = await target.locator("#viewport").boundingBox()
          await target.mouse.move(viewport!.x + viewport!.width * .7, viewport!.y + viewport!.height * .5)
          await target.mouse.down()
          await target.mouse.move(viewport!.x + viewport!.width * .7 + 45, viewport!.y + viewport!.height * .5 - 20, { steps: 8 })
          await target.mouse.up()
        }
        if (angle === "zoomed") await target.mouse.wheel(0, 700)
        // Output replacement uses the retained full raster, including after camera changes.
        frame++
        fixture.publish("session.changed", { name: editor.name, sessionId: editor.session!.id, title: "" })
        await expect(target.locator("#capture")).toContainText(`Thin lines / frame ${frame}`)
        await target.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        const lines = await raster.evaluate(node => {
          const c = node as HTMLCanvasElement, cw = Number(c.dataset.cellWidth), ch = Number(c.dataset.cellHeight)
          const marker = (x: number, y: number) => {
            const point = document.createElement("span")
            point.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:0;height:0;pointer-events:none`
            c.parentElement!.append(point)
            const rect = point.getBoundingClientRect()
            point.remove()
            return { x: rect.x, y: rect.y }
          }
          return [{ from: marker(cw * 6.5, ch * 5), to: marker(cw * 6.5, ch * 37) },
            { from: marker(cw * 10, ch * 2.5), to: marker(cw * 106, ch * 2.5) }]
        })
        const filtered = await lineProfiles(target, await target.screenshot({ path: join(evidence, `sampling-${density}x-${angle}.png`) }), lines)
        // Reproduce the former CSS compositor path with the inspector's untouched
        // full raster at precisely the same projection. No application test hooks.
        await raster.evaluate(node => {
          const source = document.querySelector<HTMLCanvasElement>("#capture canvas")!
          const clone = document.createElement("canvas")
          clone.dataset.unfiltered = "true"
          clone.className = node.className
          clone.style.cssText = (node as HTMLElement).style.cssText
          clone.width = source.width; clone.height = source.height
          clone.getContext("2d")!.drawImage(source, 0, 0)
          node.parentElement!.append(clone)
        })
        const unfiltered = await lineProfiles(target, await target.screenshot({ path: join(evidence, `sampling-${density}x-${angle}-unfiltered.png`) }), lines)
        await target.locator("[data-unfiltered]").evaluate(node => node.remove())
        console.log(`Terminal sampling ${density}x ${angle}: ${JSON.stringify({ filtered, unfiltered })}`)
        for (let i = 0; i < filtered.length; i++) {
          expect(filtered[i]!.mean).toBeGreaterThan(Math.max(5, unfiltered[i]!.mean * .4))
          expect(filtered[i]!.variation).toBeLessThan(.25)
          expect(filtered[i]!.gaps).toBe(0)
          if (unfiltered[i]!.variation > .25) expect(filtered[i]!.variation).toBeLessThan(unfiltered[i]!.variation * .6)
        }
      }
      await target.locator("#expand-capture").click()
      await target.locator("#terminal-native").click()
      await expect(target.locator("#expanded-capture")).toContainText(`Thin lines / frame ${frame}`)
      await expect(target.locator("#expanded-capture canvas")).toHaveAttribute("data-cols", "120")
      const nativeWidth = await target.locator("#expanded-capture canvas").evaluate(node => (node as HTMLCanvasElement).width)
      expect(nativeWidth).toBeGreaterThan(await raster.evaluate(node => (node as HTMLCanvasElement).width))
      await target.keyboard.press("Escape")
    }
  } finally {
    await retina?.close()
    fixture.snapshot.state = original
    fixture.holdCaptures(null)
    await page.reload()
  }
}
