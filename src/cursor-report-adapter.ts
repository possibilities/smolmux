const ESC = 0x1b
const LEFT_BRACKET = 0x5b
const QUESTION_MARK = 0x3f
const SIX = 0x36
const DSR_FINAL = 0x6e
const CPR_FINAL = 0x52

const PRIVATE_CURSOR_REPORT_REQUEST = Uint8Array.of(ESC, LEFT_BRACKET, QUESTION_MARK, SIX, DSR_FINAL)
const STANDARD_CURSOR_REPORT_REQUEST = Uint8Array.of(ESC, LEFT_BRACKET, SIX, DSR_FINAL)

/**
 * OpenTUI 0.5.6's embedded Ghostty terminal supports ANSI CPR queries (CSI 6 n)
 * but not DEC private CPR queries (CSI ? 6 n). fx uses the private form so its
 * resize probes cannot be confused with user input. Translate only that query
 * at the emulator boundary, then restore the private marker on the generated
 * response before it reaches fx.
 */
export class CursorReportAdapter {
  private requestPrefix: number[] = []
  private privateResponsesPending = 0

  /**
   * Every byte fx writes passes through here, including the whole scrollback
   * a restore replays, so the common case — a chunk with no escape in it and
   * no partial request carried in — hands back the same bytes untouched, and
   * the rest copies escape-free runs whole rather than a byte at a time.
   */
  toTerminal(bytes: Uint8Array): Uint8Array {
    if (this.requestPrefix.length === 0 && !bytes.includes(ESC)) return bytes

    // A request carried in from the last chunk can be flushed ahead of these
    // bytes; a match only ever shortens, so this is the widest it can be.
    const output = new Uint8Array(bytes.byteLength + PRIVATE_CURSOR_REPORT_REQUEST.length)
    let written = 0
    let offset = 0
    while (offset < bytes.byteLength) {
      if (this.requestPrefix.length === 0) {
        const escape = bytes.indexOf(ESC, offset)
        const end = escape === -1 ? bytes.byteLength : escape
        if (end > offset) {
          output.set(bytes.subarray(offset, end), written)
          written += end - offset
          offset = end
          continue
        }
      }
      written = this.consumeRequestByte(bytes[offset]!, output, written)
      offset += 1
    }
    return output.subarray(0, written)
  }

  toPty(bytes: Uint8Array): Uint8Array {
    bytes = withoutInBandResize(bytes)
    if (this.privateResponsesPending === 0 || bytes.byteLength === 0) return bytes

    const output: number[] = []
    let offset = 0
    let changed = false
    while (offset < bytes.byteLength) {
      const end = this.privateResponsesPending > 0 ? cursorPositionReportEnd(bytes, offset) : -1
      if (end === -1) {
        output.push(bytes[offset]!)
        offset += 1
        continue
      }

      output.push(ESC, LEFT_BRACKET, QUESTION_MARK)
      for (let index = offset + 2; index < end; index += 1) output.push(bytes[index]!)
      this.privateResponsesPending -= 1
      offset = end
      changed = true
    }
    return changed ? Uint8Array.from(output) : bytes
  }

  flushTerminalBytes(): Uint8Array {
    const bytes = Uint8Array.from(this.requestPrefix)
    this.requestPrefix = []
    return bytes
  }

  /** Returns the new write position in `output`. */
  private consumeRequestByte(byte: number, output: Uint8Array, written: number): number {
    if (this.requestPrefix.length === 0) {
      if (byte === ESC) this.requestPrefix.push(byte)
      else output[written++] = byte
      return written
    }

    if (byte === PRIVATE_CURSOR_REPORT_REQUEST[this.requestPrefix.length]) {
      this.requestPrefix.push(byte)
      if (this.requestPrefix.length === PRIVATE_CURSOR_REPORT_REQUEST.length) {
        output.set(STANDARD_CURSOR_REPORT_REQUEST, written)
        written += STANDARD_CURSOR_REPORT_REQUEST.length
        this.requestPrefix = []
        this.privateResponsesPending += 1
      }
      return written
    }

    for (const held of this.requestPrefix) output[written++] = held
    this.requestPrefix = []
    if (byte === ESC) this.requestPrefix.push(byte)
    else output[written++] = byte
    return written
  }
}

function cursorPositionReportEnd(bytes: Uint8Array, offset: number): number {
  if (bytes[offset] !== ESC || bytes[offset + 1] !== LEFT_BRACKET) return -1

  let index = offset + 2
  const rowStart = index
  while (isAsciiDigit(bytes[index])) index += 1
  if (index === rowStart || bytes[index] !== 0x3b) return -1

  index += 1
  const columnStart = index
  while (isAsciiDigit(bytes[index])) index += 1
  if (index === columnStart || bytes[index] !== CPR_FINAL) return -1
  return index + 1
}

function isAsciiDigit(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x30 && byte <= 0x39
}

/**
 * Ghostty advertises mode 2048, but this embedding delivers resize through the
 * PTY, not CSI 48 reports. Refuse the mode so TUIs keep using SIGWINCH. Emulator
 * responses arrive whole (possibly coalesced); only generated replies use this
 * path, never typed input or process output.
 */
function withoutInBandResize(bytes: Uint8Array): Uint8Array {
  let result = bytes
  const prefix = [ESC, LEFT_BRACKET, QUESTION_MARK, 0x32, 0x30, 0x34, 0x38, 0x3b]
  for (let offset = 0; offset + 10 < bytes.length; offset += 1) {
    if (bytes[offset] !== ESC || !prefix.every((byte, index) => bytes[offset + index] === byte)) continue
    if (bytes[offset + 8]! < 0x31 || bytes[offset + 8]! > 0x34 || bytes[offset + 9] !== 0x24 || bytes[offset + 10] !== 0x79) continue
    if (result === bytes) result = Uint8Array.from(bytes)
    result[offset + 8] = 0x30
  }
  return result
}
