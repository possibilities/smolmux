import { describe, expect, test } from "bun:test"
import { METHODS, NAMED_KEYS } from "../src/protocol.ts"
import { isNamedKey, keyEventFor, keyEventsForText, mouseDeliveryFor } from "../src/session-input.ts"

const params = METHODS["app.input"].params

describe("key events", () => {
  test("a character key carries its own text and its unshifted codepoint", () => {
    const key = keyEventFor({ key: "a" })
    expect(key.name).toBe("a")
    expect(key.sequence).toBe("a")
    expect(key.code).toBe("KeyA")
    expect(key.baseCode).toBe(97)
    expect(key.eventType).toBe("press")
  })

  test("shift does not change which physical key was pressed", () => {
    // The encoder reports the unshifted codepoint, so `A` and `a` agree on the
    // key and only the modifier tells them apart.
    expect(keyEventFor({ key: "A", shift: true }).baseCode).toBe(97)
    expect(keyEventFor({ key: "A", shift: true }).code).toBe("KeyA")
    expect(keyEventFor({ key: "A", shift: true }).shift).toBe(true)
  })

  test("modifiers land on the fields the encoder reads", () => {
    const key = keyEventFor({ key: "c", ctrl: true, alt: true, super: true })
    expect(key.ctrl).toBe(true)
    // ParsedKey carries Alt as `option` and Super as `meta`.
    expect(key.option).toBe(true)
    expect(key.meta).toBe(true)
  })

  test("a named key has a physical code and no text", () => {
    expect(keyEventFor({ key: "enter" }).code).toBe("Enter")
    expect(keyEventFor({ key: "enter" }).sequence).toBe("")
    expect(keyEventFor({ key: "pageup" }).code).toBe("PageUp")
    expect(keyEventFor({ key: "up" }).code).toBe("ArrowUp")
  })

  test("every function key is named, because the encoder maps none of them itself", () => {
    expect(keyEventFor({ key: "f1" }).code).toBe("F1")
    expect(keyEventFor({ key: "f24" }).code).toBe("F24")
    for (const name of NAMED_KEYS) expect(isNamedKey(name)).toBe(true)
  })

  test("space is a named key that still types a space", () => {
    expect(keyEventFor({ key: "space" }).code).toBe("Space")
    expect(keyEventFor({ key: "space" }).sequence).toBe(" ")
  })

  test("a key name is matched without regard to case", () => {
    expect(keyEventFor({ key: "Enter" }).code).toBe("Enter")
    expect(isNamedKey("PageDown")).toBe(true)
    expect(isNamedKey("nosuchkey")).toBe(false)
  })

  test("release and repeat reach the encoder as themselves", () => {
    expect(keyEventFor({ key: "a", action: "release" }).eventType).toBe("release")
    expect(keyEventFor({ key: "a", action: "repeat" }).eventType).toBe("repeat")
  })

  test("text is one press per character, astral characters included", () => {
    expect(keyEventsForText("hi").map((key) => key.sequence)).toEqual(["h", "i"])
    // One press per code point, not per UTF-16 unit.
    expect(keyEventsForText("a🙂").map((key) => key.sequence)).toEqual(["a", "🙂"])
  })
})

describe("mouse delivery", () => {
  const origin = { x: 51, y: 2 }

  test("coordinates are the Session's own, offset by its Pane", () => {
    const mouse = mouseDeliveryFor({ action: "down", button: "left", x: 4, y: 2 }, origin)
    expect([mouse.x, mouse.y]).toEqual([55, 4])
    expect(mouse.button).toBe(0)
    expect(mouse.type).toBe("down")
  })

  test("a Pane at the origin passes the coordinates through", () => {
    const mouse = mouseDeliveryFor({ action: "up", button: "right", x: 0, y: 0 }, { x: 0, y: 0 })
    expect([mouse.x, mouse.y, mouse.button]).toEqual([0, 0, 2])
  })

  test("a drag says a button is down and a move does not", () => {
    expect(mouseDeliveryFor({ action: "drag", x: 1, y: 1 }, origin).isDragging).toBe(true)
    expect(mouseDeliveryFor({ action: "move", x: 1, y: 1 }, origin).isDragging).toBe(false)
  })

  test("the button defaults to left", () => {
    expect(mouseDeliveryFor({ action: "down", x: 0, y: 0 }, origin).button).toBe(0)
    expect(mouseDeliveryFor({ action: "down", button: "middle", x: 0, y: 0 }, origin).button).toBe(1)
  })

  test("scroll carries its direction and delta", () => {
    const mouse = mouseDeliveryFor({ action: "scroll", x: 1, y: 1, scroll: { direction: "up", delta: 3 } }, origin)
    expect(mouse.type).toBe("scroll")
    expect(mouse.scroll).toEqual({ direction: "up", delta: 3 })
  })

  test("modifiers come through as the encoder's own shape", () => {
    const mouse = mouseDeliveryFor({ action: "down", x: 0, y: 0, ctrl: true, shift: true }, origin)
    expect(mouse.modifiers).toEqual({ shift: true, alt: false, ctrl: true })
  })
})

describe("the contract", () => {
  test("accepts a batch of every kind of event", () => {
    expect(
      params.safeParse({
        name: "reviewer",
        events: [
          { text: "git status" },
          { key: "enter" },
          { key: "c", ctrl: true },
          { paste: "hello" },
          { mouse: { action: "down", button: "left", x: 4, y: 2 } },
        ],
      }).success,
    ).toBe(true)
  })

  test("refuses an empty batch and one past the cap", () => {
    expect(params.safeParse({ name: "a", events: [] }).success).toBe(false)
    const many = Array.from({ length: 257 }, () => ({ key: "a" }))
    expect(params.safeParse({ name: "a", events: many }).success).toBe(false)
  })

  test("refuses an event that is two kinds at once, or none", () => {
    expect(params.safeParse({ name: "a", events: [{ text: "x", paste: "y" }] }).success).toBe(false)
    expect(params.safeParse({ name: "a", events: [{}] }).success).toBe(false)
  })

  test("refuses a mouse action it does not have", () => {
    expect(params.safeParse({ name: "a", events: [{ mouse: { action: "wiggle", x: 0, y: 0 } }] }).success).toBe(false)
    expect(params.safeParse({ name: "a", events: [{ mouse: { action: "down", x: -1, y: 0 } }] }).success).toBe(false)
  })

  test("refuses text past its cap", () => {
    expect(params.safeParse({ name: "a", events: [{ text: "x".repeat(4_097) }] }).success).toBe(false)
    expect(params.safeParse({ name: "a", events: [{ paste: "x".repeat(65_537) }] }).success).toBe(false)
  })
})
