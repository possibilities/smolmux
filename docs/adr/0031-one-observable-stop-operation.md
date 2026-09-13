# One observable stop operation

Amends [0025](0025-local-ownership-and-foreground-hosts.md) for explicit
Instance termination and [0026](0026-opt-in-instance-exit-confirmation.md) for
what the confirmed second Ctrl+C starts. Foreground terminal loss and signals
retain their host-specific cleanup semantics.

`instance.stop` is one completion-based operation. Its first caller seals App
declarations synchronously, publishes a random operation identity and phase,
runs bounded optional preparation, terminates every local and Companion
Session, verifies termination, and only then completes and closes the Runtime.
Concurrent API, CLI, and confirmed physical requests join the same attempt.

The API result verifies App Sessions, not the Runtime process that must remain
alive to write that result. External lifecycle owners capture status first and
use the public `smolmux/lifecycle` `waitForRuntimeExit` barrier afterward. It
derives the exact Companion namespace for a headless host, validates ownership
and PID, and waits for that record to exit; for a foreground host it waits for
the captured PID. It is bounded and observational: it never signals. The CLI
uses the same helper, so successful `smolmux stop` includes Runtime exit while
raw API callers can distinguish the two completion boundaries.

A failed termination stays sealed. The Runtime keeps its API and stopping
surface available, reports exact remaining Apps, and accepts a later stop as a
new attempt against those survivors. It never reopens process creation or
describes partial cleanup as success. A successful result can still carry a
preparation error, distinguishing cooperative cleanup failure from verified
terminal cleanup.

One API connection may register as an optional preparation participant. The
registration owns no lifetime beyond that connection. Each attempt waits no
more than its configured bound; explicit error, timeout, or disconnect is
recorded and terminal cleanup proceeds. The acknowledgement never recursively
stops the Instance. smolmux gives this mechanism no knowledge of what an App
runs.

The Runtime copies its last committed render buffer before process teardown.
That inert frame remains as context under one quiet status row while live
Session renderables disappear. Failure names remaining work and a retry; API
state continues to report actual Apps and Sessions. Completion restores the
terminal once, without an intentionally blank intermediate Layout.

The API envelope remains version 2. The methods, status field, result, and
event are additive within the guarded Instance socket, while package version
0.10.0 communicates the required Runtime capability. The Companion wire and
its termination deadlines do not change.
