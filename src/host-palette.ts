import { RGBA } from "@opentui/core"

export type FxnkTheme = "dark" | "light"

export type FxnkThemeSource = "SMOLMUX_THEME" | "osc11" | "COLORFGBG" | "default"

export type FxnkThemeResolution = {
  theme: FxnkTheme
  /** The terminal background sampled by OSC 11, when one was available. */
  background: string | null
  source: FxnkThemeSource
  /** An explicit override is fixed for the process lifetime, just as in fx. */
  explicit: boolean
}

export type Ramp = {
  background: RGBA
  unused: RGBA
  surface: RGBA
  divider: RGBA
  dim: RGBA
  secondary: RGBA
  accent: RGBA
  foreground: RGBA
  focus: RGBA
  error: RGBA
  backdrop: RGBA
}

export type Osc11Port = {
  write(sequence: string): unknown
  subscribeOsc(handler: (sequence: string) => void): () => void
}

export type FxnkThemeMonitorPort = Osc11Port & {
  prependInputHandler(handler: (sequence: string) => boolean): void
  removeInputHandler(handler: (sequence: string) => boolean): void
}

const OSC11_QUERY = "\x1b]11;?\x1b\\"
const OSC11_RESPONSE_PREFIX = "\x1b]11;rgb:"
const RESPONSE_FENCE_QUERY = "\x1b[c"
const PRIMARY_DEVICE_ATTRIBUTES_PREFIX = "\x1b[?"
const DARK_NOTIFICATION = "\x1b[?997;1n"
const LIGHT_NOTIFICATION = "\x1b[?997;2n"
const OSC11_TIMEOUT_MS = 200

/**
 * fx's indexed roles, plus the two fixed smolmux surface steps. The canvas is
 * always the terminal's default background. Focus and error are direct ANSI
 * intents, not colors sampled from the host palette.
 */
const RAMPS: Readonly<Record<FxnkTheme, Ramp>> = {
  dark: {
    background: RGBA.defaultBackground(),
    unused: RGBA.fromIndex(235),
    surface: RGBA.fromIndex(236),
    divider: RGBA.fromIndex(240),
    dim: RGBA.fromIndex(245),
    secondary: RGBA.fromIndex(250),
    accent: RGBA.fromIndex(252),
    foreground: RGBA.fromIndex(255),
    focus: RGBA.fromIndex(4),
    error: RGBA.fromIndex(1),
    backdrop: RGBA.fromHex("#00000033"),
  },
  light: {
    background: RGBA.defaultBackground(),
    unused: RGBA.fromIndex(255),
    surface: RGBA.fromIndex(254),
    divider: RGBA.fromIndex(250),
    dim: RGBA.fromIndex(247),
    secondary: RGBA.fromIndex(241),
    accent: RGBA.fromIndex(238),
    foreground: RGBA.fromIndex(235),
    focus: RGBA.fromIndex(4),
    error: RGBA.fromIndex(1),
    backdrop: RGBA.fromHex("#00000033"),
  },
}

/** Dark remains the no-signal fallback, matching fx. */
export const RAMP_FALLBACK = RAMPS.dark

export function fxnkRamp(theme: FxnkTheme): Ramp {
  return RAMPS[theme]
}

/** Match fx's own order: SMOLMUX_THEME -> OSC 11 -> COLORFGBG -> dark. */
export async function resolveFxnkTheme(
  port: Osc11Port,
  env: Record<string, string | undefined> = process.env,
  timeoutMs = OSC11_TIMEOUT_MS,
): Promise<FxnkThemeResolution> {
  const override = explicitTheme(env.SMOLMUX_THEME)
  if (override) {
    return { theme: override, background: null, source: "SMOLMUX_THEME", explicit: true }
  }
  // A headless Runtime has no terminal to answer, and waiting for the timeout
  // would delay its first frame. The first Client tells it instead.
  if (timeoutMs <= 0) {
    const colorFgBg = colorFgBgIsLight(env.COLORFGBG)
    return {
      theme: colorFgBg ? "light" : "dark",
      background: null,
      source: colorFgBg ? "COLORFGBG" : "default",
      explicit: false,
    }
  }

  const background = await queryOsc11(port, timeoutMs)
  if (background) {
    return {
      theme: background.light ? "light" : "dark",
      background: background.hex,
      source: "osc11",
      explicit: false,
    }
  }

  const colorFgBgLight = colorFgBgIsLight(env.COLORFGBG)
  return {
    theme: colorFgBgLight ? "light" : "dark",
    background: null,
    source: colorFgBgLight ? "COLORFGBG" : "default",
    explicit: false,
  }
}

