# 0029: Agent state is a glyph and a weight, never a hue

Status review 2026-09-08: superseded for Agent/Tray state.
[ADR 0016](0016-sessions-are-arbitrary-commands.md) removes the Agent list and its state glyphs. The original Fx-specific design tradeoff below is historical; current terminal/theme behavior belongs to repository guidance.

Identifier corrected 2026-09-08: formerly `0007-state-by-glyph-not-hue.md`. The old number
was shared by another decision; this record retains its original rationale.
See the [identifier history](README.md#identifier-history).

smolmux paints every surface of its own from fx's fixed indexed dark or light ramp (`fxnkRamp`), and the tray's status icons and dialog labels do not carry state in color: blocked is bold in the foreground, done is the accent step, and working, idle, and unknown are dim. The five ANSI status hues read faster at a glance for a sighted human, but made smolmux a different instrument from the fx it embeds; fx's rule that everything semantic is one gray with the glyph carrying the state is the one design language the pair now shares, and it is colorblind-safe by construction. Focus (direct ANSI slot 4) and error (direct ANSI slot 1) are the only hues smolmux spends, each with exactly one job, and a surface fx never draws is recorded as a carve-out in fxnk's style guide rather than improvised.
