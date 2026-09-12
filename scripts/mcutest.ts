// On-board MCU test: builds the power-distribution board's control section the
// way the assistant is now expected to - a real ESP32-S3 with its support
// circuitry, a USB-C programming port, a 24V buck, e-stop inputs and current
// monitoring - then checks the pin budget, the BOM cost, a runtime-declared
// part, and that the whole thing round-trips through .kicad_sch.
// Run: bun run scripts/mcutest.ts
import { library } from "../server/src/services/library";
import { emptySchematic } from "@loon/shared/schematic";
import { applyOps, type LibResolver } from "@loon/shared/apply-ops";
import { serializeSchematic, parseSchematic } from "@loon/shared/kicad-sch";
import { pinBudget, formatBudget } from "@loon/shared/pinbudget";
import { buildBom, formatBom } from "@loon/shared/bom";
import type { Op } from "@loon/shared/ops";

const resolve: LibResolver = (libId) => {
  const e = library.get(libId);
  return e ? { def: e.def, footprint: e.part.footprints[0] } : undefined;
};

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const schem = emptySchematic(crypto.randomUUID());
const ops: Op[] = [
  { op: "instantiate_module", moduleId: "buck_24v", params: { vout: 5 }, at: { x: 60, y: 60 } },
  { op: "instantiate_module", moduleId: "ldo_3v3", at: { x: 60, y: 140 } },
  { op: "instantiate_module", moduleId: "esp32s3_core", at: { x: 200, y: 120 } },
  { op: "instantiate_module", moduleId: "usb_c_program", at: { x: 300, y: 60 } },
  { op: "instantiate_module", moduleId: "rf_heartbeat", at: { x: 300, y: 180 } },
  { op: "instantiate_module", moduleId: "estop_input", params: { net: "ESTOP1" }, at: { x: 60, y: 220 } },
  { op: "instantiate_module", moduleId: "estop_input", params: { net: "ESTOP2" }, at: { x: 60, y: 280 } },
  { op: "instantiate_module", moduleId: "high_side_channel", params: { channel: "CH1", ilim_a: 20 }, at: { x: 400, y: 60 } },
  { op: "instantiate_module", moduleId: "current_sense_i2c", params: { channel: "CH2", amps: 20, addr: 1 }, at: { x: 400, y: 180 } },
  { op: "instantiate_module", moduleId: "estop_latch", params: { inputs: 2 }, at: { x: 700, y: 120 } },
  { op: "instantiate_module", moduleId: "buckboost_20v", params: { vout: 20, iout: 4.5 }, at: { x: 700, y: 320 } },
  // A part nobody put in the catalog: declared on the fly, then placed.
  {
    op: "define_symbol",
    libId: "Interface:SN65HVD230",
    refPrefix: "U",
    value: "SN65HVD230",
    description: "3.3V CAN transceiver",
    footprint: "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm",
    pins: [
      { number: "1", name: "D", type: "input", side: "left" },
      { number: "2", name: "GND", type: "power_in", side: "left" },
      { number: "3", name: "VCC", type: "power_in", side: "left" },
      { number: "4", name: "R", type: "output", side: "left" },
      { number: "5", name: "Vref", type: "output", side: "right" },
      { number: "6", name: "CANL", type: "bidirectional", side: "right" },
      { number: "7", name: "CANH", type: "bidirectional", side: "right" },
      { number: "8", name: "Rs", type: "input", side: "right" },
    ],
  },
  { op: "add_symbol", libId: "Interface:SN65HVD230", ref: "U20", at: { x: 500, y: 300 } },
];
const { results } = applyOps(schem, ops, resolve);
const bad = results.filter((r) => !r.ok);
check("all ops applied", bad.length === 0, bad.map((b) => b.error).join("; "));

const mcu = schem.symbols.find((s) => s.libId === "RF_Module:ESP32-S3-WROOM-1");
check("ESP32-S3 module placed as a real part", !!mcu);
check("ESP32 symbol has all 41 pads", schem.libSymbols["RF_Module:ESP32-S3-WROOM-1"]?.pins.length === 41);
check("no placeholder headers on the sheet", !schem.symbols.some((s) => s.libId.includes("Conn_01x15") || s.libId.includes("Conn_02x20")));
check("runtime-declared part placed", schem.symbols.some((s) => s.libId === "Interface:SN65HVD230"));

// The EN pin, BOOT button and USB pins must actually be wired, not implied.
const labels = new Set(schem.labels.map((l) => l.text));
for (const net of ["EN", "IO0_BOOT", "USB_D-", "USB_D+", "+3V3", "GND", "SCL", "SDA", "ESTOP1", "ESTOP2", "CH1_IMON", "ESTOP_RUN", "ESTOP_TRIP", "CLR_N", "WDT_KICK", "WDT_FAIL", "+20V", "SW1", "SW2"]) {
  check(`net ${net} exists`, labels.has(net));
}

const budgets = pinBudget(schem);
check("pin budget found the MCU", budgets.length === 1);
if (budgets[0]) {
  console.log(formatBudget(budgets[0]));
  check("USB pins counted as spent", !budgets[0].freeGpio.includes(19) && !budgets[0].freeGpio.includes(20));
  check("ADC1 channels still free", budgets[0].freeAdc1.length > 0);
}

const bom = buildBom(schem, (libId) => {
  const part = library.get(libId)?.part;
  return part ? { priceUsd: part.priceUsd, mpn: part.mpn, note: part.priceNote } : undefined;
});
console.log(formatBom(bom));
check("BOM has a non-zero cost", bom.totalUsd > 10);

const libRaw = library.rawMap(Array.from(new Set(schem.symbols.map((s) => s.libId))));
const text = serializeSchematic(schem, libRaw);
const back = parseSchematic(text);
check("round-trips symbols", back.schem.symbols.length === schem.symbols.length);
check("round-trips the ESP32 definition", back.schem.libSymbols["RF_Module:ESP32-S3-WROOM-1"]?.pins.length === 41);
check("round-trips the declared part", back.schem.libSymbols["Interface:SN65HVD230"]?.pins.length === 8);
check("declared part kept its pin names", back.schem.libSymbols["Interface:SN65HVD230"]?.pins.find((p) => p.number === "7")?.name === "CANH");

await Bun.write("/tmp/loon-mcutest.kicad_sch", text);
console.log(`\nwrote /tmp/loon-mcutest.kicad_sch (${schem.symbols.length} symbols, ${schem.wires.length} wires, ${schem.labels.length} labels)`);
console.log(failures === 0 ? "\nMCU TEST PASS" : `\nMCU TEST FAIL (${failures})`);
if (failures > 0) process.exit(1);
