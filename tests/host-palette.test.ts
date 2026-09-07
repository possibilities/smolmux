import { expect, test } from "bun:test"
import {
  buildEmbeddedThemeSequence,
  colorFgBgIsLight,
  type FxnkThemeMonitorPort,
  FxnkThemeMonitor,
  fxnkRamp,
  parseOsc11Response,
  resolveFxnkTheme,
} from "../src/host-palette.ts"

test("fxnk ramps are fx's fixed indexed dark and light roles", () => {
  const dark = fxnkRamp("dark")
  const light = fxnkRamp("light")
  expect(dark.background.intent).toBe("default")
  expect(light.background.intent).toBe("default")
  expect([dark.foreground.slot, dark.accent.slot, dark.secondary.slot, dark.dim.slot, dark.divider.slot]).toEqual([
    255, 252, 250, 245, 240,
  ])
  expect([
    light.foreground.slot,
    light.accent.slot,
    light.secondary.slot,
    light.dim.slot,
    light.divider.slot,
  ]).toEqual([235, 238, 241, 247, 250])
  expect([dark.unused.slot, dark.surface.slot]).toEqual([235, 236])
  expect([light.unused.slot, light.surface.slot]).toEqual([255, 254])
  expect(dark.focus.slot).toBe(4)
  expect(light.focus.slot).toBe(4)
  expect(dark.error.slot).toBe(1)
  expect(light.error.slot).toBe(1)
})

test("fxnk theme parsing matches fx's OSC 11 and COLORFGBG thresholds", () => {
  expect(parseOsc11Response("\x1b]11;rgb:ffff/ffff/ffff\x1b\\")).toEqual({
    light: true,
    hex: "#ffffff",
  })
  expect(parseOsc11Response("\x1b]11;rgb:0/0/0\x07")).toEqual({
    light: false,
    hex: "#000000",
  })
  expect(parseOsc11Response("\x1b]11;rgb:FFFF/ABCD/0000\x07")).toEqual({
    light: true,
    hex: "#ffab00",
  })
  expect(parseOsc11Response("\x1b]11;RGB:ffff/ffff/ffff\x07")).toBeNull()
  expect(parseOsc11Response("\x1b]10;rgb:ffff/ffff/ffff\x07")).toBeNull()
  expect(colorFgBgIsLight("0;8")).toBe(true)
  expect(colorFgBgIsLight("0;7")).toBe(false)
  expect(colorFgBgIsLight("1;3;15")).toBe(true)
  expect(colorFgBgIsLight("0;999")).toBe(false)
})

test("fxnk resolution uses SMOLMUX_THEME, OSC 11, COLORFGBG, then dark", async () => {
  const explicitPort = new FakeThemePort()
  expect(await resolveFxnkTheme(explicitPort, { SMOLMUX_THEME: "LIGHT", COLORFGBG: "0;0" }, 1)).toMatchObject({
    theme: "light",
    source: "SMOLMUX_THEME",
    explicit: true,
  })
  expect(explicitPort.writes).toEqual([])

  const oscPort = new FakeThemePort("\x1b]11;rgb:ffff/ffff/ffff\x1b\\")
  expect(await resolveFxnkTheme(oscPort, { COLORFGBG: "15;0" }, 20)).toMatchObject({
    theme: "light",
    source: "osc11",
    background: "#ffffff",
  })
  expect(oscPort.writes).toEqual(["\x1b]11;?\x1b\\"])

  expect(await resolveFxnkTheme(new FakeThemePort(), { COLORFGBG: "0;15" }, 1)).toMatchObject({
    theme: "light",
    source: "COLORFGBG",
  })
  expect(await resolveFxnkTheme(new FakeThemePort(), {}, 1)).toMatchObject({
    theme: "dark",
    source: "default",
  })

  // A headless Runtime has no terminal to answer, so it never asks and never
  // waits: the first Client tells it instead.
  const headlessPort = new FakeThemePort("\x1b]11;rgb:ffff/ffff/ffff\x1b\\")
  expect(await resolveFxnkTheme(headlessPort, { COLORFGBG: "0;15" }, 0)).toMatchObject({
    theme: "light",
    source: "COLORFGBG",
  })
  expect(headlessPort.writes).toEqual([])
  expect(await resolveFxnkTheme(new FakeThemePort(), {}, 0)).toMatchObject({ theme: "dark", source: "default" })
})

test("a late initial OSC 11 answer cannot retint the chosen fallback", async () => {
  const port = new FakeThemePort()
  const resolution = await resolveFxnkTheme(port, {}, 1)
  port.emitOsc("\x1b]11;rgb:ffff/ffff/ffff\x1b\\")
  expect(resolution.theme).toBe("dark")
})

