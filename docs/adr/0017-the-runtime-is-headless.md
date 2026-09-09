# The Runtime is headless, and its socket is the Instance singleton

Status review 2026-09-08: partially superseded.
[ADR 0025](0025-local-ownership-and-foreground-hosts.md) adds foreground hosting and local Session ownership. The headless mode and guarded API singleton remain.

Supersedes the final-Client lifecycle of [a Companion-held Runtime serves
every terminal Client](0007-companion-held-shared-runtime.md). The rest of
that record — one shared Runtime, and sizing that follows the most recently
interacting Client — remains in force.

A Runtime starts without a terminal, renders into its Companion-held PTY,
binds its API socket, and holds its Sessions whether or not anyone is
attached. It ends on `instance.stop`, a signal, or a crash — never because
the last Client detached. `smolmux start` is therefore a real verb: it returns
the socket path and nothing is waiting on a human.

That removes the bootstrap marker the old Runtime waited on before
constructing its renderer, which existed so the OSC 11 background query had a
terminal to answer. A headless Runtime asks nothing: it takes `SMOLMUX_THEME`,
then `COLORFGBG`, then dark, and the first Client samples its own terminal
before it relays anything and tells the Runtime with the same notification a
terminal would send. The existing live-theme path does the rest, atomically.

The API socket replaces the ADE feed as the Instance singleton. It is claimed
under a lock before anything is adopted, so two Runtimes can never hold the
same Sessions, and a request that arrives during adoption waits for it rather
than being told the Sessions do not exist.

The cost is that an Instance now outlives every terminal, so `smolmux stop` is
the way to end one and a forgotten Instance keeps its processes. That is what
a multiplexer a program drives has to do.
