import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { PaneTerminalRenderable } from "../src/pane-terminal.ts"
import type { LayoutNode } from "../src/protocol.ts"
import { Stage } from "../src/stage.ts"

/**
 * The Stage against real renderables: what an apply moves, what it leaves
 * alone, and who has the keyboard. Sessions are stand-in emulators so the
 * roster's lifecycle stays out of it.
 */


async function harness(names: string[], width = 100, height = 30) {
  const setup = await createTestRenderer({ width, height, kittyKeyboard: true, exitOnCtrlC: false })
  const terminals = new Map<string, PaneTerminalRenderable>()
  const resizes = new Map<string, number>()
  for (const name of names) {
    const terminal = new PaneTerminalRenderable(setup.renderer, {
      id: `pane-${name}`,
      cols: 80,
      rows: 24,
      position: "absolute",
      visible: false,
      onTerminalResize: () => resizes.set(name, (resizes.get(name) ?? 0) + 1),
    })
    terminals.set(name, terminal)
  }
  let shown: string[] = []
  const causes: string[] = []
  const stage = new Stage({
    renderer: setup.renderer,
    panes: {
      terminalFor: (name) => terminals.get(name) ?? null,
      setShown: (next) => {
        shown = [...next]
      },
    },
    theme: { theme: "dark", background: null, source: "default", explicit: false },
    onChanged: (cause) => causes.push(cause),
  })
  return {
    setup,
    stage,
    terminals,
    resizes,
    causes,
    get shown() {
      return shown
    },
    close: () => {
      stage.destroy()
      setup.renderer.destroy()
    },
  }
}

const sixPanels: LayoutNode = {
  row: [
    { column: [{ text: "notes", size: 8, min: 3 }, { app: "tray" }], size: 26, min: 24 },
    { app: "reviewer", min: 20 },
    { app: "docs", size: 20, min: 10 },
  ],
}

/** Geometry as smolmux computed it, which is what the API reports and what the
 * next frame draws; Yoga only publishes it on a render. */
const rect = (view: { panes: { app: string | null; x: number; y: number; cols: number; rows: number }[] }, name: string) => {
  const pane = view.panes.find((candidate) => candidate.app === name)!
  return { x: pane.x, y: pane.y, cols: pane.cols, rows: pane.rows }
}

test("applies a Layout by placing every Pane at its fitted rectangle", async () => {
  const stage = await harness(["tray", "reviewer", "docs"])
  try {
    const view = stage.stage.apply(sixPanels, "reviewer")
    expect(view.stage).toEqual({ cols: 100, rows: 30 })
    expect(view.focus).toBe("reviewer")
    expect(rect(view, "tray")).toEqual({ x: 0, y: 9, cols: 26, rows: 21 })
    expect(rect(view, "reviewer")).toEqual({ x: 27, y: 0, cols: 52, rows: 30 })
    expect(rect(view, "docs")).toEqual({ x: 80, y: 0, cols: 20, rows: 30 })
    expect(stage.shown).toEqual(["tray", "reviewer", "docs"])
    expect(stage.causes).toEqual(["apply"])

    // What smolmux computed is what the frame draws.
    await stage.setup.renderOnce()
    const drawn = stage.terminals.get("reviewer")!
    expect([drawn.x, drawn.y, drawn.width, drawn.height]).toEqual([27, 0, 52, 30])
  } finally {
    stage.close()
  }
})

test("a Pane that keeps its rectangle across an apply is never resized", async () => {
  const stage = await harness(["tray", "reviewer", "docs"])
  try {
    stage.stage.apply(sixPanels, "reviewer")
    await stage.setup.renderOnce()
    const before = new Map(stage.resizes)
    expect(before.get("reviewer")).toBe(1)
    // Same tree, new focus: nothing moves, so nothing reflows or tells its PTY.
    const view = stage.stage.apply(sixPanels, "tray")
    await stage.setup.renderOnce()
    expect(stage.resizes).toEqual(before)
    expect(rect(view, "reviewer")).toEqual({ x: 27, y: 0, cols: 52, rows: 30 })
  } finally {
    stage.close()
  }
})

test("a Session that leaves the Layout is hidden and keeps its size", async () => {
  const stage = await harness(["tray", "reviewer", "docs"])
  try {
    stage.stage.apply(sixPanels, "reviewer")
    await stage.setup.renderOnce()
    const docs = stage.terminals.get("docs")!
    const hidden = [docs.x, docs.y, docs.width, docs.height]
    stage.stage.apply({ row: [{ app: "tray", size: 26 }, { app: "reviewer" }] }, "reviewer")
    await stage.setup.renderOnce()
    expect(docs.visible).toBe(false)
    expect([docs.x, docs.y, docs.width, docs.height]).toEqual(hidden)
    expect(stage.shown).toEqual(["tray", "reviewer"])
    expect(stage.terminals.get("reviewer")!.visible).toBe(true)
  } finally {
    stage.close()
  }
})

test("keyboard focus is the API's alone and follows the Layout", async () => {
  const stage = await harness(["tray", "reviewer"])
  try {
    stage.stage.apply({ row: [{ app: "tray", size: 26 }, { app: "reviewer" }] }, "reviewer")
    expect(stage.terminals.get("reviewer")!.focused).toBe(true)
    expect(stage.terminals.get("tray")!.focused).toBe(false)

    // A Pane cannot take focus for itself; OpenTUI's own focus() is refused.
    stage.terminals.get("tray")!.focus()
    expect(stage.terminals.get("tray")!.focused).toBe(false)

    stage.stage.apply({ row: [{ app: "tray", size: 26 }, { app: "reviewer" }] }, "tray")
    expect(stage.terminals.get("tray")!.focused).toBe(true)
    expect(stage.terminals.get("reviewer")!.focused).toBe(false)

    // A focused Session that leaves the screen takes the keyboard with it.
    expect(stage.stage.apply({ app: "reviewer" }, undefined).focus).toBeNull()
    expect(stage.terminals.get("reviewer")!.focused).toBe(false)
  } finally {
    stage.close()
  }
})