test("live fxnk changes use a fenced OSC 11 sample and swap once", () => {
  const port = new FakeThemePort()
  const updates: string[] = []
  const monitor = new FxnkThemeMonitor(
    port,
    { theme: "dark", background: "#000000", source: "osc11", explicit: false },
    (resolution) => updates.push(resolution.theme),
  )
  monitor.start()
  try {
    expect(port.feedInput("\x1b[?997;2n")).toBe(true)
    expect(port.writes.at(-1)).toBe("\x1b[c")
    expect(port.feedInput("\x1b[?1;2c")).toBe(true)
    expect(port.writes.at(-1)).toBe("\x1b]11;?\x1b\\\x1b[c")
    port.emitOsc("\x1b]11;rgb:ffff/ffff/ffff\x1b\\")
    expect(port.feedInput("\x1b[?1;2c")).toBe(true)
    expect(updates).toEqual(["light"])
  } finally {
    monitor.dispose()
  }
})

test("a newer 997 notification drops an in-flight sample and starts a fresh fenced cycle", () => {
  const port = new FakeThemePort()
  const updates: Array<{ theme: string; background: string | null }> = []
  const monitor = new FxnkThemeMonitor(
    port,
    { theme: "dark", background: "#000000", source: "osc11", explicit: false },
    ({ theme, background }) => updates.push({ theme, background }),
  )
  monitor.start()
  try {
    port.feedInput("\x1b[?997;2n")
    port.feedInput("\x1b[?1;2c")
    port.emitOsc("\x1b]11;rgb:ffff/ffff/ffff\x1b\\")
    port.feedInput("\x1b[?997;1n")

    // The fence closes the obsolete light sample and immediately begins a
    // newly fenced dark cycle. Nothing from the obsolete cycle is applied.
    port.feedInput("\x1b[?1;2c")
    expect(updates).toEqual([])
    expect(port.writes.at(-1)).toBe("\x1b[c")

    port.feedInput("\x1b[?1;2c")
    port.emitOsc("\x1b]11;rgb:1111/1111/1111\x1b\\")
    port.feedInput("\x1b[?1;2c")
    expect(updates).toEqual([{ theme: "dark", background: "#111111" }])
  } finally {
    monitor.dispose()
  }
})

test("a response fence arriving before OSC 11 keeps the bounded sample open", () => {
  const port = new FakeThemePort()
  const updates: string[] = []
  const monitor = new FxnkThemeMonitor(
    port,
    { theme: "dark", background: "#000000", source: "osc11", explicit: false },
    ({ theme }) => updates.push(theme),
  )
  monitor.start()
  try {
    port.feedInput("\x1b[?997;2n")
    port.feedInput("\x1b[?1;2c")
    port.feedInput("\x1b[?1;2c")
    expect(updates).toEqual([])

    port.emitOsc("\x1b]11;rgb:ffff/ffff/ffff\x1b\\")
    port.feedInput("\x1b[?1;2c")
    expect(updates).toEqual(["light"])
  } finally {
    monitor.dispose()
  }
})

test("embedded terminals receive the theme foreground and resolved background as a pair", () => {
  expect(
    buildEmbeddedThemeSequence({
      theme: "dark",
      background: "#123456",
      source: "osc11",
      explicit: false,
    }),
  ).toBe("\x1b]10;#eeeeee\x1b\\\x1b]11;#123456\x1b\\")
  expect(
    buildEmbeddedThemeSequence({
      theme: "light",
      background: null,
      source: "COLORFGBG",
      explicit: false,
    }),
  ).toBe("\x1b]10;#262626\x1b\\\x1b]11;#fafafa\x1b\\")
  expect(
    buildEmbeddedThemeSequence({
      theme: "dark",
      background: null,
      source: "default",
      explicit: false,
    }),
  ).toBe("\x1b]10;#eeeeee\x1b\\\x1b]11;#1c1c1c\x1b\\")
})

class FakeThemePort implements FxnkThemeMonitorPort {
  readonly writes: string[] = []
  private readonly oscHandlers = new Set<(sequence: string) => void>()
  private readonly inputHandlers: Array<(sequence: string) => boolean> = []

  constructor(private readonly immediateOsc: string | null = null) {}

  write(sequence: string): void {
    this.writes.push(sequence)
    if (this.immediateOsc && sequence.includes("\x1b]11;?")) {
      queueMicrotask(() => this.emitOsc(this.immediateOsc!))
    }
  }

  subscribeOsc(handler: (sequence: string) => void): () => void {
    this.oscHandlers.add(handler)
    return () => this.oscHandlers.delete(handler)
  }

  prependInputHandler(handler: (sequence: string) => boolean): void {
    this.inputHandlers.unshift(handler)
  }

  removeInputHandler(handler: (sequence: string) => boolean): void {
    const index = this.inputHandlers.indexOf(handler)
    if (index !== -1) this.inputHandlers.splice(index, 1)
  }

  emitOsc(sequence: string): void {
    for (const handler of this.oscHandlers) handler(sequence)
  }

  feedInput(sequence: string): boolean {
    return this.inputHandlers.some((handler) => handler(sequence))
  }
}
