// FRC radio kiosk v2, stage one: the power tree.
//
// What this sheet does: take 18-26 V from either a USB-C PD trigger module or a
// DC barrel jack, OR them together, make a 12 V rail that a 4x CR123A pack
// steps in behind when the input drops, plus an 18.5 V laptop rail off the raw
// input (so it sheds itself on a dropout) and 5 V / 3.3 V for the logic.
//
// What it does not do yet: the radio port (802.3at PSE + passive 12 V, stage
// two), the MCU and its sensors/LEDs/fan (stage three), the board (stage four).
// Every net the later stages need is a named label on this sheet.
//
// Built for hand assembly of 2-4 boards on an OSH Park 2-layer run: SOIC,
// SOT-23, 0805 and up, nothing with a hidden pad except the three HSOIC-8
// bucks (their pad is soldered through back-side vias). No QFN.
//
// Run: bun run scripts/build-radio-kiosk.ts <project> [board]
import { library } from "../server/src/services/library";
import { emptySchematic, type Schematic } from "@loon/shared/schematic";
import { applyOps, autowireSheet, type LibResolver } from "@loon/shared/apply-ops";
import { serializeSchematic } from "@loon/shared/kicad-sch";
import { buildNetlist } from "@loon/shared/netlist";
import { runErc, formatErc } from "@loon/shared/erc";
import { pinWorld } from "@loon/shared/geometry";
import type { Op } from "@loon/shared/ops";
import type { IcSymbolSpec } from "@loon/shared/symbolgen";

const resolve: LibResolver = (libId) => {
  const e = library.get(libId);
  return e ? { def: e.def, footprint: e.part.footprints[0] } : undefined;
};

// #region footprints (all verified against the KiCad 9.0.9.1 footprint library)
const FP = {
  r0805: "Resistor_SMD:R_0805_2012Metric",
  r2512: "Resistor_SMD:R_2512_6332Metric",
  rAxial3W: "Resistor_THT:R_Axial_DIN0617_L17.0mm_D6.0mm_P25.40mm_Horizontal",
  c0805: "Capacitor_SMD:C_0805_2012Metric",
  c1206: "Capacitor_SMD:C_1206_3216Metric",
  c1210: "Capacitor_SMD:C_1210_3225Metric",
  cRadial10: "Capacitor_THT:CP_Radial_D10.0mm_P5.00mm",
  sma: "Diode_SMD:D_SMA",
  sot23: "Package_TO_SOT_SMD:SOT-23",
  sot23_5: "Package_TO_SOT_SMD:SOT-23-5",
  sot23_6: "Package_TO_SOT_SMD:SOT-23-6",
  hsoic8: "Package_SO:SOIC-8-1EP_3.9x4.9mm_P1.27mm_EP2.29x3mm",
  soic8ep: "Package_SO:SOIC-8-1EP_3.9x4.9mm_P1.27mm_EP2.41x3.3mm",
  to252: "Package_TO_SOT_SMD:TO-252-2",
  xal7030: "Inductor_SMD:L_Coilcraft_XAL7030-103",
  fuse1206: "Fuse:Fuse_1206_3216Metric",
  xh2: "Connector_JST:JST_XH_B2B-XH-A_1x02_P2.50mm_Vertical",
  barrel: "Connector_BarrelJack:BarrelJack_Horizontal",
  cr123a: "Battery:BatteryHolder_Bulgin_BX0123_1xCR123",
};

// #region parts declared from their datasheets
// Pin numbers and names are transcribed from the datasheet pin-function tables
// (TI SNOSD17G, SNVSAN3F, SLVSDM5F). Nothing here is from memory.
const LM74700: IcSymbolSpec = {
  libId: "Power_Management:LM74700",
  refPrefix: "U",
  value: "LM74700-Q1",
  description:
    "Ideal diode controller driving an external N-FET. Reverse blocking with a few mV of drop instead of a Schottky's 0.35 W; three of them make the input OR and the rail OR here.",
  keywords: "ideal diode oring reverse blocking controller",
  datasheet: "https://www.ti.com/lit/ds/symlink/lm74700-q1.pdf",
  footprint: FP.sot23_6,
  pins: [
    { number: "1", name: "VCAP", type: "passive", side: "left" },
    { number: "2", name: "GND", type: "power_in", side: "left" },
    { number: "3", name: "EN", type: "input", side: "left" },
    { number: "4", name: "CATHODE", type: "passive", side: "right" },
    { number: "5", name: "GATE", type: "output", side: "right" },
    { number: "6", name: "ANODE", type: "passive", side: "right" },
  ],
};

