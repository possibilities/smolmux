// Cell-edge geometry keeps box drawing continuous regardless of a font's glyph bearings.
const junctions = [
  ["─│┌┐└┘├┤┬┴┼", 1], ["━┃┏┓┗┛┣┫┳┻╋", 2], ["═║╔╗╚╝╠╣╦╩╬", 3],
] as const
const arms = [[1,1,0,0], [0,0,1,1], [0,1,0,1], [1,0,0,1], [0,1,1,0], [1,0,1,0],
  [0,1,1,1], [1,0,1,1], [1,1,0,1], [1,1,1,0], [1,1,1,1]]
const boxes = new Map<number, { arms: number[]; weight: number; round?: boolean }>()
for (const [chars, weight] of junctions)
  Array.from(chars).forEach((char, index) => boxes.set(char.codePointAt(0)!, { arms: arms[index]!, weight }))
Array.from("╭╮╰╯").forEach((char, index) => boxes.set(char.codePointAt(0)!, { arms: arms[index + 2]!, weight: 1, round: true }))

export function drawTerminalGlyph(ctx: CanvasRenderingContext2D, code: number, x: number, y: number,
  width: number, height: number): boolean {
  const box = boxes.get(code)
  if (box) {
    const [left, right, up, down] = box.arms
    const cx = x + width / 2, cy = y + height / 2
    const stroke = Math.max(1, Math.round(width / 10)) * (box.weight === 2 ? 2 : 1)
    if (box.round) {
      const hx = left ? x : x + width, vy = up ? y : y + height
      ctx.strokeStyle = ctx.fillStyle
      ctx.lineWidth = stroke
      ctx.beginPath(); ctx.moveTo(hx, cy); ctx.quadraticCurveTo(cx, cy, cx, vy); ctx.stroke()
    } else {
      const offsets = box.weight === 3 ? [-stroke * 1.5, stroke * 1.5] : [0]
      for (const offset of offsets) {
        if (left) ctx.fillRect(x, cy + offset - stroke / 2, width / 2 + stroke / 2, stroke)
        if (right) ctx.fillRect(cx - stroke / 2, cy + offset - stroke / 2, width / 2 + stroke / 2, stroke)
        if (up) ctx.fillRect(cx + offset - stroke / 2, y, stroke, height / 2 + stroke / 2)
        if (down) ctx.fillRect(cx + offset - stroke / 2, cy - stroke / 2, stroke, height / 2 + stroke / 2)
      }
    }
    return true
  }
  if (code >= 0x2581 && code <= 0x2588) {
    const fraction = (code - 0x2580) / 8
    ctx.fillRect(x, y + height * (1 - fraction), width, height * fraction); return true
  }
  if (code >= 0x2589 && code <= 0x258f) {
    ctx.fillRect(x, y, width * (0x2590 - code) / 8, height); return true
  }
  if (code === 0x2580) { ctx.fillRect(x, y, width, height / 2); return true }
  if (code === 0x2590) { ctx.fillRect(x + width / 2, y, width / 2, height); return true }
  if (code >= 0x2591 && code <= 0x2593) {
    const alpha = ctx.globalAlpha; ctx.globalAlpha *= (code - 0x2590) / 4
    ctx.fillRect(x, y, width, height); ctx.globalAlpha = alpha; return true
  }
  return false
}
