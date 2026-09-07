# Local ownership and foreground hosts

The same Runtime can render headlessly in a Companion PTY or directly in a foreground terminal, with both using the validated socket API. A Runtime-bound native local PTY helper manages the command's POSIX session through inherited pipes, so ordinary shell job-control groups stop or pause together and Runtime death ends local Sessions even when paused; daemonized or privileged escapes are outside this portable guarantee.

Foreground loss releases Companion Sessions and ends locals, while instance.stop confirms termination of both owners. No local declarations persist, no second service or manifest is introduced, and the Companion wire version remains unchanged; this supersedes the headless-only and Companion-only production transport decisions.