const LMR33630: IcSymbolSpec = {
  libId: "Regulator_Switching:LMR33630",
  refPrefix: "U",
  value: "LMR33630ADDA",
  description:
    "36 V 3 A synchronous buck, 400 kHz, HSOIC-8. Used three times (12 V, 18.5 V, 5 V) so the BOM has one buck. Auto mode, so it skips pulses at very light load; the 12 V rail always carries the logic so it stays out of that region. If a rail whines, this is the part to swap.",
  keywords: "buck synchronous step-down 36v 3a",
  datasheet: "https://www.ti.com/lit/ds/symlink/lmr33630.pdf",
  footprint: FP.hsoic8,
  pins: [
    { number: "1", name: "PGND", type: "power_in", side: "left" },
    { number: "2", name: "VIN", type: "power_in", side: "left" },
    { number: "3", name: "EN", type: "input", side: "left" },
    { number: "4", name: "PG", type: "output", side: "left" },
    { number: "5", name: "FB", type: "input", side: "right" },
    { number: "6", name: "VCC", type: "passive", side: "right" },
    { number: "7", name: "BOOT", type: "passive", side: "right" },
    { number: "8", name: "SW", type: "power_out", side: "right" },
    { number: "9", name: "AGND", type: "power_in", side: "right" },
  ],
};

const TLV7011: IcSymbolSpec = {
  libId: "Comparator:TLV7011",
  refPrefix: "U",
  value: "TLV7011",
  description: "Nanopower push-pull comparator, SOT-23-5. Decides 'input is gone' in hardware so the battery switch does not wait on firmware.",
  keywords: "comparator push-pull low power",
  datasheet: "https://www.ti.com/lit/ds/symlink/tlv7011.pdf",
  footprint: FP.sot23_5,
  pins: [
    { number: "1", name: "OUT", type: "output", side: "right" },
    { number: "2", name: "VEE", type: "power_in", side: "left" },
    { number: "3", name: "IN+", type: "input", side: "left" },
    { number: "4", name: "IN-", type: "input", side: "left" },
    { number: "5", name: "VCC", type: "power_in", side: "left" },
  ],
};

const PMOS_40V: IcSymbolSpec = {
  libId: "Transistor_FET:Power_PMOS_40V",
  refPrefix: "Q",
  value: "P-MOSFET 40V (SUD50P04-13L)",
  description: "40 V P-channel power MOSFET, TO-252. High-side battery switch: source on the pack, drain on the rail, so its body diode points pack-to-rail and never charges the cells.",
  keywords: "mosfet p-channel high side switch",
  footprint: FP.to252,
  pins: [
    { number: "1", name: "G", type: "input", side: "left" },
    { number: "2", name: "D", type: "passive", side: "right" },
    { number: "3", name: "S", type: "passive", side: "right" },
  ],
};

const CR123A: IcSymbolSpec = {
  libId: "Device:Battery_CR123A",
  refPrefix: "BT",
  value: "CR123A",
  description: "One CR123A lithium primary cell in a Bulgin BX0123 PCB holder. Four in series make the 12 V backup pack. Replace all four together.",
  keywords: "battery cell cr123a lithium primary holder",
  footprint: FP.cr123a,
  pins: [
    { number: "1", name: "+", type: "passive", side: "left" },
    { number: "2", name: "-", type: "passive", side: "right" },
  ],
};

const BARREL: IcSymbolSpec = {
  libId: "Connector:Barrel_Jack",
  refPrefix: "J",
  value: "Barrel jack 5.5x2.5",
  description: "DC barrel jack, centre positive. Pin 3 is the normally-closed switch contact and is left open.",
  keywords: "dc jack barrel power connector",
  footprint: FP.barrel,
  pins: [
    { number: "1", name: "V+", type: "passive", side: "right" },
    { number: "2", name: "GND", type: "passive", side: "right" },
    { number: "3", name: "SW", type: "no_connect", side: "right" },
  ],
};

