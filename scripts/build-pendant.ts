// The remote e-stop pendant: the other end of the PDB's safety link.
//
// It does one job. While its button is unpressed it transmits a heartbeat; the
// power board arms only while that heartbeat keeps arriving. Pressing the
// button, dropping the battery, walking out of range and the pendant crashing
// all look identical from the board's side, which is the point.
//
// Run: bun run scripts/build-pendant.ts <project> <board>
import { library } from "../server/src/services/library";
import { emptySchematic, type Schematic, type SymbolInstance } from "@loon/shared/schematic";
import { applyOps, autowireSheet, type LibResolver } from "@loon/shared/apply-ops";
import { compactSheet } from "@loon/shared/compact";
import { serializeSchematic } from "@loon/shared/kicad-sch";
import { buildNetlist } from "@loon/shared/netlist";
import { runErc, formatErc } from "@loon/shared/erc";
import { firmwareTargets } from "@loon/shared/firmware";
import { pinWorld } from "@loon/shared/geometry";
import type { Op } from "@loon/shared/ops";

const resolve: LibResolver = (libId) => {
  const e = library.get(libId);
  return e ? { def: e.def, footprint: e.part.footprints[0] } : undefined;
};
const defs = (libId: string) => library.get(libId)?.def;

const FP_TERMINAL = "TerminalBlock_Phoenix:TerminalBlock_Phoenix_MKDS-3-2-5.08_1x02_P5.08mm_Horizontal";

