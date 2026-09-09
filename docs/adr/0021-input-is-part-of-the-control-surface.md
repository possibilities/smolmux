# Input is part of the control surface

Status review 2026-09-08: partially superseded.
[ADR 0030](0030-pane-focus-policy.md) replaces API-only Focus with explicit pane policy. Targeted input still does not move Focus.

Supersedes one clause of [ADR 0015](0015-a-socket-is-the-whole-control-surface.md):
that the socket carries no way to type into a Session. Everything else that
record decided still holds — one duplex socket past `start`, `stop` and
`attach`, no byte-level observation, no MCP, and a Pane that shows a Session or
a line of text and knows nothing else about it.

`session.input` delivers keys, typed text, a paste, and mouse to a named
Session. Events apply in order, and the batch is the unit of ordering.

The reason 0015 excluded input was that typing is the human's, and a program
that wants an agent to act should reach it through the agent's own channels
rather than by pretending to be a person at a keyboard. That reasoning survives
for agents. It does not survive for the thing agentmux actually needs, which is
for an agent to drive a Panel App — an ordinary terminal program with no
channel of its own, whose entire interface is a screen and a keyboard. Reading
that screen was already possible with `session.capture`. Half of an interface
is not an interface, and the missing half was forcing callers toward an
attached PTY, which is a worse boundary than an API: it is a real terminal a
test harness has to own, it cannot address a Session that is not focused, and
the obvious alternative — a second Companion client to inject with — silently
steals sizing ownership and resizes the Session out from under the Layout.

The contract is semantic, never bytes. A caller sends a key, a string, a paste
or a mouse action; the Session's own emulator encodes it for the modes that
Session turned on, because it is the only thing that knows them — it is already
parsing that Session's output to learn them. The encoded bytes then take the
path a human's keystroke takes, out through the terminal's own data callback to
the same transport. Nothing new writes to a PTY, and nothing attaches a second
client to the Companion.

Two properties are load-bearing and are tested rather than assumed. Mouse
coordinates are cells from the Session's own top-left corner, so a caller
addresses one screen and cannot reach past it; a Session no Pane shows has no
coordinates, and mouse on it is refused rather than guessed at. And input never
moves focus — a synthesized left button-down cannot take the keyboard, because
a Pane's `focus()` is already gated on the Stage's word, so `layout.apply`
remains the only thing that decides where the keyboard goes.

Keys, text and paste reach a Session whether or not a Pane shows it, which
follows from Sessions running off the Layout.

The cost is the one 0015 named as its point: smolmux alone was not usable as an
agent surface, and now it is closer to being one. Whoever holds the socket can
drive a Session as a human would. That is accepted deliberately, in exchange
for the Panel App requirement, and it is bounded by what the contract refuses
to carry: no bytes, no escape sequences, and no way to observe a Session except
the screen `session.capture` already returned.
