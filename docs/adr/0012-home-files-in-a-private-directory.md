# smolmux Session files live in a private directory

Status review 2026-09-08: partially superseded.
[ADR 0016](0016-sessions-are-arbitrary-commands.md) removes ADE/Fx paths; [ADR 0017](0017-the-runtime-is-headless.md) makes the API socket the singleton. The private, owner-checked runtime-directory boundary remains.

smolmux binds each smolmux Session's ADE socket, Runtime bridge, and singleton lock inside
`/tmp/smolmux-<uid>`, created 0700 and refused when it is not ours or is open to
others, rather than placing its own names directly in world-writable `/tmp`.
A Runtime unlinks its sockets when it exits, while Companion-held Fx processes
can outlive it; a name in `/tmp` could therefore be taken by another user and
receive lifecycle records whose Fx Conversation titles summarize prompt text.

Moving the sockets blacks out lifecycle for Agents that survive this upgrade,
because they retain the old paths they received at launch. They keep running
under the Companion and can be adopted, but their ADE records and Runtime-bridge
requests resume only after they are relaunched with the private-directory paths.
