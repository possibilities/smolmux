import { RGBA, type OptimizedBuffer, TextAttributes } from "@opentui/core"
import type { Capture } from "./protocol.ts"

export const MAX_CAPTURE_ANSI_BYTES = 512 * 1024
export const MAX_STYLED_CAPTURE_BYTES = 3 * 1024 * 1024

/** Leave ample envelope/queue headroom below the socket's 4 MiB frame bound. */
export function boundStyledCapture(capture: Capture): Capture {
  if (capture.ansi && Buffer.byteLength(JSON.stringify(capture)) > MAX_STYLED_CAPTURE_BYTES) delete capture.ansi
  return capture
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const sgr = (value: string) => `\x1b[${value}m`

function color(value: RGBA, foreground: boolean): string {
  if (value.intent === "default" || value.a === 0) return foreground ? "39" : "49"
  const prefix = foreground ? "38" : "48"
  if (value.intent === "indexed") return `${prefix};5;${value.slot}`
  return `${prefix};2;${value.toInts().slice(0, 3).join(";")}`
}

/** Serialize the composed viewport, never the terminal's input/output stream. */
export function captureAnsi(buffer: OptimizedBuffer): string[] | undefined {
  const { char, fg, bg, attributes } = buffer.buffers
  const text = new TextDecoder().decode(buffer.getRealCharBytes(true)).split("\n")
  const rows: string[] = []
  let encodedBytes = 2
  for (let y = 0; y < buffer.height; y++) {
    const clusters = graphemes.segment(text[y] ?? "")[Symbol.iterator]()
    let row = "", previous = -1
    for (let x = 0; x < buffer.width; x++) {
      const index = y * buffer.width + x
      // The trailing cell of a wide glyph is already occupied by its head.
      if ((char[index]! >>> 30) === 3) continue
      const flags = attributes[index]! & 255
      const same = previous >= 0 && flags === (attributes[previous]! & 255) && [0, 1, 2, 3].every(channel =>
        fg[index * 4 + channel] === fg[previous * 4 + channel] && bg[index * 4 + channel] === bg[previous * 4 + channel])
      if (!same) {
        const codes = ["0", color(RGBA.fromArray(fg.subarray(index * 4, index * 4 + 4)), true),
          color(RGBA.fromArray(bg.subarray(index * 4, index * 4 + 4)), false)]
        for (const [flag, code] of [
        [TextAttributes.BOLD, "1"], [TextAttributes.DIM, "2"], [TextAttributes.ITALIC, "3"],
        [TextAttributes.UNDERLINE, "4"], [TextAttributes.BLINK, "5"], [TextAttributes.INVERSE, "7"],
        [TextAttributes.HIDDEN, "8"], [TextAttributes.STRIKETHROUGH, "9"],
        ] as const) if (flags & flag) codes.push(code)
        row += sgr(codes.join(";"))
      }
      previous = index
      // Only our SGR sequences may introduce terminal controls into a Capture.
      row += (clusters.next().value?.segment ?? " ").replace(/[\x00-\x1f\x7f-\x9f]/gu, " ")
      if (row.length > MAX_CAPTURE_ANSI_BYTES) return undefined
    }
    rows.push(`${row}${sgr("0")}`)
    encodedBytes += Buffer.byteLength(JSON.stringify(rows.at(-1))) + 1
    if (encodedBytes > MAX_CAPTURE_ANSI_BYTES) return undefined
  }
  return rows
}