export function buildPendant(): Schematic {
  const schem = emptySchematic(crypto.randomUUID());
  schem.title = "ORA Remote E-Stop Pendant";
  schem.rev = "A";
  schem.company = "Oakland Robotics Association";

  const ops: Op[] = [];
  const pinLabels: { ref: string; pin: string; text: string }[] = [];
  const label = (ref: string, pin: string, text: string) => pinLabels.push({ ref, pin, text });
  const footprints: [string, string][] = [];

  // #region power
  // A 2S pack: the buck needs at least 4.5V in, so a single cell will not start
  // it. 7.4V nominal leaves headroom down to a flat pack.
  ops.push({ op: "add_symbol", libId: "Connector:Conn_01x02", ref: "J1", value: "2S battery 7.4V in", at: { x: 30, y: 40 } });
  footprints.push(["J1", FP_TERMINAL]);
  label("J1", "1", "+VBAT");
  label("J1", "2", "GND");
  ops.push({ op: "instantiate_module", moduleId: "buck_24v", params: { vout: 5, vin_net: "+VBAT", vout_net: "+5V" }, at: { x: 60, y: 90 } });
  ops.push({ op: "instantiate_module", moduleId: "ldo_3v3", params: { vin_net: "+5V" }, at: { x: 60, y: 230 } });

  // #region control
  ops.push({ op: "instantiate_module", moduleId: "esp32s3_core", at: { x: 330, y: 140 } });
  ops.push({ op: "instantiate_module", moduleId: "usb_c_program", at: { x: 520, y: 60 } });
  ops.push({ op: "instantiate_module", moduleId: "rf_heartbeat", params: { cs_net: "RF_CS" }, at: { x: 520, y: 250 } });

  // #region the button
  // Same fail-safe wiring as the panel e-stops on the power board: normally
  // closed to ground, so a pressed button and a broken wire read the same.
  ops.push({ op: "instantiate_module", moduleId: "estop_input", params: { net: "ESTOP_LOCAL" }, at: { x: 330, y: 400 } });

  // #region status
  // Driven by the MCU, not tied to the rail: the light means "transmitting",
  // which is only worth showing if the firmware controls it.
  ops.push({ op: "add_symbol", libId: "Device:R", ref: "R90", value: "330", at: { x: 640, y: 400 } });
  ops.push({ op: "add_symbol", libId: "Device:LED", ref: "D90", value: "green LINK", at: { x: 640, y: 420 } });
  label("R90", "1", "LINK_LED");
  label("R90", "2", "LINK_LED_A");
  label("D90", "2", "LINK_LED_A");
  label("D90", "1", "GND");

  ops.push({
    op: "add_text",
    text: "PENDANT: transmits a heartbeat while its button is clear. The power distribution board arms only while that heartbeat keeps arriving, so a pressed button, a flat battery, a lost link or a crashed pendant all stop the robot the same way. The button is wired fail-safe: normally closed to ground, LOW = clear.",
    at: { x: 30, y: 560 },
    size: 2,
  });
  ops.push({
    op: "add_text",
    text: "POWER: 2S pack (7.4V nominal). The buck needs 4.5V in, so a single Li-ion cell will not run this board.",
    at: { x: 30, y: 590 },
    size: 2,
  });

  const { results } = applyOps(schem, ops, resolve);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.log("failed ops:", [...new Set(failed.map((f) => f.error))].join("; "));

  for (const [ref, fp] of footprints) {
    const inst = schem.symbols.find((x) => x.properties.Reference === ref);
    if (inst) inst.properties.Footprint = fp;
  }

  const labelOps: Op[] = [];
  for (const { ref, pin, text } of pinLabels) {
    const inst = schem.symbols.find((x) => x.properties.Reference === ref);
    const d = inst ? defs(inst.libId) : undefined;
    const p = d?.pins.find((x) => x.number === pin);
    if (inst && p) labelOps.push({ op: "add_label", text, at: pinWorld(p, inst), kind: "local" });
  }
  applyOps(schem, labelOps, resolve);

  // #region MCU wiring
  const mcu = schem.symbols.find((s) => s.libId === "RF_Module:ESP32-S3-WROOM-1") as SymbolInstance;
  const def = defs(mcu.libId)!;
  const assign: Record<string, string> = {
    "7": "ESTOP_LOCAL", // IO7, the button
    "9": "SPI_SCK", // IO16
    "10": "SPI_MOSI", // IO17
    "11": "SPI_MISO", // IO18
    "12": "RF_CS", // IO8
    "17": "RF_CE", // IO9
    "18": "RF_IRQ", // IO10
    "4": "LINK_LED", // IO4
  };
  const mcuOps: Op[] = [];
  for (const [pin, net] of Object.entries(assign)) {
    const p = def.pins.find((x) => x.number === pin)!;
    mcuOps.push({ op: "add_label", text: net, at: pinWorld(p, mcu), kind: "local" });
  }
  applyOps(schem, mcuOps, resolve);

  // Draw the connections between the blocks, not just inside them.
  // Pack the sheet before wiring it: the anchors above are spread out so the
  // blocks cannot collide as they are written, and left that way the sheet is
  // several A4 pages wide.
  const packed = compactSheet(schem, (libId) => resolve(libId)?.def ?? schem.libSymbols[libId]);
  console.log(`compact: ${packed.clusters} blocks, ${packed.before.w}x${packed.before.h} -> ${packed.after.w}x${packed.after.h} mm`);

  const wired = autowireSheet(schem, resolve);
  console.log(`autowire: ${wired.drawn} drawn, ${wired.skipped} left joined by name`);
  return schem;
}

if (import.meta.main) {
  const schem = buildPendant();
  const nl = buildNetlist(schem, defs);
  console.log(`${schem.symbols.length} parts, ${nl.nets.length} nets, ${schem.labels.length} labels`);
  console.log("biggest nets:", [...nl.nets].sort((a, b) => b.pins.length - a.pins.length).slice(0, 5).map((n) => `${n.name}=${n.pins.length}`).join(" "));
  const t = firmwareTargets(schem, defs);
  console.log("MCU pin map:", t.map((x) => `${x.ref}: ${x.pins.length} pins (${x.pins.map((p) => p.net).join(", ")})`).join(" | "));
  console.log(formatErc(runErc(schem, defs, nl), 10));

  const project = process.argv[2];
  const unit = process.argv[3] ?? "";
  if (project) {
    const { storage } = await import("../server/src/services/storage");
    const libRaw = library.rawMap(Array.from(new Set(schem.symbols.map((s) => s.libId))));
    await storage.write(project, serializeSchematic(schem, libRaw), unit);
    console.log(`wrote ${project} / ${unit || "main"}`);
  }
}
