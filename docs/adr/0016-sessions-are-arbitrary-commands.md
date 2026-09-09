# A Session is any command, and smolmux knows nothing about it

Status review 2026-09-08: partially superseded.
[ADR 0024](0024-app-declarations-own-process-policy.md) makes Apps the stable declarations and [ADR 0025](0025-local-ownership-and-foreground-hosts.md) adds local PTYs. Arbitrary commands and caller-owned harness meaning remain.

Supersedes [ADR 0005](0005-agent-tray-vocabulary.md),
[ADR 0006](0006-native-session-names-over-ade.md),
[ADR 0008](0008-ade-only-fx-lifecycle.md), and
[ADR 0009](0009-pinned-private-fx-install.md).

A Session is an argv, a directory, and an environment, exec'd in a
Companion-held PTY under a caller-chosen name. Smolmux starts it, renders it,
sizes it, captures it, and reports when it ends. It does not know what it is,
what it is doing, or whether it needs a human.

Everything that made smolmux an fx multiplexer is removed: the ADE lifecycle
feed, semantic work control, the subagent registry, native conversation
names, the Agent list and its state glyphs, the picker, Projects, Worktrees,
and the pinned private Fx build. About 7,300 lines, and roughly the same
again in tests.

Lifecycle detection is a real capability and it does not disappear — it moves
to whoever owns the surface, reading screens through `session.capture` the
way agentmux already reads them through tmux's. That is a worse signal than
fx's own event feed and a better boundary: one reader for every harness,
owned by the program that knows what a harness is, rather than one channel
smolmux can only have with one of them.

The costs are named: fx's exact lifecycle states are no longer available to
anything smolmux renders, and a caller that wants them must ask fx directly. Smolmux
gains every other program in exchange.
