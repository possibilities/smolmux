# The observatory is an API consumer

The 3D observatory lives in `examples/explorer` as a local browser application
that discovers private API sockets and observes the existing contract; its
loopback bridge and Three.js dependencies add no Runtime method, Client behavior
or CLI verb. Navigation preserves logical visibility, checks the Runtime lifetime
and Layout Revision, and refuses to squeeze out a shown App, because exploring
an Instance must not accidentally run another App's hidden policy. Terminal
content remains local and is read through UUID-guarded `app.capture`, including
when a Session has no fitted Pane.
