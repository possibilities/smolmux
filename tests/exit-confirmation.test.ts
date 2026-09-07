import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { ExitConfirmation, EXIT_CONFIRMATION_MS } from "../src/exit-confirmation.ts"

const theme = { theme: "dark", background: null, source: "default", explicit: false } as const

test("opt-in consumes Ctrl+C, expires, suppresses repeats, and confirms only once", async () => {
  const setup = await createTestRenderer({ width: 60, height: 5, kittyKeyboard: true, exitOnCtrlC: false })
  let stops = 0
  let delivered = 0
  const confirmation = new ExitConfirmation(setup.renderer, theme, async () => { stops++ }, () => {})
  setup.renderer.keyInput.on("keypress", () => delivered++)
  try {
    setup.mockInput.pressCtrlC()
    expect(delivered).toBe(1)
    confirmation.configure(true)
    setup.mockInput.pressCtrlC()
    expect(stops).toBe(0)
    expect(delivered).toBe(1)
    await Bun.sleep(EXIT_CONFIRMATION_MS + 20)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("again")
    setup.mockInput.pressCtrlC()
    expect(stops).toBe(0)
    setup.renderer.keyInput.processParsedKey({ name: "c", ctrl: true, shift: false, meta: false, option: false,
      sequence: "", raw: "", number: false, source: "kitty", eventType: "repeat" })
    expect(stops).toBe(0)
    setup.mockInput.pressKey("x")
    expect(delivered).toBe(2)
    setup.mockInput.pressCtrlC()
    setup.mockInput.pressCtrlC()
    expect(stops).toBe(1)
    expect(delivered).toBe(2)
  } finally { confirmation.dispose(); setup.renderer.destroy() }
})

test("failed stop reports visibly and permits a fresh two-press retry", async () => {
  const setup = await createTestRenderer({ width: 60, height: 5, exitOnCtrlC: false })
  const errors: string[] = []
  let attempts = 0
  const confirmation = new ExitConfirmation(setup.renderer, theme,
    async () => { if (++attempts === 1) throw new Error("still alive") }, line => errors.push(line))
  try {
    confirmation.configure(true)
    setup.mockInput.pressCtrlC()
    setup.mockInput.pressCtrlC()
    await Promise.resolve()
    await setup.renderOnce()
    expect(errors).toEqual(["confirmed exit failed: still alive"])
    expect(setup.captureCharFrame()).toContain("exit failed; press ctrl+c to retry")
    setup.mockInput.pressCtrlC()
    expect(attempts).toBe(1)
    setup.mockInput.pressCtrlC()
    expect(attempts).toBe(2)
  } finally { confirmation.dispose(); setup.renderer.destroy() }
})
