import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { defaultAppearance, type TerminalAppearance } from "./appearance.ts"

/** Read Ghostty's resolved config: includes themes, includes, and platform overrides. */
export async function loadGhosttyAppearance(): Promise<TerminalAppearance> {
  const binary = Bun.which("ghostty") ?? (process.platform === "darwin" &&
    await Bun.file("/Applications/Ghostty.app/Contents/MacOS/ghostty").exists()
    ? "/Applications/Ghostty.app/Contents/MacOS/ghostty" : null)
  if (!binary) return { ...defaultAppearance, warning: "Ghostty was not found. Using the bundled terminal font." }
  try {
    const { stdout } = await promisify(execFile)(binary, ["+show-config", "--changes-only=false", "--no-pager"],
      { timeout: 3000, maxBuffer: 1024 * 1024 })
    return parseGhosttyAppearance(stdout)
  } catch {
    return { ...defaultAppearance, warning: "Ghostty appearance could not be read. Using the bundled terminal font." }
  }
}

export function parseGhosttyAppearance(config: string): TerminalAppearance {
  const result = structuredClone(defaultAppearance)
  result.source = "Ghostty"
  const fields = new Map<string, string>()
  for (const line of config.split("\n")) {
    const match = /^([a-z][a-z-]*)\s*=\s*(.*?)\s*$/u.exec(line)
    if (!match) continue
    const [, key, raw] = match
    const value = raw!.replace(/^"(.*)"$/u, "$1")
    if (key === "palette") {
      const entry = /^(\d+)=#?([a-f\d]{6})$/iu.exec(value)
      if (entry && Number(entry[1]) < 256) result.palette[Number(entry[1])] = `#${entry[2]}`
    } else fields.set(key!, value)
  }
  for (const [key, target] of [
    ["font-family", "fontFamily"], ["font-family-bold", "fontFamilyBold"],
    ["font-family-italic", "fontFamilyItalic"], ["font-family-bold-italic", "fontFamilyBoldItalic"], ["theme", "theme"],
  ] as const) if (fields.get(key)) result[target] = fields.get(key)!.slice(0, 200)
  for (const target of ["fontFamilyBold", "fontFamilyItalic", "fontFamilyBoldItalic"] as const)
    if (result[target] === defaultAppearance[target]) result[target] = result.fontFamily
  const size = Number(fields.get("font-size"))
  if (Number.isFinite(size) && size >= 4 && size <= 96) result.fontSize = size
  for (const [key, target] of [
    ["foreground", "foreground"], ["background", "background"], ["cursor-color", "cursorColor"],
    ["cursor-text", "cursorText"], ["selection-foreground", "selectionForeground"], ["selection-background", "selectionBackground"],
  ] as const) {
    const value = fields.get(key)?.replace(/^#/, "")
    if (value && /^[a-f\d]{6}$/iu.test(value)) result[target] = `#${value}`
  }
  const cursor = fields.get("cursor-style")
  if (cursor === "block" || cursor === "bar" || cursor === "underline") result.cursorStyle = cursor
  for (const [key, target] of [["adjust-cell-width", "cellWidth"], ["adjust-cell-height", "cellHeight"],
    ["adjust-font-baseline", "baseline"]] as const) {
    const value = fields.get(key)
    if (value && /^-?\d+(?:\.\d+)?%?$/u.test(value)) result[target] = value
  }
  return result
}
