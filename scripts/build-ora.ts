// Builds the ORA power distribution board from modules, deterministically.
// The hand-assembled sheet had one net holding 435 pins and two boards mixed
// together; this is the same design expressed as blocks, so the connectivity is
// right by construction rather than by repair.
//
// Run: bun run scripts/build-ora.ts <project> [board]
import { library } from "../server/src/services/library";
import { emptySchematic, type Schematic, type SymbolInstance } from "@loon/shared/schematic";
import { applyOps, autowireSheet, type LibResolver } from "@loon/shared/apply-ops";
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

const SWITCHED = 6; // channels the e-stop can cut
const ALWAYS_ON = 2; // controller and radio: never switched

// Verified against KiCad's 9.0 footprint library.
const FP_TERMINAL = "TerminalBlock_Phoenix:TerminalBlock_Phoenix_MKDS-3-2-5.08_1x02_P5.08mm_Horizontal"; // 12AWG screw terminal
const FP_LUG_PAD = "MountingHole:MountingHole_6.4mm_M6_DIN965_Pad_TopBottom"; // M6 stud for a 6AWG ring lug
// Four ways off each regulated rail. They share the rail's breaker, so this is
// a terminal block, not four fused outputs.
const FP_RAIL_BLOCK = "TerminalBlock_Phoenix:TerminalBlock_Phoenix_MKDS-3-8-5.08_1x08_P5.08mm_Horizontal";

