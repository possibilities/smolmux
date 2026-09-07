# smolmux observatory

A local 3D explorer for running smolmux Instances. The Stage unfolds into
terminal faces; hidden Apps occupy a separate arc below it. Select any App to
inspect its current Session, terminal Capture, hidden policy and observed output.

```sh
# From the repository root; requires Bun 1.4+.
bun install --frozen-lockfile
bun run explorer
```

Open the **full URL printed by the command**, including its fragment. The
explorer chooses an available loopback port by default. Pass `--port 7331` to
require a specific port instead. Ctrl+C ends only the explorer; it does not stop
or detach an Instance. The explorer runs on the same computer as smolmux and
requires a modern browser. All assets, including fonts, are bundled locally.

The Instance menu finds live sockets under `/tmp/smolmux-<uid>` across all
configuration directories, checking directory/socket ownership and the Instance
identity before connecting. Stale or incompatible sockets are ignored without
removing them. A single discovered Instance opens automatically; several open
the chooser. With none, the labeled demo opens. Its data and actions are entirely
in the browser, and never create or modify a real Instance.

## Explore

- Drag the scene to orbit; scroll or pinch to zoom; right-drag to pan.
  **Reset camera** returns to the overview. **Separation** controls the exploded
  depth. None of these controls changes the terminal Layout.
- **Spatial** shows the Stage footprint, separated terminal faces, and off-Stage
  Apps. **Stage** puts fitted Panes back at their Layout proportions. Hidden Apps
  remain inspectable below the Stage. Text Panes have labeled footprints.
- The App list supports keyboard selection, search and on-Stage/hidden filters.
  **Off Stage** means logically visible but without fitted cells; it is different
  from hidden. Paused, stopped, exited, failed and unreachable Apps remain listed.
- The faces fit the complete terminal grid, including its last column. The
  inspector fits the full width and reserves room for scrolling. **Expand
  terminal** offers an overview and your configured **Font size**, plus **Copy
  text**. Box drawing is drawn to cell edges so solid borders remain continuous.
- The inspector shows styled Captures. **Recent history** holds up to 200 plain-text
  preceding lines; **Return to live** resumes screen updates. An unreachable
  Session is explicitly labeled as its last known screen. A stopped or exited
  App with no Session has no retained Capture.
- **Observed output** counts `session.changed` notifications received during the
  last 30 seconds. It is not CPU, memory, progress, or proof that a process is
  working. The history starts when this explorer connects.
- **Focus on Stage** preserves the tree, sizes and complete visibility set.
  **Reveal beside the Layout** wraps the existing tree beside a new App leaf and
  adds logical visibility. Existing visible Apps stay visible; the newly visible
  App follows its declared hidden policy. It can resume a paused Session or
  start a stopped App. Natural exits are not automatically restarted.

Navigation checks the current Runtime lifetime and Layout Revision before
applying, and sends that Revision to the Runtime. It refuses a changed Layout,
a `never` Focus policy, a missing App, or a reveal that cannot fit without
squeezing out an existing shown App. A fitted Pane with no cells must be brought
back by enlarging the terminal or its owning application. There is no process
termination, restart, arbitrary input, or solo/hide action in this example.

## Connection and rendering

`serve.ts` builds assets in memory and starts `bridge.ts` on `127.0.0.1`.
Discovery requires the per-launch capability in the printed URL; WebSocket
connections require that capability and an exact same-origin check. Host checks,
bounded messages/queues and an allowlist of explorer operations keep this from
being an unrestricted socket proxy. The explorer stores no terminal data on
disk and sends no data to a hosted service. Treat the full URL as local access
to your terminals; it is not a public sharing link.

Each browser connection observes one Instance through `ApiClient.observe`.
Transient output events mark Captures dirty; requests drain in batches of four
after a 120 ms debounce, carrying Session UUIDs. Replacement and removal retire
old Captures. A lost connection clears observation; reconnect subscribes and
reads a new atomic projection. Invalidated projections are resnapshotted.
Navigation and history requests are not replayed after connection loss.
Output refreshes shown and hidden terminals; bursts coalesce before Capture and
again at the next animation frame. The latest screen replaces the previous one
without resetting the camera or App selection. History is deliberately held
until **Return to live**; the 3D faces continue observing live output.

Three.js supplies the camera, Stage structure and physical depth. CSS 3D faces
hold canvases rendered from Ghostty's WebAssembly VT engine. The terminal keeps
its original cell dimensions and scales into the face without resizing the
Session. SGR-styled viewport rows preserve indexed/default colors and attributes;
older running Runtimes and Captures above the styled byte budget provide plain
text instead. New Runtimes supply styles after updating smolmux; the explorer
never restarts a running Instance. Accessible text accompanies every canvas.
The 3D view has
a keyboard-accessible list and inspector, responds to narrow screens, honors
reduced motion, caps pixel density and frame rate, and stops drawing when the
browser page is hidden. Without WebGL, the CSS 3D terminal faces and all controls
still work. Very large rosters can make the scene dense; use search and the
inspector to navigate them.

At launch, Ghostty's `+show-config --changes-only=false` resolves its own config
files, themes and overrides. Only appearance fields reach the browser: regular,
bold and italic font families, point size, foreground/background, palette, cursor
colors/shape, and cell width/height/baseline adjustments. Fonts are used from this
computer with bundled IBM Plex Mono as fallback. No Ghostty settings are modified.
Restart the explorer after changing Ghostty settings. **Appearance** chooses
Ghostty (the default), system, light or dark for the surrounding UI; terminal
colors stay faithful to the terminal settings. The browser remembers that choice
for the current origin. Native window effects, custom shaders, font features and
cursor animations are not replicated by the browser renderer.

The explorer is an example application, not a smolmux Client: it does not attach
a physical terminal or become the sizing owner. Its private browser messages
live in `wire.ts`; smolmux's public contract remains in `src/protocol.ts`.

## Verify

```sh
bun run typecheck
bun test tests/explorer.test.ts
bun run explorer:build
bun run explorer:check
scripts/local-gate.sh
```

The browser check uses one ephemeral, headless Chrome profile and a socket
fixture with no PTYs. On macOS it uses installed Google Chrome; elsewhere run
`bunx playwright install chromium` first, or set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. It checks live discovery, hidden/paused
Captures, history, guarded navigation, demo isolation, filtering, responsive
layout and reconnects, and writes visual evidence under the private smolmux
temporary directory. It closes its browser and sockets in `finally`.
