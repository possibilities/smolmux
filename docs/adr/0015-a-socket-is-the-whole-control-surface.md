# A socket is the whole control surface

One clause below is superseded by
[ADR 0021](0021-input-is-part-of-the-control-surface.md): the socket now
carries `session.input`. Everything else here still holds, and the original
words are left as they were written.

Supersedes [ADR 0013](0013-mcp-only-agent-automation.md), and with it the
client choices of [the control socket beside the ADE
feed](0002-control-socket-beside-ade-feed.md),
[ADR 0010](0010-runtime-bus-events.md), and
[ADR 0011](0011-one-duplex-runtime-bus.md). References name the complete file; the [identifier history](README.md#identifier-history) records the former number collisions.

Everything past `start`, `stop`, and `attach` is one duplex, mode-0600 Unix
socket per Instance carrying newline-delimited JSON. Nine methods and six
events cover the whole surface: the roster, the Layout, capture, and the
Instance's own lifecycle. The contract is one table in `src/protocol.ts`,
validated by the Runtime, printed by `smolmux api`, and described in
`docs/api.md`, with a test that fails when they drift.

MCP is gone from smolmux. It was the right shape when smolmux served one kind of
agent and the caller was that agent; it is the wrong shape now that the
caller is a program that owns a surface. Whoever drives smolmux can be an MCP
server, and the tool that does — agentmux — already is one.

The socket carries no way to type into a Session, no byte-level observation,
and no notion of what a Session is for. Input is the human's at the keyboard
or the Session's own channels; reading a screen is `session.changed` plus
`session.capture`; and a Pane shows a Session or a line of text and knows
nothing else about it.

The cost is that everything a human might want beyond typing at the focused
Session has to be built into the API first, and that smolmux alone is not usable
as an agent surface. That is the point: smolmux is the multiplexer, and the
surface is somebody else's.
