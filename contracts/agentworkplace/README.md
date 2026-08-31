# AgentWorkplace-facing fmx contracts

This directory is the canonical fmx owner for the Phase 0 contract fixtures.
They freeze data and wire behavior for later implementation; loading them does
not start fmx, Fx, a Runtime extension, an Agent, or a Worktree.

All four families are schema version 1:

| Canonical fixture | Schema identity | Boundary |
| --- | --- | --- |
| `v1/runtime-extension.jsonl` | `fmx.runtime-extension` | fmx Session association, correlated initialization/readiness, authoritative Agent snapshot success/failure, present/focus, and publish/action/clear for the single-action unavailable-slot card |
| `v1/agent-defaults.jsonl` | `fmx.agent-defaults` | exact fmx Session selectors and field-by-field state-directory/model/effort precedence |
| `v1/ensure-lifecycle.jsonl` | `fmx.ensure-lifecycle` | immutable ensure/end/cleanup identities and digests, partial effects, exact ended-or-never-started Agent proof, independent Git cleanup, and exact receipt acknowledgements |
| `v1/fx-launch-admission-final.jsonl` | `fx.launch-admission-final` | Fx/fxnk-owned Fx Conversation launch, resolved role-neutral model/effort plus an opaque digest for remaining existing launch controls, keyed admission or cancellation, and retained final receipt; fmx is a consumer of these exact bytes |

`v1/manifest.json` is the digest and byte-count authority. Verify or print the
complete receipt with:

```sh
bun scripts/check-agentworkplace-contracts.ts
```

Each JSONL line is one envelope: UTF-8 without a BOM,
UTF-16-code-unit-sorted object keys, canonical number and string spellings, no
insignificant whitespace, and one LF terminator. The future extension wire
adds a four-byte big-endian payload length and rejects empty payloads or any
payload over 1 MiB; stream finalization rejects a partial header or payload at
EOF. The decoder rejects invalid UTF-8/JSON, duplicate keys,
unsupported identities or versions, precision-collapsing number spellings,
missing/incompatible fields, and unknown fields. Additive data is deliberate and narrow: readiness may advertise
additional safe-token capabilities, snapshot Agents may carry a bounded
`extensions` object, and bounded error details may do the same. Unknown fields
elsewhere turn a typo into policy and are errors.

Paths are normalized, bounded absolute paths and never the filesystem root;
the planned Worktree must differ from its repository. Filesystem existence,
realpath, Git ownership, and symlink revalidation remain Phase 1C behavior.

The checker recomputes immutable ensure, end, cleanup, and Fx launch digests
from each canonical request's immutable fields, excluding its transport
request id and its own digest field. Every receipt digest is SHA-256 over
the canonical envelope with only its `receipt_digest` field omitted; its
acknowledgement must repeat both the exact receipt id and digest. Manifest file
digests cover the complete committed JSONL bytes, including each record's LF.
The command above prints a machine-readable verification receipt containing
all fixture paths, byte counts, digests, and the manifest digest.

After this adapter is committed, an integration owner can run the complete
fmx gate and materialize a disposable canonical AgentWorkplace provider bundle
without copying editable fmx fixtures into the consumer repository:

```sh
bun run contracts:provider -- \
  --output /path/to/existing-empty-directory \
  --agentworkplace-manifest /path/to/phase0-owned-manifest.json
```

The generator requires the invoking fmx Worktree's index, tracked bytes,
executable modes, and ordinary index flags to match one committed `HEAD` tree.
It removes every inherited `GIT_*` variable, then reinstates only hermetic
controls: replacement objects and system attributes are disabled, system
configuration is disabled, and the global/system configuration paths are
`/dev/null`. It repeats the complete repository check after the gate and before
publication. The gate runs in a private detached materialization of that exact
commit, not against mutable Worktree bytes. Its real status and exact 18
environment-gated general-suite skips are captured there; the materialization
is checked again after the gate. Because the canonical install runs `bun link`,
the generator restores a link that points into the materialization to the
verified invoking Worktree before removing the private source and records that
effect.

The output must be one existing empty nonsymlink directory outside fmx's common
Git directory and every registered fmx Worktree. Its physical directory and
parent identities are pinned before the gate and rechecked afterward. The
complete bundle is first written in a mode-0700 private sibling stage with
exclusive, no-follow mode-0600 files and verified as one exact recursive
inventory. Publication preserves the caller's output-directory identity,
creates every destination exclusively without following a final symlink, and
repeats identity, content, mode, digest, and inventory verification. A failure
removes only entries whose recorded filesystem identities prove the generator
created them.

The four owner fixtures remain byte-for-byte copies beside the provider
manifest because provider artifacts are bundle-relative. The Runtime and
Fx-facing ids are translated only at this boundary; the canonical owner ids,
bytes, skip inventory, package/consume facts, and provider-manifest v1 shape
remain unchanged. `local-gate.log` retains the gate's exact combined output
bytes through one shared output descriptor. The separate canonical
`generation-evidence.json` binds that log, the exact gate cwd/argv/status,
commit and tree, consumed and owner-manifest digests, generator digest, and all
non-receipt output bytes. Its own digest is reported by the CLI rather than
self-recorded. These two sidecars are receipt inputs, not provider-manifest v1
artifacts or a claim that complete cross-repository Phase 0 acceptance passed.

The generated manifest names the exact committed SHA after the gate, so it
intentionally lives outside the commit it identifies and avoids a
self-referential Git SHA. A command that cannot start publishes no manifest and
does not invent an exit status. The CLI's `accepted` result means only that this
provider's real gate status and skip inventory were acceptable.

The lifecycle golden traces cover both an admitted Agent with exact Companion
exit proof and a durably cancelled partial launch with no Fx Conversation,
authoritative never-started proof, and independent Worktree cleanup. Absence,
timeout, refusal, or unreachable state is never end proof.

The product vocabulary in these fixtures is **fmx Session**, **Agent list**,
and **Fx Conversation**. Compatibility fields elsewhere in fmx may remain
`session_id`, and internal source names such as `FmxHome` and `SessionList`
remain deliberately unchanged.

Fixture identities, fmx Session names, placements, and slots are intentionally
opaque and role-neutral. These contracts contain no Workplace roles or
permissions, personal topology, live configuration, Runtime-extension process,
Agent-default resolution, ensure/end/cleanup effects, or Fx admission behavior.
Those belong to their later implementation phases and owning repositories.
