import { expect, test } from "bun:test"
import { BoxRenderable, type KeyEvent, type RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import {
  RecoveryCard,
  RecoveryCardError,
  type RecoveryCardSpec,
  parseRecoveryCard,
} from "../src/recovery-card.ts"

function card(overrides: Partial<RecoveryCardSpec> = {}): RecoveryCardSpec {
  return {
    slot_id: "slot-a",
    card_revision: "12",
    title: "Member unavailable",
    message: "The exact member cannot be restored. Existing records remain intact.",
    action: {
      action_id: "request-fresh-member",
      label: "Request fresh member",
      ...overrides.action,
    },
    ...overrides,
  }
}

function key(overrides: Partial<KeyEvent> = {}): KeyEvent {
  const name = overrides.name ?? "r"
  return {
    name,
    sequence: overrides.sequence ?? name,
    raw: overrides.raw ?? name,
    shift: false,
    ctrl: false,
    meta: false,
    option: false,
    super: false,
    hyper: false,
    ...overrides,
  } as KeyEvent
}

test("uses the frozen UTF-8 bounds and rejects unsafe causal text", () => {
  expect(parseRecoveryCard(card({ title: "é".repeat(48) })).title).toBe("é".repeat(48))
  expect(parseRecoveryCard(card({ message: "m".repeat(1024) })).message).toHaveLength(1024)
  expect(parseRecoveryCard(card({ action: { action_id: "act", label: "l".repeat(96) } })).action.label)
    .toHaveLength(96)

  for (const invalid of [
    card({ title: "é".repeat(49) }),
    card({ message: "m".repeat(1025) }),
    card({ action: { action_id: "act", label: "l".repeat(97) } }),
    card({ title: "   " }),
    card({ title: "title\nforged row" }),
    card({ message: "terminal\u001b[31m injection" }),
    card({ action: { action_id: "act", label: "bad\u007f label" } }),
  ]) {
    expect(() => parseRecoveryCard(invalid)).toThrow(RecoveryCardError)
  }
})

test("enforces the one frozen action shape", () => {
  const valid = card()
  const { action: _action, ...missingAction } = valid
  expect(() => parseRecoveryCard(missingAction)).toThrow(RecoveryCardError)
  expect(() => parseRecoveryCard({ ...valid, action: [valid.action] })).toThrow(RecoveryCardError)
  expect(() => parseRecoveryCard({ ...valid, actions: [valid.action] })).toThrow(RecoveryCardError)
  expect(() => parseRecoveryCard({
    ...valid,
    action: { ...valid.action, secondary_label: "Do something else" },
  })).toThrow(RecoveryCardError)
})

test("renders bounded literal selectable text with only fxnk Ramp colors", async () => {
  const setup = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true })
  const recovery = new RecoveryCard(setup.renderer, {
    card: card({
      title: "<b>{Member} unavailable</b>",
      message: "[cause](not markup) {{ remains literal }}",
      action: { action_id: "act", label: "<Request fresh>" },
    }),
    selected: true,
    theme: "light",
    onAction: () => {},
  })
  setup.renderer.root.add(recovery)

  try {
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("<b>{Member} unavailable</b>")
    expect(frame).toContain("[cause](not markup) {{ remains literal }}")
    expect(frame).toContain("❯ <Request fresh>")
    expect(recovery.visible).toBe(true)
    expect(recovery.surface.width).toBeLessThanOrEqual(72)
    expect(recovery.surface.height).toBeLessThanOrEqual(16)
    expect(recovery.surface.width).toBeGreaterThan(0)
    expect(recovery.surface.height).toBeGreaterThan(0)
    expect(recovery.titleText.selectable).toBe(true)
    expect(recovery.messageText.selectable).toBe(true)
    expect(recovery.actionText.selectable).toBe(false)
    expect(recovery.focusable).toBe(false)
    expect(recovery.surface.focusable).toBe(false)
    expect(recovery.actionButton.focusable).toBe(false)
    expect(recovery.surface.backgroundColor.slot).toBe(254)
    expect(recovery.surface.borderColor.slot).toBe(238)

    const allowedLightSlots = new Set([235, 238, 241, 247, 250, 254, 255])
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
    for (const span of spans.filter((candidate) => candidate.text.trim().length > 0)) {
      assertRampColor(span.fg, allowedLightSlots)
      // The canvas is deliberately the terminal default; the test renderer
      // resolves that intent to RGB in captured spans. Any owned fill remains
      // an exact indexed Ramp step.
      if (span.bg.intent === "indexed") assertRampColor(span.bg, allowedLightSlots)
    }

    recovery.setSelected(false)
    expect(recovery.selected).toBe(false)
    expect(recovery.visible).toBe(true)
    expect(recovery.surface.borderColor.slot).toBe(250)
    recovery.applyTheme("dark")
    expect(recovery.surface.borderColor.slot).toBe(240)
    expect(recovery.actionButton.backgroundColor.slot).toBe(236)
  } finally {
    recovery.destroyRecursively()
    setup.renderer.destroy()
  }
})

