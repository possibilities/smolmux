import { expect, test } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { StoppingView } from "../src/stopping-view.ts"

// A focused terminal can reveal/home its cursor as its process tears down.
// Its pixels are covered by the snapshot, but its hardware cursor is separate.
test("the inert stopping frame conceals a still-rendering terminal cursor", async () => {
  const { renderer, renderOnce } = await createTestRenderer({ width: 80, height: 24 })
  const underneath = new BoxRenderable(renderer, {
    id: "focused-terminal", width: 80, height: 24,
    renderAfter: () => renderer.setCursorPosition(31, 1, true),
  })
  renderer.root.add(underneath)
  let stopping: StoppingView | undefined
  try {
    await renderOnce()
    expect(renderer.getCursorState().visible).toBe(true)
    stopping = new StoppingView(renderer, { theme: "dark", source: "default", background: null, explicit: false })
    for (const phase of ["preparing", "terminating", "failed"] as const) {
      stopping.update({ operationId: "stop", phase, remaining: ["app"], error: null, preparationError: null },
        { theme: "dark", source: "default", background: null, explicit: false })
      await renderOnce()
      expect(renderer.getCursorState().visible).toBe(false)
    }
  } finally {
    stopping?.destroy()
    renderer.destroy()
  }
})