test("a Pane naming a Session that does not exist draws nothing and keeps its place", async () => {
  const stage = await harness(["tray"])
  try {
    const view = stage.stage.apply({ row: [{ app: "tray", size: 26 }, { app: "later" }] }, "tray")
    expect(stage.shown).toEqual(["tray"])
    // The Layout is still the caller's, so creating that Session later fills
    // its Pane without another apply.
    expect(view.root).toEqual({ row: [{ app: "tray", size: 26 }, { app: "later" }] })
    expect(view.panes.map((pane) => pane.app)).toEqual(["tray", "later"])
  } finally {
    stage.close()
  }
})

test("a resize refits every Pane once", async () => {
  const stage = await harness(["tray", "reviewer", "docs"])
  try {
    stage.stage.apply(sixPanels, "reviewer")
    await stage.setup.renderOnce()
    stage.resizes.clear()
    stage.setup.resize(60, 20)
    const view = stage.stage.refit("resize")
    await stage.setup.renderOnce()
    expect(stage.resizes.get("reviewer")).toBe(1)
    expect(stage.resizes.get("docs")).toBe(1)
    // The sized Pane gives up only what the fit needs; the elastic one keeps its floor.
    expect(rect(view, "reviewer")).toEqual({ x: 27, y: 0, cols: 20, rows: 20 })
    expect(rect(view, "docs")).toEqual({ x: 48, y: 0, cols: 12, rows: 20 })
  } finally {
    stage.close()
  }
})

test("a stale apply is refused so a human's drag is never clobbered", async () => {
  const stage = await harness(["tray", "reviewer"])
  try {
    const first = stage.stage.apply(sixPanels, "reviewer")
    expect(first.revision).toBe(1)
    // Applying from the revision you read succeeds and moves it on.
    const second = stage.stage.apply(sixPanels, "reviewer", { revision: first.revision })
    expect(second.revision).toBe(2)
    // The same read applied twice is a conflict, not a silent overwrite.
    expect(() => stage.stage.apply(sixPanels, "reviewer", { revision: first.revision })).toThrow(
      "the Layout has moved on: revision 2, not 1",
    )
    // A caller that does not track revisions still writes unconditionally.
    expect(stage.stage.apply(sixPanels, "reviewer").revision).toBe(3)
  } finally {
    stage.close()
  }
})

test("a drag in flight re-baselines on an apply rather than reverting it", async () => {
  const stage = await harness(["a", "b"])
  try {
    stage.stage.apply({ row: [{ app: "a", size: 20 }, { app: "b" }] }, "a")
    const divider = { id: ":0", axis: "row" as const, rect: { x: 20, y: 0, cols: 1, rows: 30 } }
    const event = (x: number) => ({ x, y: 0, preventDefault: () => {}, stopPropagation: () => {} })

    // The human grabs the divider.
    ;(stage.stage as never as { beginDrag(id: string, event: unknown): void }).beginDrag(":0", event(20))

    // A caller applies a different Layout mid-gesture, and is told it worked.
    const applied = stage.stage.apply({ row: [{ app: "b", size: 40 }, { app: "a" }] }, "b")
    expect(applied.root).toEqual({ row: [{ app: "b", size: 40 }, { app: "a" }] })

    // The next drag event must not put the old tree back.
    ;(stage.stage as never as { continueDrag(divider: unknown, event: unknown): void }).continueDrag(divider, event(25))
    const after = stage.stage.view
    expect((after.root as { row: { app?: string }[] }).row[0]!.app).toBe("b")
    expect(after.focus).toBe("b")
  } finally {
    stage.close()
  }
})

test("a Layout that cannot be drawn is not the one the Stage keeps", async () => {
  const stage = await harness(["a"])
  try {
    const good = stage.stage.apply({ app: "a" }, "a")
    const panes = stage.terminals.get("a")!
    // Make the next draw throw the way a renderer failure would.
    const original = panes.captureScreen.bind(panes)
    Object.defineProperty(panes, "visible", {
      set() {
        throw new Error("renderer is gone")
      },
      get() {
        return true
      },
      configurable: true,
    })
    expect(() => stage.stage.apply({ row: [{ app: "a" }, { text: "next" }] }, "a")).toThrow("renderer is gone")
    void original
    // The Stage still holds the tree it could draw, and its revision did not move.
    expect(stage.stage.view.root).toEqual(good.root)
    expect(stage.stage.view.revision).toBe(good.revision)
  } finally {
    stage.close()
  }
})

test("an empty Layout leaves the stage to the terminal's own canvas", async () => {
  const stage = await harness(["tray"])
  try {
    stage.stage.apply(sixPanels, "tray")
    const view = stage.stage.apply(null, null)
    expect(view.root).toBeNull()
    expect(view.panes).toEqual([])
    expect(stage.shown).toEqual([])
    expect(stage.terminals.get("tray")!.visible).toBe(false)
  } finally {
    stage.close()
  }
})

test("a text Pane paints its line in the dim step", async () => {
  const stage = await harness([])
  try {
    stage.stage.apply({ text: "no sessions" }, null)
    await stage.setup.renderOnce()
    expect(stage.setup.captureCharFrame()).toContain("no sessions")
  } finally {
    stage.close()
  }
})
