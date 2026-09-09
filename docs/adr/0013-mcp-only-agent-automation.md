# MCP is the only agent automation surface

Superseded by
[ADR 0015](0015-a-socket-is-the-whole-control-surface.md), which replaces MCP
with one socket API.

smolmux removes its automation CLI and makes the separate stdio `smolmux-mcp`
executable the only supported agent-facing interface, superseding the client
choices in ADRs [0002](0002-control-socket-beside-ade-feed.md), [0010](0010-runtime-bus-events.md), and [0011](0011-one-duplex-runtime-bus.md). MCP exposes Orientation, Agent creation
and focus, Tray configuration, and Fx-native snapshot, queue, steer, interrupt,
queued-work update/delete, and queue-resume operations.

Prompt paste/send, waiting, observation streams, catalog and key inspection,
permission or question answers, queue reorder/arbitrary-start/clear, and
subagent, Fx Conversation, or Runtime lifecycle control remain absent. The internal
Runtime bridge carries one MCP request per connection, while authenticated
per-Agent Work control mirrors Fx's semantic authority instead of emulating it
through terminal input.
