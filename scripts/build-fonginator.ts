// Reconstructs the Funginator 3000 (Makita vacuum <-> Raspberry Pi interface)
// as a loon schematic from its EasyEDA BOM. Real parts + designators are placed;
// the Pi header's standard power pins are labelled (known pinout); a conventional
// low-side MOSFET fan driver is wired (inferred); motor/sensor connectors are
// placed and left for probing. Connectivity beyond that is NOT in the Gerbers,
// so it is annotated as inferred. Writes fonginator.kicad_sch into LOON_FS_DIR.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { library } from "../server/src/services/library";
import { emptySchematic, type Schematic } from "@loon/shared/schematic";
import { applyOps, type LibResolver } from "@loon/shared/apply-ops";
import { serializeSchematic } from "@loon/shared/kicad-sch";
import { pinWorld, findPin } from "@loon/shared/geometry";
import type { Op } from "@loon/shared/ops";

const resolve: LibResolver = (libId) => {
  const e = library.get(libId);
  return e ? { def: e.def, footprint: e.part.footprints[0] } : undefined;
};

const schem = emptySchematic(crypto.randomUUID());
schem.title = "Funginator 3000 - Makita vacuum interface";
schem.rev = "recon-2024-05-30";

const ops: Op[] = [];
const place = (libId: string, ref: string, value: string, x: number, y: number) =>
  ops.push({ op: "add_symbol", libId, ref, value, at: { x, y } });

// Notes across the top.
let ty = 20;
const note = (t: string, size = 2) => ops.push({ op: "add_text", text: t, at: { x: 20, y: (ty += 5) }, size });
note("FUNGINATOR 3000 - Makita robot vacuum <-> Raspberry Pi interface", 3);
note("Reconstructed from EasyEDA BOM 2024-05-30. Parts + designators are real.");
note("Wiring is INFERRED (Gerbers carry no netlist) - verify before trusting.");
note("5-pin drive motors (LDRIVE/RDRIVE/LBRUSH/RBRUSH/MBRUSH): GND, VCC, EN, DIR(CW/CCW), PWM.");
note("4-pin fan (FAN): GND, VCC, EN, PWM.");
note("Pin ORDER on the motor connectors is UNKNOWN - use the hardware probe to identify each pin.");

// Raspberry Pi 40-pin header.
const PIx = 130, PIy = 130;
place("Connector_Generic:Conn_02x20", "P1", "RaspberryPi_GPIO", PIx, PIy);

// Battery input (XT60) + supplies.
place("Connector:Conn_01x02", "U3", "XT60_Battery", 35, 55);
place("Connector:Conn_01x02", "PSU", "PSU", 35, 80);
place("Connector:Conn_01x02", "LED", "LED", 35, 100);

// Fan driver: NMOS + gate resistors.
place("Device:Q_NMOS_GSD", "Q1", "DMN3042L", 80, 55);
place("Device:R", "R3", "10k", 60, 55);   // gate series
place("Device:R", "R2", "470k", 80, 72);  // gate pulldown
place("Device:R", "R1", "120k", 100, 55); // (battery sense divider, unwired)
place("power:GND", "PWRG1", "GND", 80, 85);

// Motors: 4-pin fan + five 5-pin drive/brush motors.
place("Connector_Generic:Conn_01x04", "FAN", "Fan", 210, 45);
const drive = ["LDRIVE", "RDRIVE", "LBRUSH", "RBRUSH", "MBRUSH"];
drive.forEach((r, i) => place("Connector_Generic:Conn_01x05", r, r, 210, 75 + i * 22));

// Stacking headers + accelerometer.
place("Connector_Generic:Conn_01x15", "U1", "Header_1x15", 95, 120);
place("Connector_Generic:Conn_01x15", "U2", "Header_1x15", 110, 120);
place("Connector_Generic:Conn_01x08", "ACCEL", "Accelerometer", 210, 190);

// Sensors: 3-pin connectors in a grid.
const sensors = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "BTN", "FILTERSENS", "LBUMPER", "LWHEELSENS", "RBUMPER", "RWHEELSENS", "D5", "D6"];
sensors.forEach((r, i) => place("Connector_Generic:Conn_01x03", r, r, 20 + (i % 5) * 30, 175 + Math.floor(i / 5) * 24));

// Apply placement first so refs exist for wiring.
applyOps(schem, ops, resolve);

// #region known Pi power pin labels (standard 40-pin pinout, not guessed)
const piDef = library.get("Connector_Generic:Conn_02x20")!.def;
const inst = schem.symbols.find((s) => s.properties.Reference === "P1")!;
const place3: { at: { x: number; y: number }; rotation: number; mirror: null } = { at: inst.at, rotation: inst.rotation, mirror: null };
const powerPins: Record<string, string> = {
  "1": "+3V3", "17": "+3V3", "2": "+5V", "4": "+5V",
  "6": "GND", "9": "GND", "14": "GND", "20": "GND", "25": "GND", "30": "GND", "34": "GND", "39": "GND",
};
const labelOps: Op[] = [];
for (const [num, net] of Object.entries(powerPins)) {
  const pin = findPin(piDef, num);
  if (!pin) continue;
  const w = pinWorld(pin, place3);
  labelOps.push({ op: "add_label", text: net, at: w, kind: "local" });
}

// #region inferred fan driver wiring (conventional low-side switch)
// Pi GPIO18 (P1 pin 12, PWM capable) -> R3 -> Q1 gate; gate pulldown R2 -> GND;
// Q1 source -> GND; Q1 drain -> FAN switch node label.
const wireOps: Op[] = [
  { op: "connect_pins", a: { ref: "P1", pin: "12" }, b: { ref: "R3", pin: "1" } },
  { op: "connect_pins", a: { ref: "R3", pin: "2" }, b: { ref: "Q1", pin: "1" } },
  { op: "connect_pins", a: { ref: "Q1", pin: "1" }, b: { ref: "R2", pin: "1" } },
  { op: "connect_pins", a: { ref: "R2", pin: "2" }, b: { ref: "PWRG1", pin: "1" } },
  { op: "connect_pins", a: { ref: "Q1", pin: "2" }, b: { ref: "PWRG1", pin: "1" } },
  { op: "add_label", text: "VBAT", at: { x: 30, y: 55 }, kind: "local" },
  { op: "add_label", text: "GND", at: { x: 30, y: 57.54 }, kind: "local" },
];

const res = applyOps(schem, [...labelOps, ...wireOps], resolve);
const failed = res.results.filter((r) => !r.ok);
if (failed.length) console.log("wiring issues:", failed.map((f) => f.error).join("; "));

const usedLibIds = Array.from(new Set(schem.symbols.map((s) => s.libId)));
const text = serializeSchematic(schem as Schematic, library.rawMap(usedLibIds));
const dir = process.env.LOON_FS_DIR ?? "/media/nas/filip/ncdata/filip/files/Electronics/loon-projects";
const path = join(dir, "fonginator.kicad_sch");
writeFileSync(path, text);
console.log(`wrote ${path}`);
console.log(`parts: ${schem.symbols.length}, wires: ${schem.wires.length}, labels: ${schem.labels.length}, texts: ${schem.texts.length}, libSymbols: ${usedLibIds.length}`);