export function buildOra(): Schematic {
  const schem = emptySchematic(crypto.randomUUID());
  schem.title = "ORA 24V Power Distribution + E-Stop Controller";
  schem.rev = "B";
  schem.company = "Oakland Robotics Association";

  const ops: Op[] = [];
  // Labels are placed on a pin, found by geometry after the parts land. Hand
  // computing a pin's position is how a net ends up attached to nothing.
  const pinLabels: { ref: string; pin: string; text: string }[] = [];
  // Footprint overrides for the parts whose catalog default is not what this
  // board needs: heavy wire lands on a screw terminal, not a pin header.
  const footprints: [string, string][] = [];
  const label = (ref: string, pin: string, text: string) => pinLabels.push({ ref, pin, text });

  // #region power in
  // Two studs, because a battery needs a way back. One lug carrying +24V and
  // no return is a board that does nothing.
  ops.push({ op: "add_symbol", libId: "Connector_Generic:Conn_01x01", ref: "J1", value: "24V IN 6AWG lug", at: { x: 30, y: 30 } });
  footprints.push(["J1", FP_LUG_PAD]);
  label("J1", "1", "+24V");
  ops.push({ op: "add_symbol", libId: "Connector_Generic:Conn_01x01", ref: "J2", value: "24V RETURN 6AWG lug", at: { x: 30, y: 60 } });
  footprints.push(["J2", FP_LUG_PAD]);
  label("J2", "1", "GND");

  // #region rails
  ops.push({ op: "instantiate_module", moduleId: "buck_24v", params: { vout: 5, vin_net: "+24V", vout_net: "+5V" }, at: { x: 60, y: 90 } });
  ops.push({ op: "instantiate_module", moduleId: "buck_24v", params: { vout: 12, vin_net: "+24V", vout_net: "+12V" }, at: { x: 60, y: 210 } });
  ops.push({ op: "instantiate_module", moduleId: "buckboost_20v", params: { vout: 20, iout: 4.5, vin_net: "+24V", vout_net: "+20V" }, at: { x: 60, y: 360 } });
  ops.push({ op: "instantiate_module", moduleId: "ldo_3v3", params: { vin_net: "+5V" }, at: { x: 60, y: 520 } });

  // #region control
  ops.push({ op: "instantiate_module", moduleId: "esp32s3_core", at: { x: 430, y: 140 } });
  ops.push({ op: "instantiate_module", moduleId: "usb_c_program", at: { x: 620, y: 60 } });
  ops.push({ op: "instantiate_module", moduleId: "rf_heartbeat", params: { cs_net: "RF_CS" }, at: { x: 620, y: 250 } });

  // #region e-stop chain
  ops.push({ op: "instantiate_module", moduleId: "estop_input", params: { net: "ESTOP1" }, at: { x: 430, y: 380 } });
  ops.push({ op: "instantiate_module", moduleId: "estop_input", params: { net: "ESTOP2" }, at: { x: 430, y: 460 } });
  ops.push({ op: "instantiate_module", moduleId: "estop_latch", params: { run_net: "ESTOP_RUN", inputs: 2, decay_ms: 20 }, at: { x: 700, y: 420 } });

  // #region channels
  // Six switched channels: bus -> breaker -> smart high-side switch -> terminal.
  for (let i = 1; i <= SWITCHED; i++) {
    const ch = `CH${i}`;
    const y = 60 + (i - 1) * 90;
    ops.push({ op: "add_symbol", libId: "Device:Fuse", ref: `F${i}`, value: "ATO 30A self-resetting", at: { x: 900, y } });
    label(`F${i}`, "1", "+24V");
    label(`F${i}`, "2", `${ch}_FUSED`);
    ops.push({ op: "instantiate_module", moduleId: "high_side_channel", params: { channel: ch, vin_net: `${ch}_FUSED`, ilim_a: 20 }, at: { x: 1000, y } });
    // The latch enables it: this is the only thing that switches a channel.
    ops.push({ op: "rename_net", from: `${ch}_EN_MCU`, to: "ESTOP_RUN" });
    ops.push({ op: "add_symbol", libId: "Connector:Conn_01x02", ref: `J${10 + i}`, value: `${ch} OUT 12AWG`, at: { x: 1120, y } });
    footprints.push([`J${10 + i}`, FP_TERMINAL]);
    label(`J${10 + i}`, "1", `${ch}_OUT`);
    label(`J${10 + i}`, "2", "GND");
  }
  // Two always-on channels for the radio and the controller.
  for (let i = 1; i <= ALWAYS_ON; i++) {
    const n = SWITCHED + i;
    const y = 60 + (n - 1) * 90;
    ops.push({ op: "add_symbol", libId: "Device:Fuse", ref: `F${n}`, value: "ATO 20A self-resetting", at: { x: 900, y } });
    label(`F${n}`, "1", "+24V");
    label(`F${n}`, "2", `CH${n}_OUT`);
    ops.push({ op: "add_symbol", libId: "Connector:Conn_01x02", ref: `J${10 + n}`, value: `CH${n} ALWAYS-ON 12AWG`, at: { x: 1120, y } });
    footprints.push([`J${10 + n}`, FP_TERMINAL]);
    label(`J${10 + n}`, "1", `CH${n}_OUT`);
    label(`J${10 + n}`, "2", "GND");
  }

  // #region accessory outputs
  const accessories: [string, string, number][] = [
    ["+20V", "20V computer", 700],
    ["+12V", "12V accessory", 780],
    ["+5V", "5V accessory", 860],
  ];
  accessories.forEach(([rail, name, y], i) => {
    ops.push({ op: "add_symbol", libId: "Device:Fuse", ref: `F${20 + i}`, value: `ATO ${rail === "+20V" ? "10A" : rail === "+12V" ? "10A" : "15A"}`, at: { x: 260, y } });
    label(`F${20 + i}`, "1", rail);
    label(`F${20 + i}`, "2", `${rail}_OUT`);
    // Four output pairs per rail on one 8-way block, all behind the rail's own
    // breaker: the loads on a 5V rail do not each need their own fuse.
    ops.push({ op: "add_symbol", libId: "Connector_Generic:Conn_01x08", ref: `J${30 + i}`, value: `${name} OUT x4`, at: { x: 360, y } });
    footprints.push([`J${30 + i}`, FP_RAIL_BLOCK]);
    for (let k = 0; k < 4; k++) {
      label(`J${30 + i}`, `${k * 2 + 1}`, `${rail}_OUT`);
      label(`J${30 + i}`, `${k * 2 + 2}`, "GND");
    }
  });

  // #region notes
  const notes: [string, number][] = [
    [
      "E-STOP: two panel e-stops wired fail-safe (NC to GND; pressed OR cut cable = stop) diode-OR into the latch's asynchronous CLR. The MCU joins the same OR through a charge-pump watchdog: it must keep toggling WDT_KICK to stay armed, so a lost RF heartbeat, a pressed remote e-stop, hung firmware or a dead MCU all clear the latch. ARM needs a rising edge from the MCU; an RC on CLR holds the board stopped through power-up.",
      960,
    ],
    [`CHANNELS: CH1-CH${SWITCHED} are switched by the latch through TPS27S100B high-side switches. CH${SWITCHED + 1}-CH${SWITCHED + ALWAYS_ON} are always-on for the radio and the controller. Every channel runs through a self-resetting ATO breaker into a 12AWG screw terminal.`, 1000],
    ["RAILS: 5V and 12V from TPS54360 bucks (60V parts: a 24V pack under regen overshoots). 20V from an LM5175 buck-boost, because the pack sags below 20V under load - size its power stage for the real computer load. 3V3 from an LDO off 5V.", 1030],
    ["20V rail values follow the LM5175 datasheet's 4.5A example, but its breaker is 10A. Size the power stage - FETs, inductor, sense resistor - for the current that breaker will let through before ordering, or the converter dies before the fuse opens.", 1060],
  ];
  for (const [text, y] of notes) ops.push({ op: "add_text", text, at: { x: 30, y }, size: 2 });

  const { results } = applyOps(schem, ops, resolve);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.log("failed ops:", [...new Set(failed.map((f) => f.error))].join("; "));

  // Apply the footprint overrides now the parts exist.
  for (const [ref, fp] of footprints) {
    const inst = schem.symbols.find((x) => x.properties.Reference === ref);
    if (inst) inst.properties.Footprint = fp;
  }

  // Now the parts exist, put each label exactly on its pin.
  const labelOps: Op[] = [];
  for (const { ref, pin, text } of pinLabels) {
    const inst = schem.symbols.find((s) => s.properties.Reference === ref);
    const d = inst ? defs(inst.libId) : undefined;
    const p = d?.pins.find((x) => x.number === pin);
    if (!inst || !p) {
      console.log(`label ${text}: no pin ${ref}.${pin}`);
      continue;
    }
    labelOps.push({ op: "add_label", text, at: pinWorld(p, inst), kind: "local" });
  }
  applyOps(schem, labelOps, resolve);

  // #region MCU wiring
  // Label the microcontroller's pins directly: every safety net, the radio bus,
  // and nothing on a strapping pin, the USB pair or the UART console.
  const mcu = schem.symbols.find((s) => s.libId === "RF_Module:ESP32-S3-WROOM-1") as SymbolInstance;
  const def = defs(mcu.libId)!;
  const assign: Record<string, string> = {
    "4": "WDT_KICK", // IO4
    "5": "ARM", // IO5
    "6": "ESTOP_RUN", // IO6, reads the latch back
    "7": "ESTOP1", // IO7
    "8": "ESTOP2", // IO15
    "9": "SPI_SCK", // IO16
    "10": "SPI_MOSI", // IO17
    "11": "SPI_MISO", // IO18
    "12": "RF_CS", // IO8
    "17": "RF_CE", // IO9
    "18": "RF_IRQ", // IO10
  };
  const mcuOps: Op[] = [];
  for (const [pin, net] of Object.entries(assign)) {
    const p = def.pins.find((x) => x.number === pin)!;
    const at = pinWorld(p, mcu);
    mcuOps.push({ op: "add_label", text: net, at, kind: "local" });
  }
  applyOps(schem, mcuOps, resolve);

  // Draw the connections between the blocks, not just inside them.
  const wired = autowireSheet(schem, resolve);
  console.log(`autowire: ${wired.drawn} drawn, ${wired.skipped} left joined by name`);
  return schem;
}

if (import.meta.main) {
  const schem = buildOra();
  const nl = buildNetlist(schem, defs);
  const biggest = [...nl.nets].sort((a, b) => b.pins.length - a.pins.length).slice(0, 6);
  console.log(`${schem.symbols.length} parts, ${nl.nets.length} nets, ${schem.wires.length} wires, ${schem.labels.length} labels`);
  console.log("biggest nets:", biggest.map((n) => `${n.name}=${n.pins.length}`).join(" "));
  const t = firmwareTargets(schem, defs);
  console.log("MCU pin map:", t.map((x) => `${x.ref}: ${x.pins.length} pins (${x.pins.map((p) => p.net).join(", ")})`).join(" | "));
  const issues = runErc(schem, defs, nl);
  console.log(formatErc(issues, 14));

  const project = process.argv[2];
  if (project) {
    const { storage } = await import("../server/src/services/storage");
    const unit = process.argv[3] ?? "";
    const libRaw = library.rawMap(Array.from(new Set(schem.symbols.map((s) => s.libId))));
    await storage.write(project, serializeSchematic(schem, libRaw), unit);
    console.log(`wrote ${project}${unit ? ` / ${unit}` : ""}`);
  }
}
