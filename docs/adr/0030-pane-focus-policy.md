# 0030: Pane Focus policy

Identifier corrected 2026-09-08: formerly `0025-pane-focus-policy.md`. The old number
was shared by another decision; this record retains its original rationale.
See the [identifier history](README.md#identifier-history).

Physical left mouse-down takes Focus by default; App leaves may restrict it to API control (`focusMode: "api"`) or refuse keyboard Focus (`"never"`). This supersedes the API-only Focus rule, including the rationale in [ADR 0021](0021-input-is-part-of-the-control-surface.md), while Stage remains the sole authority and targeted `app.input` never changes Focus.

A click that changes Focus advances the Layout Revision and publishes `layout.changed` with cause `focus`, so a caller using a revision cannot silently undo it; no fit or Visibility policy runs. Existing callers requiring exclusive control must explicitly choose `api`.