/**
 * Own fx-style live theme updates. CSI 997 is only a trigger: stale OSC 11
 * replies are drained behind a DA1 fence, then a fresh OSC 11 sample is
 * fenced before the complete fixed token set is replaced.
 */
export class FxnkThemeMonitor {
  private phase: "idle" | "drain" | "sample" = "idle"
  private notification: FxnkTheme | null = null
  private sample: ParsedOsc11 | null = null
  /** A notification that arrived after the current sample query began. */
  private sampleDirty = false
  private timeout: ReturnType<typeof setTimeout> | null = null
  private unsubscribeOsc: (() => void) | null = null
  private disposed = false

  private readonly inputHandler = (sequence: string): boolean => {
    const notification = notificationTheme(sequence)
    if (notification) {
      // SMOLMUX_THEME fixes the palette for the process lifetime. Still own the
      // protocol byte so OpenTUI cannot start a second theme query path.
      if (this.current.explicit) return true
      this.notification = notification
      if (this.phase === "idle") this.beginDrain()
      else if (this.phase === "sample") this.sampleDirty = true
      return true
    }

    if (this.phase !== "idle" && isPrimaryDeviceAttributes(sequence)) {
      if (this.phase === "drain") this.beginSample()
      else this.finishSample()
      return true
    }
    return false
  }

  constructor(
    private readonly port: FxnkThemeMonitorPort,
    private current: FxnkThemeResolution,
    private readonly onTheme: (resolution: FxnkThemeResolution) => void,
    private readonly timeoutMs = OSC11_TIMEOUT_MS,
  ) {}

  start(): void {
    if (this.disposed || this.unsubscribeOsc) return
    this.unsubscribeOsc = this.port.subscribeOsc((sequence) => {
      if (this.phase !== "sample") return
      const parsed = parseOsc11Response(sequence)
      if (parsed) this.sample = parsed
    })
    this.port.prependInputHandler(this.inputHandler)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearTimer()
    this.unsubscribeOsc?.()
    this.unsubscribeOsc = null
    this.port.removeInputHandler(this.inputHandler)
  }

  private beginDrain(): void {
    this.phase = "drain"
    this.sample = null
    this.sampleDirty = false
    if (!this.tryWrite(RESPONSE_FENCE_QUERY)) this.finishWithNotification()
    else this.armTimeout()
  }

  private beginSample(): void {
    this.clearTimer()
    this.phase = "sample"
    this.sample = null
    this.sampleDirty = false
    if (!this.tryWrite(`${OSC11_QUERY}${RESPONSE_FENCE_QUERY}`)) this.finishWithNotification()
    else this.armTimeout()
  }

  private finishSample(): void {
    // A fence can arrive before a non-conforming terminal's OSC response.
    // Keep the bounded sample open; the timeout remains the fallback.
    if (!this.sample) return

    if (this.sampleDirty) {
      // Match fx: the sample belongs to an older notification generation.
      // Drop it and fence a fresh cycle for the newest notification.
      this.phase = "idle"
      this.sample = null
      this.sampleDirty = false
      this.clearTimer()
      if (this.notification) this.beginDrain()
      return
    }

    const notification = this.notification
    const sample = this.sample
    this.phase = "idle"
    this.notification = null
    this.sample = null
    this.sampleDirty = false
    this.clearTimer()
    if (!notification) return
    this.apply({
      theme: sample ? (sample.light ? "light" : "dark") : notification,
      background: sample?.hex ?? null,
      source: sample ? "osc11" : "default",
      explicit: false,
    })
  }

  private finishWithNotification(): void {
    const notification = this.notification
    this.phase = "idle"
    this.notification = null
    this.sample = null
    this.sampleDirty = false
    this.clearTimer()
    if (!notification) return
    this.apply({ theme: notification, background: null, source: "default", explicit: false })
  }

  private apply(next: FxnkThemeResolution): void {
    const changed =
      next.theme !== this.current.theme ||
      (next.background !== null && next.background !== this.current.background)
    if (!changed) return
    this.current = next
    this.onTheme(next)
  }