test("keyboard and mouse activation have focus- and selection-neutral parity", async () => {
  const setup = await createTestRenderer({ width: 64, height: 14, kittyKeyboard: true })
  const correlations: unknown[] = []
  const focusHolder = new BoxRenderable(setup.renderer, {
    id: "recovery-card-focus-holder",
    width: 1,
    height: 1,
    focusable: true,
  })
  const recovery = new RecoveryCard(setup.renderer, {
    card: card(),
    selected: false,
    onAction: (correlation) => correlations.push(correlation),
  })
  setup.renderer.root.add(focusHolder)
  setup.renderer.root.add(recovery)
  focusHolder.focus()

  try {
    await setup.renderOnce()
    expect(focusHolder.focused).toBe(true)
    recovery.focus()
    expect(focusHolder.focused).toBe(true)
    expect(recovery.focused).toBe(false)
    expect(recovery.handleKeyPress(key({ name: "x" }))).toBe(false)
    expect(recovery.handleKeyPress(key({ name: "enter", ctrl: true }))).toBe(false)
    expect(recovery.handleKeyPress(key({ name: "enter" }))).toBe(true)
    expect(recovery.selected).toBe(false)
    expect(focusHolder.focused).toBe(true)

    await setup.mockMouse.pressDown(
      recovery.actionButton.screenX + 1,
      recovery.actionButton.screenY,
    )
    await setup.mockMouse.release(
      recovery.actionButton.screenX + 1,
      recovery.actionButton.screenY,
    )
    await setup.mockMouse.pressDown(
      recovery.actionButton.screenX + 1,
      recovery.actionButton.screenY,
      2,
    )
    await setup.mockMouse.release(
      recovery.actionButton.screenX + 1,
      recovery.actionButton.screenY,
      2,
    )

    const expected = {
      slot_id: "slot-a",
      card_revision: "12",
      action_id: "request-fresh-member",
    }
    expect(correlations).toEqual([expected, expected])
    expect(recovery.selected).toBe(false)
    expect(focusHolder.focused).toBe(true)

    recovery.visible = false
    expect(recovery.handleKeyPress(key({ name: "space" }))).toBe(false)
    expect(correlations).toHaveLength(2)
  } finally {
    recovery.destroyRecursively()
    focusHolder.destroyRecursively()
    setup.renderer.destroy()
  }
})

test("updates opaque correlation in place and cleans every renderable", async () => {
  const setup = await createTestRenderer({ width: 64, height: 14, kittyKeyboard: true })
  const correlations: unknown[] = []
  const recovery = new RecoveryCard(setup.renderer, {
    card: card(),
    onAction: (correlation) => correlations.push(correlation),
  })
  const retainedActionText = recovery.actionText
  setup.renderer.root.add(recovery)

  await setup.renderOnce()
  recovery.setCard(card({
    slot_id: "slot-next",
    card_revision: "18446744073709551615",
    title: "Updated cause",
    message: "The authoritative cause changed without rebuilding the surface.",
    action: { action_id: "opaque-next-action", label: "Try the new action" },
  }))
  expect(recovery.actionText).toBe(retainedActionText)
  expect(recovery.handleKeyPress(key({ name: "return" }))).toBe(true)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("Updated cause")
  expect(correlations).toEqual([{
    slot_id: "slot-next",
    card_revision: "18446744073709551615",
    action_id: "opaque-next-action",
  }])
  expect(setup.renderer.root.findDescendantById("fmx-recovery-card-slot-next")).toBe(recovery)

  recovery.destroyRecursively()
  expect(recovery.isDestroyed).toBe(true)
  expect(recovery.surface.isDestroyed).toBe(true)
  expect(recovery.titleText.isDestroyed).toBe(true)
  expect(recovery.messageText.isDestroyed).toBe(true)
  expect(recovery.actionButton.isDestroyed).toBe(true)
  expect(recovery.actionText.isDestroyed).toBe(true)
  expect(setup.renderer.root.findDescendantById("fmx-recovery-card-slot-next")).toBeUndefined()
  expect(recovery.handleKeyPress(key({ name: "enter" }))).toBe(false)
  expect(correlations).toHaveLength(1)
  setup.renderer.destroy()
})

function assertRampColor(color: RGBA, allowedSlots: ReadonlySet<number>): void {
  expect(color.intent).toBe("indexed")
  expect(allowedSlots.has(color.slot)).toBe(true)
}
