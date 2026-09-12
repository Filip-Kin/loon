# Plan: block view, PCB view, code view, simulation

Written 2026-09-11. This is the build order for turning loon from a schematic
editor into the one-stop shop: design the blocks, draw the board, write the
firmware, simulate it, and order it, all against one document with the AI
driving every view.

The guiding rule stays the one from the roadmap: never limit the user, and there
is always a raw escape hatch at every level.

## 0. What a project becomes

Today a project is a single `.kicad_sch`. That cannot hold a PCB, firmware or a
simulation bench, so a project becomes a folder:

```
MyBoard/
  board.kicad_sch      KiCad interchange, unchanged
  board.kicad_pcb      KiCad interchange
  loon.json            what KiCad cannot express: blocks, ports, params, benches
  firmware/            platformio.ini or CMakeLists, src/, generated pins header
  fab/                 gerbers, drill, BOM, pick-and-place
```

KiCad files stay the source of truth for anything KiCad understands, so the
"open it in KiCad" promise survives. `loon.json` holds only the extra: the block
graph, module parameters, port-to-net mapping, simulation benches, and the
firmware pin map. Anything in `loon.json` must be *derivable or discardable* -
deleting it leaves a valid KiCad project, just without the block view.

Migration is free: blocks are already derivable from the `LoonBlock` provenance
stamped on every symbol (`shared/src/blocks.ts`).

## 1. Netlist engine first (blocks everything else)

Nothing below works without knowing what is connected to what. Today
connectivity is implicit in wire geometry and label text, and only the KiCad
export makes it real.

Build `shared/src/netlist.ts`:

- Union-find over wire endpoints, junctions, pin positions, labels (local,
  global, hierarchical) and power symbols.
- Output: `Net[] { name, pins: {ref, pin, libId}[], isPower }`, plus a
  `netOfPin(ref, pin)` index.
- Name resolution: explicit label wins, then power symbol, then an auto name.

It immediately pays for itself in three places:

- **ERC**: unconnected pins, two outputs driving one net, a power pin with no
  source, an input left floating. Run it after every AI edit and feed failures
  back into the assistant's context so it fixes its own mistakes.
- **AI context**: "what is GPIO4 connected to" becomes a fact, not a guess.
- **PCB and simulation**: both are functions of the netlist.

Also fold the pin budget (`shared/src/pinbudget.ts`) onto the netlist, which
replaces its coincidence-matching with real connectivity.

## 2. Block view

The cheapest big win, because the data already exists.

**Model.** Promote blocks from derived to first-class in `loon.json`:

```ts
interface BlockInstance {
  id: string;
  moduleId: string;
  params: Record<string, string | number>;
  at: { x: number; y: number };      // position on the block canvas
  ports: { name: string; dir: "in" | "out" | "power" | "bidir"; net: string }[];
  detached?: boolean;                 // hand-edited: never auto-regenerate
  memberUuids: string[];              // schematic symbols this block owns
}
```

**Ports.** `ModuleDef` gains a `ports` declaration next to `nets`, naming which
exposed nets are the block's interface and their direction. Modules already emit
nets; this is labelling which of them are public.

**The rule that keeps it honest.** Changing a parameter regenerates the block's
schematic subtree: delete its members, re-expand, re-join ports by net. If the
user edited inside the block by hand, the block is marked `detached` and is
never regenerated silently - loon offers a diff instead. Losing hand work to a
parameter change is the one failure that would make the block view untrustworthy.

**Canvas.** A second React SVG canvas, same pan/zoom code as the schematic:
rounded block boxes, ports on the edges, orthogonal links between ports, drag to
move, drag a port to a port to connect. Drill-in filters the schematic canvas to
one block's members (the group box already rendered today becomes the drill
target).

**AI ops.** Extend the op vocabulary the assistant already speaks:
`add_block`, `set_block_params`, `connect_ports`, `detach_block`. The assistant
then designs at the block level by default and drops to parts only when no
module fits - which is also how a person should use it.

## 3. Code view

The board knows its own pinout, so the firmware should not be retyped from it.

- **Generated pin map.** From the netlist plus the MCU profile
  (`shared/src/mcu.ts`), emit `firmware/include/board_pins.h` (and a matching
  `board_pins.py`): every net that lands on an MCU pin becomes a named constant,
  regenerated whenever the schematic changes. Rename a net, rebuild the header.
- **Editor.** CodeMirror 6 with a file tree over `firmware/`. Nothing clever.
- **AI.** Same bridge, different prompt: the netlist, the pin map and the block
  list go in as context, so "write the e-stop firmware" produces code that uses
  the right pins by name and respects the watchdog kick the hardware expects.
- **Build.** PlatformIO or ESP-IDF in a container on the NAS, invoked from the
  server, output streamed to the UI. One build per project, cached.
