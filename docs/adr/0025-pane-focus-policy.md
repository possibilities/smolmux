# Pane Focus policy

Physical left mouse-down takes Focus by default; App leaves may restrict it to API control (`focusMode: "api"`) or refuse keyboard Focus (`"never"`). This supersedes the API-only Focus rule, including the rationale in ADR 0021, while Stage remains the sole authority and targeted `app.input` never changes Focus.

A click that changes Focus advances the Layout Revision and publishes `layout.changed` with cause `focus`, so a caller using a revision cannot silently undo it; no fit or Visibility policy runs. Existing callers requiring exclusive control must explicitly choose `api`.
