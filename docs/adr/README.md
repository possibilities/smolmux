# smolmux decision log

Read the relevant records before changing a boundary they explain. Current
implementation and procedures live in the repository's guidance and architecture
documents; an old record preserves why an earlier choice was made.

“Recorded” means the original record did not declare an acceptance status.
It does not invent an approval date or promise that every implementation detail
remains current. Explicit supersession below names the changed scope; the
record itself retains the original reasoning and replacement links. A dash adds
no status claim beyond the record; it does not certify every detail as current.

| Decision | Status | Replacement or current scope |
|---|---|---|
| [0001: Native release distribution](0001-native-release-distribution.md) | Superseded | [0028](0028-source-only-installation.md). |
| [0002: Control socket beside the ADE feed](0002-control-socket-beside-ade-feed.md) | Superseded | [0011](0011-one-duplex-runtime-bus.md), then [0013](0013-mcp-only-agent-automation.md) and [0015](0015-a-socket-is-the-whole-control-surface.md). |
| [0003: The companion is pinned, and the pair is the release](0003-companion-pinned-pair.md) | Partially superseded | [0028](0028-source-only-installation.md) replaces binary-release distribution. Exact Companion build identity remains required; “release” below describes the historical distribution and ordering rationale. |
| [0005: Agent and Tray are a forward-only vocabulary](0005-agent-tray-vocabulary.md) | Superseded | [0016](0016-sessions-are-arbitrary-commands.md) removes Agent vocabulary; [0018](0018-labels-are-the-record.md) removes the Manifest. |
| [0006: Native Fx Conversation names arrive over ADE](0006-native-session-names-over-ade.md) | Superseded | [0016](0016-sessions-are-arbitrary-commands.md). |
| [0007: A Companion-held Runtime serves every terminal Client](0007-companion-held-shared-runtime.md) | Partially superseded | [ADR 0017](0017-the-runtime-is-headless.md) replaces final-Client shutdown; [ADR 0025](0025-local-ownership-and-foreground-hosts.md) adds a foreground Runtime and local PTYs. Shared rendering and sizing ownership remain. |
| [0008: ADE is the only Fx lifecycle channel](0008-ade-only-fx-lifecycle.md) | Superseded | [0016](0016-sessions-are-arbitrary-commands.md). |
| [0009: smolmux installs a pinned private Fx](0009-pinned-private-fx-install.md) | Superseded | [0016](0016-sessions-are-arbitrary-commands.md). |
| [0010: Runtime observation events are removed](0010-runtime-bus-events.md) | Superseded | [0013](0013-mcp-only-agent-automation.md), then [0015](0015-a-socket-is-the-whole-control-surface.md). |
| [0011: The stable Runtime socket is a single-request bridge](0011-one-duplex-runtime-bus.md) | Superseded for the bridge/client mechanism | [0013](0013-mcp-only-agent-automation.md), then [0015](0015-a-socket-is-the-whole-control-surface.md). |
| [0012: smolmux Session files live in a private directory](0012-home-files-in-a-private-directory.md) | Partially superseded | [ADR 0016](0016-sessions-are-arbitrary-commands.md) removes ADE/Fx paths; [ADR 0017](0017-the-runtime-is-headless.md) makes the API socket the singleton. The private, owner-checked runtime-directory boundary remains. |
| [0013: MCP is the only agent automation surface](0013-mcp-only-agent-automation.md) | Superseded | [0015](0015-a-socket-is-the-whole-control-surface.md). |
| [0014: Names select independent smolmux Sessions with shared configuration](0014-independent-named-smolmux.md) | Partially superseded | [0018](0018-labels-are-the-record.md) removes persisted UI state; independent names remain. |
| [0015: A socket is the whole control surface](0015-a-socket-is-the-whole-control-surface.md) | Partially superseded | [0021](0021-input-is-part-of-the-control-surface.md) adds input; [0024](0024-app-declarations-own-process-policy.md) changes resource identity. The socket remains the control owner. |
| [0016: A Session is any command, and smolmux knows nothing about it](0016-sessions-are-arbitrary-commands.md) | Partially superseded | [ADR 0024](0024-app-declarations-own-process-policy.md) makes Apps the stable declarations and [ADR 0025](0025-local-ownership-and-foreground-hosts.md) adds local PTYs. Arbitrary commands and caller-owned harness meaning remain. |
| [0017: The Runtime is headless, and its socket is the Instance singleton](0017-the-runtime-is-headless.md) | Partially superseded | [ADR 0025](0025-local-ownership-and-foreground-hosts.md) adds foreground hosting and local Session ownership. The headless mode and guarded API singleton remain. |
| [0018: The Companion's labels are the record; smolmux stores nothing](0018-labels-are-the-record.md) | Partially superseded | [ADR 0024](0024-app-declarations-own-process-policy.md) replaces Session-only identity with Apps and UUID-identified executions; the caller still owns Layout and the Runtime gains no persistent manifest. |
| [0019: The Layout is one tree the caller owns, with a revision](0019-the-layout-is-a-tree-the-caller-owns.md) | Recorded | — |
| [0020: The program is called smolmux](0020-the-program-is-called-smolmux.md) | Recorded | — |
| [0021: Input is part of the control surface](0021-input-is-part-of-the-control-surface.md) | Partially superseded | [ADR 0030](0030-pane-focus-policy.md) replaces API-only Focus with explicit pane policy. Targeted input still does not move Focus. |
| [0022: A copy reaches every Client, and nothing is read back](0022-a-copy-reaches-every-client-and-nothing-is-read-back.md) | Recorded | — |
| [0023: One filtered event feed with an atomic projection](0023-one-filtered-event-feed-with-an-atomic-projection.md) | Accepted | — |
| [0024: App declarations own process policy](0024-app-declarations-own-process-policy.md) | Recorded | — |
| [0025: Local ownership and foreground hosts](0025-local-ownership-and-foreground-hosts.md) | Recorded | — |
| [0026: Opt-in Instance exit confirmation](0026-opt-in-instance-exit-confirmation.md) | Recorded | — |
| [0027: The observatory is an API consumer](0027-observatory-is-an-api-consumer.md) | Recorded | — |
| [0028: Source-only installation](0028-source-only-installation.md) | Partially superseded | Source-only distribution remains accepted. [ADR 0016](0016-sessions-are-arbitrary-commands.md) removes the pinned Fx build named below; the current source installer builds the pinned Companion and runs doctor. |
| [0029: Agent state is a glyph and a weight, never a hue](0029-state-by-glyph-not-hue.md) | Superseded for agent/tray state | [ADR 0016](0016-sessions-are-arbitrary-commands.md) removes the Agent list and its state glyphs. The original Fx-specific design tradeoff below is historical; current terminal/theme behavior belongs to repository guidance. |
| [0030: Pane Focus policy](0030-pane-focus-policy.md) | Recorded | — |

## Identifier history

Corrected 2026-09-08. Each old filename below identifies one specific record;
the old number alone was ambiguous. Existing record bodies were retained, with
updated references and explicit status annotations. Do not reuse retired
identifiers for unrelated decisions or renumber the rest of the log.

| Former file | Current record |
|---|---|
| `0002-source-only-installation.md` | [0028](0028-source-only-installation.md) |
| `0007-state-by-glyph-not-hue.md` | [0029](0029-state-by-glyph-not-hue.md) |
| `0025-pane-focus-policy.md` | [0030](0030-pane-focus-policy.md) |

New records take an unused identifier above the highest current number. Check
the landing branch before assigning it and coordinate shared ADR edits. Cite
complete relative file links; a title change must not redirect a citation to a
different decision. Keep this navigation index and the record's status together.
