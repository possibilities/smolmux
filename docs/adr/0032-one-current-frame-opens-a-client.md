# One current frame opens a Client

A headless Runtime already renders at a fallback size and palette before a
physical terminal attaches. Companion Restore faithfully contains that stale
surface. Publishing it first, then resizing and recoloring, exposes several
internally valid frames that are wrong for the new Client.

The terminal Client samples its exact background before relaying Runtime output
and holds Restore behind a random presentation token. Its additive
`client.present` request carries the token, bounded physical size, and sampled
theme/background. The Runtime writes the token immediately before a
synchronized clear, applies the renderer size, theme and Layout in one
synchronous turn, forces a complete repaint, and resolves only after the first
resulting frame. The matching Client holds through that frame's synchronized
end, then releases reset, sanitized Restore and the complete fresh frame in one
write. Every other Client strips the private marker and continues normally.

Input, terminal protocol replies and API requests remain active while display
bytes are held. Completion waits for a frame with a fixed bound, rather than
renderer idle, because continuous App output may prevent idle forever. Every
attach performs the handshake even when size and theme match, so its token
cannot wait for a change that never comes. An Instance sealed for stop refuses
presentation like every other mutation.

This keeps Restore semantics and multi-client broadcast in the Companion while
making the first visible state truthful. It adds no timer-based reveal, loading
screen, Client-specific Runtime state, or Companion wire change. The API
envelope remains version 2; package version 0.11.0 communicates the new method.