  private armTimeout(): void {
    this.clearTimer()
    this.timeout = setTimeout(() => this.finishWithNotification(), this.timeoutMs)
  }

  private clearTimer(): void {
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = null
  }

  private tryWrite(sequence: string): boolean {
    try {
      this.port.write(sequence)
      return true
    } catch {
      return false
    }
  }
}

export type ParsedOsc11 = { light: boolean; hex: string }

export function parseOsc11Response(sequence: string): ParsedOsc11 | null {
  if (!sequence.startsWith(OSC11_RESPONSE_PREFIX)) return null
  const end = sequence.endsWith("\x1b\\")
    ? sequence.length - 2
    : sequence.endsWith("\x07")
      ? sequence.length - 1
      : -1
  if (end <= OSC11_RESPONSE_PREFIX.length) return null
  const parts = sequence.slice(OSC11_RESPONSE_PREFIX.length, end).split("/")
  if (parts.length !== 3 || parts.some((part) => !/^[0-9a-fA-F]{1,4}$/u.test(part))) return null
  const components = parts.map(normalizeOscComponent)
  if (components.some((component) => component === null)) return null
  const [red, green, blue] = components as [number, number, number]
  const luminance = Math.floor((red * 299 + green * 587 + blue * 114) / 1000)
  return {
    light: luminance > 32768,
    hex: `#${[red, green, blue]
      .map((component) => (component >> 8).toString(16).padStart(2, "0"))
      .join("")}`,
  }
}

export function colorFgBgIsLight(value: string | undefined): boolean {
  if (!value) return false
  const separator = value.lastIndexOf(";")
  if (separator === -1) return false
  const background = value.slice(separator + 1)
  if (!/^\d+$/u.test(background)) return false
  const index = Number.parseInt(background, 10)
  return index <= 255 && index >= 8
}

/** Apps such as Codex require both OSC 10 and 11 replies before using their palette. */
export function buildEmbeddedThemeSequence(resolution: FxnkThemeResolution): string {
  const background = resolution.background ?? (resolution.theme === "light" ? "#fafafa" : "#1c1c1c")
  const foreground = fxnkRamp(resolution.theme).foreground.toInts().slice(0, 3)
    .map((channel) => channel.toString(16).padStart(2, "0")).join("")
  return `\x1b]10;#${foreground}\x1b\\\x1b]11;${background}\x1b\\`
}

/** Ghostty's color-scheme notification, which the live-theme monitor treats as a trigger. */
export function themeModeReport(theme: FxnkTheme): Uint8Array {
  return new TextEncoder().encode(theme === "light" ? LIGHT_NOTIFICATION : DARK_NOTIFICATION)
}

function explicitTheme(value: string | undefined): FxnkTheme | null {
  if (value?.toLowerCase() === "light") return "light"
  if (value?.toLowerCase() === "dark") return "dark"
  return null
}

function queryOsc11(port: Osc11Port, timeoutMs: number): Promise<ParsedOsc11 | null> {
  return new Promise((resolve) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    let unsubscribe = () => {}
    const finish = (result: ParsedOsc11 | null) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      unsubscribe()
      resolve(result)
    }

    unsubscribe = port.subscribeOsc((sequence) => {
      const parsed = parseOsc11Response(sequence)
      if (parsed) finish(parsed)
    })
    timeout = setTimeout(() => finish(null), Math.max(0, timeoutMs))
    try {
      port.write(OSC11_QUERY)
    } catch {
      finish(null)
    }
  })
}

function normalizeOscComponent(component: string): number | null {
  const value = Number.parseInt(component, 16)
  if (!Number.isFinite(value)) return null
  const maximum = 2 ** (component.length * 4) - 1
  return Math.floor((value * 0xffff) / maximum)
}

function notificationTheme(sequence: string): FxnkTheme | null {
  if (sequence === DARK_NOTIFICATION) return "dark"
  if (sequence === LIGHT_NOTIFICATION) return "light"
  return null
}

function isPrimaryDeviceAttributes(sequence: string): boolean {
  return (
    sequence.startsWith(PRIMARY_DEVICE_ATTRIBUTES_PREFIX) &&
    /^[0-9]+(?:;[0-9]+)*c$/u.test(sequence.slice(PRIMARY_DEVICE_ATTRIBUTES_PREFIX.length))
  )
}
