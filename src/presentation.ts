const PRESENTATION_PREFIX = "\x1b]777;smolmux-present="
const PRESENTATION_SUFFIX = "\x1b\\"

/** Private terminal marker: every Client consumes it; only the matching new Client opens on it. */
export function presentationMarker(token: string): string {
  return `${PRESENTATION_PREFIX}${token}${PRESENTATION_SUFFIX}`
}

export const PRESENTATION_MARKER_PREFIX = Buffer.from(PRESENTATION_PREFIX)
export const PRESENTATION_MARKER_LENGTH = PRESENTATION_MARKER_PREFIX.byteLength + 36 + 2

export function readPresentationMarker(bytes: Uint8Array): string | null {
  if (bytes.byteLength !== PRESENTATION_MARKER_LENGTH) return null
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (!buffer.subarray(0, PRESENTATION_MARKER_PREFIX.byteLength).equals(PRESENTATION_MARKER_PREFIX)) return null
  if (buffer.at(-2) !== 0x1b || buffer.at(-1) !== 0x5c) return null
  const token = buffer.subarray(PRESENTATION_MARKER_PREFIX.byteLength, -2).toString("ascii")
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(token) ? token : null
}
