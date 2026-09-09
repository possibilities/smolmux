# A Companion-held Runtime serves every terminal Client

Status review 2026-09-08: partially superseded.
[ADR 0017](0017-the-runtime-is-headless.md) replaces final-Client shutdown; [ADR 0025](0025-local-ownership-and-foreground-hosts.md) adds a foreground Runtime and local PTYs. Shared rendering and sizing ownership remain.

Its final-Client lifecycle is superseded by
[ADR 0017](0017-the-runtime-is-headless.md); the shared Runtime and the
sizing-owner rule this record establishes remain in force.

Each smolmux Session renders one shared UI inside a Companion-held Runtime PTY, and ordinary `smolmux` invocations attach as thin Clients, so the Companion's existing broadcast and resize path provides multi-client display without duplicating the renderer or inventing a UI-diff protocol. Sizing follows the most recently connected or interacting Client, and the Runtime uses the Companion's opt-in final-client lifecycle while Agents remain independently persistent.