const MCU_STUB: IcSymbolSpec = {
  libId: "Connector:Conn_01x06",
  refPrefix: "J",
  value: "Conn_01x06",
  description: "Six-pin 2.54 mm header.",
  keywords: "connector header",
  footprint: "Connector_PinHeader_2.54mm:PinHeader_1x06_P2.54mm_Vertical",
  pins: [1, 2, 3, 4, 5, 6].map((n) => ({ number: String(n), name: `Pin_${n}`, type: "passive" as const, side: "left" as const })),
};

// #region sheet
export function buildRadioKiosk(): Schematic {
  const schem = emptySchematic(crypto.randomUUID());
  schem.title = "FRC Radio Kiosk v2 - power tree (stage 1)";
  schem.rev = "A";
  schem.company = "Filip Kin";

  const ops: Op[] = [];
  const pinLabels: { ref: string; pin: string; text: string }[] = [];
  const noConnects: { ref: string; pin: string }[] = [];
  const label = (ref: string, pin: string, text: string) => pinLabels.push({ ref, pin, text });
  const nc = (ref: string, pin: string) => noConnects.push({ ref, pin });
  const footprints: [string, string][] = [];

  for (const spec of [LM74700, LMR33630, TLV7011, PMOS_40V, CR123A, BARREL, MCU_STUB]) ops.push({ op: "define_symbol", ...spec });

  const part = (ref: string, libId: string, value: string, x: number, y: number, fp?: string, rotation?: number) => {
    ops.push({ op: "add_symbol", libId, ref, value, at: { x, y }, rotation });
    if (fp) footprints.push([ref, fp]);
  };
  const r = (ref: string, value: string, x: number, y: number, a: string, b: string, fp = FP.r0805) => {
    part(ref, "Device:R", value, x, y, fp);
    label(ref, "1", a);
    label(ref, "2", b);
  };
  const c = (ref: string, value: string, x: number, y: number, a: string, b: string, fp = FP.c0805) => {
    part(ref, "Device:C", value, x, y, fp);
    label(ref, "1", a);
    label(ref, "2", b);
  };

  // An LM74700 ideal diode: the controller, its N-FET and the charge-pump cap.
  // EN is tied to ANODE (always on). Current flows ANODE -> CATHODE only.
  const idealDiode = (n: number, inNet: string, outNet: string, x: number, y: number) => {
    const u = `U${n}`, q = `Q${n}`, cc = `C${n}`;
    part(u, LM74700.libId, "LM74700-Q1", x, y);
    part(q, "Transistor_FET:Power_NMOS_60V", "N-MOSFET 60V", x + 30, y - 10, FP.soic8ep);
    c(cc, "100n", x + 30, y + 14, `${u}_VCAP`, inNet);
    label(u, "1", `${u}_VCAP`);
    label(u, "2", "GND");
    label(u, "3", inNet);
    label(u, "4", outNet);
    label(u, "5", `${u}_GATE`);
    label(u, "6", inNet);
    label(q, "1", `${u}_GATE`);
    label(q, "2", inNet);
    label(q, "3", outNet);
  };

  // An LMR33630 buck at 400 kHz. Values are the datasheet's Table 9-1 rows for
  // 12 V and 5 V; the 18.5 V row is derived (RFBB = 100k / (Vout - 1)).
  // One 10 uH XAL7030 for all three: the 12 V row asks for 15 uH, which only
  // buys lower ripple at loads this board never reaches.
  const buck = (n: number, vout: number, rfbb: string, coutV: string, vinNet: string, voutNet: string, x: number, y: number) => {
    const u = `U${n}`;
    const L = (s: string) => `${u}_${s}`;
    part(u, LMR33630.libId, `LMR33630 ${vout}V`, x, y);
    c(`C${n}0`, "10u/50V", x - 34, y - 6, vinNet, "GND", FP.c1210);
    c(`C${n}1`, "220n/50V", x - 26, y - 6, vinNet, "GND");
    c(`C${n}2`, "1u", x + 34, y + 14, L("VCC"), "GND");
    c(`C${n}3`, "100n", x + 26, y - 20, L("BOOT"), L("SW"));
    part(`L${n}`, "Device:L", "10u 6A", x + 40, y - 12, FP.xal7030);
    label(`L${n}`, "1", L("SW"));
    label(`L${n}`, "2", voutNet);
    for (let i = 0; i < 4; i++) c(`C${n}${4 + i}`, `22u/${coutV}`, x + 56 + i * 8, y + 2, voutNet, "GND", FP.c1210);
    r(`R${n}0`, "100k", x + 48, y + 22, voutNet, L("FB"));
    r(`R${n}1`, rfbb, x + 48, y + 34, L("FB"), "GND");
    label(u, "1", "GND");
    label(u, "2", vinNet);
    label(u, "3", vinNet); // EN straight to VIN: the rail is on whenever its input is
    nc(u, "4"); // PG unused
    label(u, "5", L("FB"));
    label(u, "6", L("VCC"));
    label(u, "7", L("BOOT"));
    label(u, "8", L("SW"));
    label(u, "9", "GND");
  };

  // #region inputs: USB-C PD trigger module and a DC jack, ideal-diode ORed onto VIN
  part("J1", "Connector:Conn_01x02", "USB-C PD trigger 20V", 30, 40, FP.xh2);
  label("J1", "1", "VIN_USB");
  label("J1", "2", "GND");
  part("J2", BARREL.libId, "DC in 18-26V", 30, 90);
  label("J2", "1", "VIN_DC");
  label("J2", "2", "GND");
  nc("J2", "3");
  part("D1", "Device:D", "SMAJ28A TVS", 60, 40, FP.sma);
  label("D1", "1", "VIN_USB");
  label("D1", "2", "GND");
  part("D2", "Device:D", "SMAJ28A TVS", 60, 90, FP.sma);
  label("D2", "1", "VIN_DC");
  label("D2", "2", "GND");
  idealDiode(1, "VIN_USB", "VIN", 100, 40);
  idealDiode(2, "VIN_DC", "VIN", 100, 90);
  c("C90", "22u/50V", 180, 60, "VIN", "GND", FP.c1210);
  c("C91", "22u/50V", 188, 60, "VIN", "GND", FP.c1210);
  // Vin sense: 100k / 11.5k puts 16 V at 1.65 V, the comparator's reference.
  r("R90", "100k", 210, 50, "VIN", "VIN_SENSE");
  r("R91", "11.5k", 210, 62, "VIN_SENSE", "GND");

  // #region rails
  buck(3, 12, "9.09k", "25V", "VIN", "+12V_BUCK", 80, 170);
  idealDiode(6, "+12V_BUCK", "+12V", 230, 170); // blocks the pack from pushing into a dead buck
  buck(4, 18.5, "5.76k", "50V", "VIN", "+18V5_BUCK", 80, 260);
  idealDiode(7, "+18V5_BUCK", "LAPTOP_OUT", 230, 260); // a brick in the wrong jack cannot feed the board
  part("J3", BARREL.libId, "Laptop out 18.5V (use a different barrel size than J2)", 300, 260);
  label("J3", "1", "LAPTOP_OUT");
  label("J3", "2", "GND");
  nc("J3", "3");
  buck(5, 5, "24.9k", "25V", "VIN", "+5V", 80, 350);
  ops.push({ op: "instantiate_module", moduleId: "ldo_3v3", params: { vin_net: "+5V" }, at: { x: 230, y: 350 } });
  // Bulk on the backed-up rail: covers the microseconds between the input
  // dropping and the battery FET closing.
  part("C98", "Device:C_Polarized", "1000u/25V", 330, 180, FP.cRadial10);
  label("C98", "1", "+12V");
  label("C98", "2", "GND");

  // #region battery backup: 4x CR123A, fuse, P-FET switch, comparator
  const bx = 80, by = 450;
  for (let i = 0; i < 4; i++) {
    part(`BT${i + 1}`, CR123A.libId, "CR123A", bx + i * 26, by);
    label(`BT${i + 1}`, "1", i === 0 ? "PACK_P" : `PACK_${i}`);
    label(`BT${i + 1}`, "2", i === 3 ? "GND" : `PACK_${i + 1}`);
  }
  part("F1", "Device:Fuse", "2A", bx + 110, by, FP.fuse1206);
  label("F1", "1", "PACK_P");
  label("F1", "2", "PACK_F");
  // High-side P-FET. Gate held at the pack by R80 (off); Q9 pulls it down (on)
  // when the comparator says the input is gone. Body diode points pack -> rail.
  part("Q8", PMOS_40V.libId, "P-MOSFET 40V", bx + 150, by - 10);
  label("Q8", "3", "PACK_F");
  label("Q8", "2", "+12V");
  label("Q8", "1", "BK_GATE");
  r("R80", "100k", bx + 150, by + 14, "PACK_F", "BK_GATE");
  part("Q9", "Device:Q_NMOS_GSD", "2N7002", bx + 180, by + 14);
  label("Q9", "3", "BK_GATE");
  label("Q9", "2", "GND");
  label("Q9", "1", "BK_DRV");
  r("R81", "1k", bx + 180, by + 34, "BK_ON", "BK_DRV");
  // Comparator: IN- watches the input, IN+ sits at 1.65 V from the 3.3 V rail.
  // OUT goes high (backup on) when VIN_SENSE falls below the reference, i.e.
  // Vin < 16 V. R84 adds ~50 mV of hysteresis so it does not chatter at the edge.
  part("U10", TLV7011.libId, "TLV7011", bx + 230, by);
  label("U10", "5", "+3V3");
  label("U10", "2", "GND");
  label("U10", "4", "VIN_SENSE");
  label("U10", "3", "BK_REF");
  label("U10", "1", "BK_ON");
  r("R82", "10k", bx + 200, by - 20, "+3V3", "BK_REF");
  r("R83", "10k", bx + 200, by - 8, "BK_REF", "GND");
  r("R84", "1M", bx + 230, by - 24, "BK_ON", "BK_REF");
  c("C99", "100n", bx + 260, by, "+3V3", "GND");
  // Pack sense for the MCU (stage 3) and the loaded self-test: Q11 drops the
  // pack into R85 for 200 ms while the ADC reads PACK_SENSE.
  r("R85", "12R 3W", bx + 300, by - 10, "PACK_F", "TEST_NODE", FP.rAxial3W);
  part("Q11", "Transistor_FET:Power_NMOS_60V", "N-MOSFET 60V", bx + 300, by + 14, FP.soic8ep);
  label("Q11", "3", "TEST_NODE");
  label("Q11", "2", "GND");
  label("Q11", "1", "TEST_LOAD");
  r("R86", "100k", bx + 330, by - 10, "PACK_F", "PACK_SENSE");
  r("R87", "11.5k", bx + 330, by + 2, "PACK_SENSE", "GND");

  // The signals stage 3 picks up. A header on this sheet so every net has two
  // ends now; it becomes labels into the MCU block when that stage lands.
  part("J4", MCU_STUB.libId, "to MCU (stage 3)", bx + 380, by);
  for (const [pin, net] of [["1", "VIN_SENSE"], ["2", "PACK_SENSE"], ["3", "TEST_LOAD"], ["4", "BK_ON"], ["5", "+3V3"], ["6", "GND"]] as const) label("J4", pin, net);

  // #region notes
  const notes: [string, number][] = [
    ["STAGE 1 OF 4: power tree. Stage 2 = radio port (802.3at PSE + passive 12 V on the same pins, eFuse, RJ45 pass-through). Stage 3 = MCU, LEDs, fan, sensors. Stage 4 = board, keeping v1's port positions, cells on the bottom side.", 560],
    ["INPUTS: 18-26 V from a USB-C PD trigger module (J1) or a DC jack (J2), ideal-diode ORed. Highest wins. Standard supply is a 24 V 5 A brick; a 19-20 V laptop brick also works. VIN_SENSE feeds the comparator now and the MCU ADC in stage 3 (20 V = 2.06 V, 15 V = 1.55 V, 9 V = 0.93 V, 5 V = 0.52 V).", 575],
    ["RAILS: +12V is the backed-up rail (radio passive output, 54 V PSE boost, 5 V, 3.3 V). LAPTOP_OUT is off the raw input so it sheds itself on a dropout. Bucks are LMR33630 at 400 kHz per datasheet Table 9-1; the 18.5 V one runs in dropout on a 20 V brick and passes ~19 V through, which a laptop accepts.", 590],
    ["BACKUP: 4x CR123A (12 V nominal, no boost, no BMS). Q8 closes when Vin < 16 V, opens when it returns. R84 hysteresis. Firmware (stage 3) opens it after 2 s of no radio load or 5 min, by pulling BK_ON low through a diode-OR at R81 (TBD stage 3). Self-test: TEST_LOAD high for 200 ms, read PACK_SENSE; below ~10 V loaded = replace all four cells.", 605],
    ["ASSEMBLY: OSH Park 2-layer, hand-built. Everything is SOIC / SOT-23 / 0805+ except the three HSOIC-8 bucks and the two SOIC-8 FET packages, whose pads get 4-5 thermal vias and are soldered from the back. No QFN on this board.", 620],
    ["OPEN: J3 must be a different barrel size than J2. Passive-mode radio draw (assumed 10 W) and the PD brick's dropout time still need measuring. BIAS/PG pins unused. MCU override of the backup switch and laptop enable are stage 3.", 635],
  ];
  for (const [text, y] of notes) ops.push({ op: "add_text", text, at: { x: 30, y }, size: 2 });

  const { results } = applyOps(schem, ops, resolve);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.log("failed ops:", [...new Set(failed.map((f) => f.error))].join("; "));

  for (const [ref, fp] of footprints) {
    const inst = schem.symbols.find((x) => x.properties.Reference === ref);
    if (inst) inst.properties.Footprint = fp;
  }

  const defOf = (libId: string) => library.get(libId)?.def ?? schem.libSymbols[libId];
  const late: Op[] = [];
  for (const { ref, pin, text } of pinLabels) {
    const inst = schem.symbols.find((x) => x.properties.Reference === ref);
    const p = inst ? defOf(inst.libId)?.pins.find((x) => x.number === pin) : undefined;
    if (inst && p) late.push({ op: "add_label", text, at: pinWorld(p, inst), kind: "local" });
    else console.log(`no pin for label ${ref}.${pin} ${text}`);
  }
  for (const { ref, pin } of noConnects) {
    const inst = schem.symbols.find((x) => x.properties.Reference === ref);
    const p = inst ? defOf(inst.libId)?.pins.find((x) => x.number === pin) : undefined;
    if (inst && p) late.push({ op: "add_no_connect", at: pinWorld(p, inst) });
  }
  const lateRes = applyOps(schem, late, resolve).results.filter((r) => !r.ok);
  if (lateRes.length) console.log("failed late ops:", [...new Set(lateRes.map((f) => f.error))].join("; "));

  const wired = autowireSheet(schem, resolve);
  console.log(`autowire: ${wired.drawn} drawn, ${wired.skipped} left joined by name`);
  return schem;
}

if (import.meta.main) {
  const schem = buildRadioKiosk();
  const defs = (libId: string) => library.get(libId)?.def ?? schem.libSymbols[libId];
  const nl = buildNetlist(schem, defs);
  console.log(`${schem.symbols.length} parts, ${nl.nets.length} nets, ${schem.labels.length} labels`);
  console.log("biggest nets:", [...nl.nets].sort((a, b) => b.pins.length - a.pins.length).slice(0, 8).map((n) => `${n.name}=${n.pins.length}`).join(" "));
  console.log(formatErc(runErc(schem, defs, nl), 15));

  const project = process.argv[2];
  const unit = process.argv[3] ?? "";
  if (project) {
    const { storage } = await import("../server/src/services/storage");
    const libRaw = library.rawMap(Array.from(new Set(schem.symbols.map((s) => s.libId))));
    await storage.write(project, serializeSchematic(schem, libRaw), unit);
    console.log(`wrote ${project} / ${unit || "main"}`);
  }
}
