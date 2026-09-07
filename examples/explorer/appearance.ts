/** Browser-safe appearance values; no Ghostty commands, bindings or paths cross the bridge. */
export type TerminalAppearance = {
  source: "Ghostty" | "Default"
  theme: string
  fontFamily: string
  fontFamilyBold: string
  fontFamilyItalic: string
  fontFamilyBoldItalic: string
  fontSize: number
  foreground: string
  background: string
  palette: string[]
  cursorColor: string
  cursorText: string
  cursorStyle: "block" | "bar" | "underline"
  selectionForeground: string
  selectionBackground: string
  cellWidth: string
  cellHeight: string
  baseline: string
  warning: string | null
}

export const defaultAppearance: TerminalAppearance = {
  source: "Default", theme: "Terminal", fontFamily: "IBM Plex Mono", fontFamilyBold: "IBM Plex Mono",
  fontFamilyItalic: "IBM Plex Mono", fontFamilyBoldItalic: "IBM Plex Mono", fontSize: 13,
  foreground: "#e5e9ed", background: "#101820", cursorColor: "#e5e9ed", cursorText: "#101820",
  cursorStyle: "block", selectionForeground: "#ffffff", selectionBackground: "#35526c",
  palette: ["#000000", "#cc5555", "#55cc55", "#cdcd55", "#5555cc", "#cc55cc", "#55cccc", "#cccccc",
    "#555555", "#ff5555", "#55ff55", "#ffff55", "#5555ff", "#ff55ff", "#55ffff", "#ffffff",
    ...Array.from({ length: 216 }, (_, i) => {
      const levels = [0, 95, 135, 175, 215, 255]
      return "#" + [levels[Math.floor(i / 36)]!, levels[Math.floor(i / 6) % 6]!, levels[i % 6]!]
        .map(n => n.toString(16).padStart(2, "0")).join("")
    }), ...Array.from({ length: 24 }, (_, i) => "#" + (8 + i * 10).toString(16).padStart(2, "0").repeat(3))],
  cellWidth: "", cellHeight: "", baseline: "", warning: null,
}

export const cssFont = (family: string) => `${JSON.stringify(family)}, "IBM Plex Mono", monospace`
export const rgb = (hex: string) => Number.parseInt(hex.replace("#", ""), 16)
export function isDark(hex: string): boolean {
  const n = rgb(hex)
  return ((n >> 16) * 0.2126 + ((n >> 8) & 255) * 0.7152 + (n & 255) * 0.0722) < 140
}

export function adjustMetric(base: number, adjustment: string): number {
  const amount = Number.parseFloat(adjustment)
  if (!Number.isFinite(amount)) return base
  return Math.max(1, base + (adjustment.endsWith("%") ? base * amount / 100 : amount))
}
