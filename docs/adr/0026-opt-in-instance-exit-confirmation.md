# Opt-in Instance exit confirmation

Status review 2026-09-13: partially superseded. [ADR 0031](0031-one-observable-stop-operation.md)
defines the operation started by the confirmed second Ctrl+C and its stopping
surface. The opt-in two-press gesture and three-second window remain here.

Controllers may reserve physical Ctrl+C through `instance.configure` for a three-second two-press `instance.stop`, terminating all local and Companion Sessions together; ordinary smolmux keeps passing Ctrl+C to the focused App by default. The Runtime owns the confirmation across Clients because it owns both the Stage and termination, and paints a centered single-row overlay without changing Layout, Revision, Focus or Session size. This Runtime-local policy resets on restart, and targeted `app.input` remains independent of physical keyboard policy.
