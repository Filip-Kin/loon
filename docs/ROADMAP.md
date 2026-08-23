# Roadmap and design direction

This is the shape loon is growing into, and the order of work. It is written to
match the vision, not the current code. Where the code already meets it, that is
noted.

## The core idea: three views over one design

loon has three views of the same design. Editing any view changes the one
underlying document. Nothing is a one-way export.

1. Logic block builder. The highest level. You drop blocks (a 5V buck
   converter, an Arduino core, a sensor front-end) and connect their inputs and
   outputs. Think of Scratch blocks. This is where a hobbyist works without an
   EE degree.
2. Schematic. The detailed circuit. Every block is made of parts and wiring.
   You can open a block and see and edit the schematic that defines it, the same
   way a Scratch custom block shows its definition. You can also edit the
   schematic directly.
3. Layout. The physical board (PCB). You can change the placement and routing.

Two rules hold across all three:

- Never limit the user. There is always a way down to the raw schematic or raw
  layout to do anything a full tool would allow.
- Simplify by default. A hobbyist should get a working board from the block
  view without touching the details, and only drop down when they want to.

## Modules are the blocks

A module is a parametric sub-circuit. A circuit is modules that interface with
each other. This is already in the code: `shared/src/modules.ts` defines modules
with parameters and a `build` that emits parts, internal wiring, and exposed
nets. The AI prefers modules over placing parts one at a time.

Today a module expands into schematic parts and each part is stamped with its
block id, module id, and parameters (`LoonBlock`, `LoonModule`,
`LoonBlockParams`), so provenance survives a save as ordinary KiCad fields.

Next steps to reach the block view:

- Make a block a first-class, persistent entity, not a one-shot expansion. Keep
  the module id, parameters, and the exposed ports on the block so it can be
  collapsed, re-parametrised, and drilled into.
- Block ports and net joining, so blocks connect at the block level and that
  connection resolves down to the schematic.
- Bidirectional sync: an edit in the schematic that falls inside a block updates
  the block; a parameter change on a block re-derives its schematic.

## Part and chip selection by spec

The user should say "a 5V to 3.3V buck at 1A" and get the right controller, not
pick a chip. A module's `build` chooses parts from a spec. This needs:

- A parametric part table keyed by the numbers that matter (current, voltage,
  package), seeded now and grown from supplier data later.
- Reference-design modules that follow a controller's datasheet: buck converter
  around a chosen controller, LDO, boost, an ATmega328P or RP2040 "Arduino core"
  laid out on the board rather than a module slotted in.

## Datasheets

The AI should look up and read datasheets to pick parts and pin maps. The bridge
is Claude itself, so the plan is a research step with web access that returns
structured part facts, feeding chip selection and pin maps. This is separate
from the fast text-to-ops path so ordinary edits stay quick.

## Suppliers and fab

- DigiKey and Mouser live search for real stock and price, behind API keys.
- The source filter already restricts the catalogue to what a chosen source can
  supply, including a fab's pick-and-place inventory.
- OSH Park export: generate the Gerber and drill package to upload. This needs
  `kicad-cli` on the host for Gerber generation from the PCB.

## Hardware-in-the-loop debugging (first version built)

Debugging a board you actually built. A small network device (the "probe") is
wired to points on the board; Claude tells you where to connect each channel,
then reads and drives those pins to find the fault, reasoning against the
schematic. Built so far:

- Protocol in `shared/src/probe.ts`; a WebSocket hub in the server
  (`services/probe-hub.ts`) that probes dial into (no port forwarding).
- Agents: `probe/loon_probe.py` (Raspberry Pi / Linux, + `--mock`),
  `probe/digilent.py` (Digilent Analog Discovery 2/3, the accurate/fast tier),
  and `probe/esp32/main.py` (ESP32-S3 MicroPython). All speak one protocol.
- `mcp/server.ts` exposes the probe to any Claude as MCP tools, so Claude can
  read and send signals itself during a debug session. Each probe advertises its
  limits (logic voltage, 5V tolerance, ADC presence, sample rate) so Claude does
  not overreach.
- A Debug tab in the UI lists live probes and reads/drives pins by hand.

Next: a guided "connection plan" (Claude assigns probe channels to schematic
nets/testpoints and the UI shows the wiring), streaming waveform capture on the
Analog Discovery, and a loon "debug mode" that runs the bridge with the probe
MCP attached automatically.

## Simulation

Phased, MCU first.

1. Run Arduino and Raspberry Pi Pico firmware in the browser and simulate GPIO,
   PWM, serial, and attached components. The AI builds the firmware alongside
   the board.
2. Analog SPICE with ngspice for voltages, currents, and waveforms.

## KiCad fidelity notes

- Non-rotated symbol placement matches KiCad exactly. Rotated and mirrored
  placement uses an internally consistent transform; matching KiCad's exact sign
  conventions for rotated parts still needs verification against real KiCad.
- Saved files embed the verbatim symbol definitions for parts in the builtin
  library, so those round-trip cleanly. Parts loaded from an external file keep
  their definitions through an in-memory cache during the session.
