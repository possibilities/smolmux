import { expect, test } from "bun:test"
import { OptimizedBuffer, RGBA, TextAttributes } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { boundStyledCapture, captureAnsi, MAX_STYLED_CAPTURE_BYTES } from "../src/capture-ansi.ts"
import { PaneTerminalRenderable } from "../src/pane-terminal.ts"
import type { Capture } from "../src/protocol.ts"

const strip = (text: string) => text.replace(/\x1b\[[\d;:]*m/gu, "")

test("styled Capture preserves color intent, attributes, wide and combining glyphs, and all columns", () => {
  const buffer = OptimizedBuffer.create(16, 3, "unicode")
  try {
    buffer.clear(RGBA.defaultBackground())
    buffer.drawText("│e\u0301界🙂 END │", 0, 0, RGBA.fromIndex(4), RGBA.defaultBackground(), TextAttributes.BOLD)
    buffer.drawText("RGB", 0, 1, RGBA.fromHex("#12abef"), RGBA.fromIndex(1), TextAttributes.UNDERLINE | TextAttributes.ITALIC)
    buffer.drawText("last", 12, 2, RGBA.defaultForeground(), RGBA.defaultBackground())
    const lines = captureAnsi(buffer)!
    expect(lines).toHaveLength(3)
    expect(strip(lines[0]!)).toStartWith("│e\u0301界🙂 END │")
    expect(strip(lines[2]!)).toBe("            last")
    expect(lines[0]).toContain("38;5;4;49;1m")
    expect(lines[1]).toContain("38;2;18;171;239;48;5;1;3;4m")
    expect(lines.every(line => line.endsWith("\x1b[0m"))).toBe(true)
    expect(lines.join("").replace(/\x1b\[[\d;:]*m/gu, "")).not.toMatch(/[\x00-\x1f\x7f-\x9f]/u)
  } finally { buffer.destroy() }
})

test("hidden emulator Capture keeps styled viewport after history and does not consume frame damage", async () => {
  const setup = await createTestRenderer({ width: 30, height: 5 })
  const terminal = new PaneTerminalRenderable(setup.renderer, { id: "styled-hidden", cols: 30, rows: 5,
    width: 30, height: 5, visible: false, maxScrollback: 100_000 })
  setup.renderer.root.add(terminal)
  try {
    terminal.write(Array.from({ length: 20 }, (_, i) => `\x1b[31mrow ${i}\x1b[0m\r\n`).join("") + "\x1b[32;1mCURRENT")
    const before = terminal.captureScreen(30, 5)
    const history = terminal.captureScreen(30, 5, 15)
    expect(history.lines.length).toBeGreaterThan(before.lines.length)
    expect(history.ansi).toEqual(before.ansi)
    expect(history.ansi).toHaveLength(5)
    expect(history.ansi!.join("")).toContain("CURRENT")
    expect(terminal.captureScreen(30, 5).ansi).toEqual(before.ansi)
    terminal.visible = true
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("CURRENT")
    expect(terminal.captureScreen(30, 5).ansi).toEqual(before.ansi)
  } finally { setup.renderer.destroy() }
})

test("styled bytes are bounded and never push an otherwise valid plain Capture across the socket limit", () => {
  const buffer = OptimizedBuffer.create(1024, 32, "unicode")
  try {
    for (let y = 0; y < 32; y++) for (let x = 0; x < 1024; x++)
      buffer.setCell(x, y, "x", RGBA.fromIndex(x % 2 + 1), RGBA.defaultBackground())
    expect(captureAnsi(buffer)).toBeUndefined()
  } finally { buffer.destroy() }
  const capture: Capture = { name: "large", sessionId: crypto.randomUUID(), lines: ["界".repeat(950_000)],
    ansi: ["\x1b[0m" + "x".repeat(400_000)], screen_start: 0, cols: 400, rows: 1,
    cursor: { x: 0, y: 0, visible: false }, title: "", state: "running" }
  expect(Buffer.byteLength(JSON.stringify(capture))).toBeGreaterThan(MAX_STYLED_CAPTURE_BYTES)
  const bounded = boundStyledCapture(capture)
  expect(bounded.ansi).toBeUndefined()
  expect(bounded.lines[0]).toHaveLength(950_000)
  expect(Buffer.byteLength(JSON.stringify({ v: 2, type: "response", id: "capture", result: bounded }))).toBeLessThan(4 * 1024 * 1024)
})