- **Flash from the browser.** WebSerial plus `esptool-js`: click Flash, pick the
  port, the board programs itself. This is what makes the USB-C port on the
  board worth having, and it closes the loop from prompt to running hardware
  without leaving the tab. Chromium only; say so rather than hiding it.
- Later: OTA over Wi-Fi for boards already in a robot.

## 4. PCB view

The biggest piece. Do it after the netlist, and do not pretend it is KiCad.

**Codec.** `shared/src/kicad-pcb.ts`, mirroring the schematic codec: parse to a
model, serialize back, and keep every node loon does not understand verbatim so
a file KiCad has touched round-trips without loss. The `libRaw` pattern from the
schematic codec is the precedent.

**Footprints.** Three sources, in order:

1. KiCad's own footprint library installed on the server and indexed by name
   (the `Footprint` property on every catalog part already names one). It is
   large; install it on the NAS, do not vendor it into the repo.
2. Generated footprints from a spec, the same trick `symbolgen.ts` uses for
   symbols: pad count, pitch, body size, thermal pad. Covers anything the
   library lacks.
3. A raw import path for a `.kicad_mod` the user drops in.

**Canvas.** Layers with visibility, pads, tracks, vias, zones, silkscreen, board
outline. Drag to place, ratsnest lines from the netlist, 45-degree track drawing,
live clearance checking against a rule set, and a copper pour that respects
clearance. This is weeks of work; it is also the part with no shortcut.

**AI in layout.** The assistant does the two things it is good at and leaves the
rest:

- **Placement.** Block-aware: parts of one block cluster together, decoupling
  goes next to its pin, the buck's loop area is kept small, connectors go to the
  edge. The block graph from view 2 gives it the grouping for free.
- **Rules and review.** Trace width from current (a 30A channel is not a signal
  trace), clearance from voltage, and a review pass that reads the layout back
  and complains about a hot loop or a star ground done wrong.

**Routing.** Autorouting is a research project and loon will not win it. Plan:
route power and high-current nets by hand with AI-suggested widths, then export
`.dsn` and hand signals to freerouting headless, importing the `.ses` back. If
that proves poor, the fallback is guided manual routing with push-and-shove left
out.

**Fab output.** Gerbers, drill, BOM and pick-and-place through `kicad-cli`, then
a fab bundle per house (OSH Park, JLCPCB). `kicad-cli` is not installed on the
home server yet - that is a prerequisite, not an afterthought.

## 5. Simulation

Two engines, different jobs. MCU first, as the roadmap says.

**Digital and firmware.** The question worth answering is "does my e-stop
actually stop the board", not "what does this transistor do". Build an
event-driven digital simulator over the netlist: drive inputs, propagate through
logic parts (the flip-flop, the gates, the high-side switch enables) with simple
per-part behaviour models, and step time. Firmware joins it by compiling
natively against a mock HAL, so the real e-stop code runs against the real
netlist. Benches live in `loon.json`: stimulus, expected output, assertions.

That gives regression tests for a board: "press e-stop 1 at t=100ms, assert every
switched channel is off within 10ms". The AI writes the benches from the design
intent it already has in context.

For full-fidelity ESP32 execution, Espressif's QEMU fork can run the real binary
later. It is not the first step.

**Analog.** ngspice as a subprocess. Needs a SPICE model or subcircuit per part,
so `PartSummary` gains a `spice` field, populated for the parts that matter
(regulators, FETs, diodes) and left empty elsewhere. Netlist to `.cir`, run,
plot the result on a waveform canvas shared with the probe debugger, so a
simulated trace and a measured trace can be overlaid. That overlay is the real
prize: it is how you find out which of your assumptions was wrong.

## Order of work

1. **Netlist + ERC.** Unblocks everything, improves the assistant immediately.
2. **Block view.** Cheapest large win; the data is already stamped.
3. **Code view + WebSerial flash.** Turns a design into a running board.
4. **PCB view.** Placement first, then routing, then fab export.
5. **Simulation.** Digital and firmware benches first, ngspice after.

## Known traps

- **Rotated and mirrored placement fidelity is unverified against real KiCad.**
  It is survivable in a schematic and fatal in a layout. Verify before any PCB
  work starts.
- **`kicad-cli` is not on the home server.** No Gerbers without it.
- **The AI bridge is a subprocess with minutes of latency.** Layout and firmware
  cannot be one giant JSON response; they need incremental ops and a job with
  progress, which the polled-job path already added.
- **Footprint libraries are large.** Index them on the NAS, never vendor them.
- **A `.kicad_pcb` that KiCad edited must round-trip losslessly** or the promise
  breaks. Verbatim passthrough for unknown nodes, same as the schematic codec.
