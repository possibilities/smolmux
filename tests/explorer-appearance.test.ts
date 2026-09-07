import { expect, test } from "bun:test"
import { parseGhosttyAppearance } from "../examples/explorer/ghostty-config.ts"
import { adjustMetric } from "../examples/explorer/appearance.ts"

test("resolved Ghostty appearance imports terminal settings without exposing commands or bindings", () => {
  const appearance = parseGhosttyAppearance(`font-family = GeistMono Nerd Font
font-size = 20
theme = Ultra Dark
background = #000000
foreground = #ffffff
palette = 4=#82aaff
cursor-style = bar
adjust-cell-height = 10%
adjust-cell-width = -1
command = private-command
keybind = super+a=private-action
config-file = /private/config`)
  expect(appearance).toMatchObject({ source: "Ghostty", fontFamily: "GeistMono Nerd Font", fontSize: 20,
    theme: "Ultra Dark", background: "#000000", foreground: "#ffffff", cursorStyle: "bar" })
  expect(appearance.fontFamilyBold).toBe(appearance.fontFamily)
  expect(appearance.palette[4]).toBe("#82aaff")
  expect(adjustMetric(20, appearance.cellHeight)).toBe(22)
  expect(adjustMetric(10, appearance.cellWidth)).toBe(9)
  expect(JSON.stringify(appearance)).not.toContain("private")
})

test("invalid appearance values cannot become CSS, terminal controls, or unbounded font sizes", () => {
  const appearance = parseGhosttyAppearance("font-size = 100000\nforeground = url(https://example.invalid)\npalette = 999=#ffffff\nadjust-cell-height = 999vh")
  expect(appearance.fontSize).toBe(13)
  expect(appearance.foreground).toBe("#e5e9ed")
  expect(appearance.palette).toHaveLength(256)
  expect(appearance.cellHeight).toBe("")
})
