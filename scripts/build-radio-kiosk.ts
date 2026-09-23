// FRC radio kiosk v2, stages one and two: the power tree and the radio port.
//
// What this sheet does: take 18-26 V from either a USB-C PD trigger module or a
// DC barrel jack, OR them together, make a 12 V rail that a 4x CR123A pack
// steps in behind when the input drops, plus an 18.5 V laptop rail off the raw
// input (so it sheds itself on a dropout) and 5 V / 3.3 V for the logic.
//
// Stage two adds the radio port: a 54 V boost for 802.3at, a TPS26600 eFuse for
// passive 12 V, a return switch, TVS and the two RJ45s with the data pairs
// passed straight through to the laptop. The PSE controller itself is not
// placed yet (its ADI datasheet could not be fetched from this box).
// Not done: the MCU and its sensors/LEDs/fan (stage three), the board (stage
// four). Every net the later stages need is a named label on this sheet.
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

const LM3478: IcSymbolSpec = {
  libId: "Regulator_Switching:LM3478",
  refPrefix: "U",
  value: "LM3478MA",
  description:
    "Low-side N-FET boost controller, SOIC-8, 2.97-40 V in. Makes the 54 V PSE rail from the backed-up 12 V. Peak current mode; RSEN sets the switch current limit, RFA the frequency (40 k = 400 kHz), FA/SD pulled above 1.35 V shuts it down.",
  keywords: "boost controller step-up low-side n-fet",
  datasheet: "https://www.ti.com/lit/ds/symlink/lm3478.pdf",
  footprint: "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm",
  pins: [
    { number: "1", name: "ISEN", type: "input", side: "left" },
    { number: "2", name: "COMP", type: "passive", side: "left" },
    { number: "3", name: "FB", type: "input", side: "left" },
    { number: "4", name: "AGND", type: "power_in", side: "left" },
    { number: "5", name: "PGND", type: "power_in", side: "right" },
    { number: "6", name: "DR", type: "output", side: "right" },
    { number: "7", name: "FA/SD", type: "input", side: "right" },
    { number: "8", name: "VIN", type: "power_in", side: "right" },
  ],
};

const TPS26600: IcSymbolSpec = {
  libId: "Power_Protection:TPS26600",
  refPrefix: "U",
  value: "TPS26600PWP",
  description:
    "60 V 2.2 A eFuse with back-to-back FETs: reverse current blocking, resistor-set current limit, analog current monitor (78 uA/A on IMON), SHDN, open-drain FLT. HTSSOP-16, pad to RTN. Gates the passive 12 V onto the radio port and is the backfeed detector.",
  keywords: "efuse hot swap reverse blocking current limit monitor",
  datasheet: "https://www.ti.com/lit/ds/symlink/tps2660.pdf",
  footprint: "Package_SO:HTSSOP-16-1EP_4.4x5mm_P0.65mm_EP3.4x5mm",
  pins: [
    { number: "1", name: "IN", type: "power_in", side: "left" },
    { number: "2", name: "IN", type: "power_in", side: "left" },
    { number: "3", name: "UVLO", type: "input", side: "left" },
    { number: "4", name: "NC", type: "no_connect", side: "left" },
    { number: "5", name: "OVP", type: "input", side: "left" },
    { number: "6", name: "MODE", type: "input", side: "left" },
    { number: "7", name: "SHDN", type: "input", side: "left" },
    { number: "8", name: "RTN", type: "power_in", side: "left" },
    { number: "9", name: "GND", type: "power_in", side: "right" },
    { number: "10", name: "IMON", type: "output", side: "right" },
    { number: "11", name: "ILIM", type: "passive", side: "right" },
    { number: "12", name: "dVdT", type: "passive", side: "right" },
    { number: "13", name: "NC", type: "no_connect", side: "right" },
    { number: "14", name: "FLT", type: "open_collector", side: "right" },
    { number: "15", name: "OUT", type: "power_out", side: "right" },
    { number: "16", name: "OUT", type: "power_out", side: "right" },
    { number: "17", name: "PAD", type: "power_in", side: "right" },
  ],
};

const NMOS_100V: IcSymbolSpec = {
  libId: "Transistor_FET:Power_NMOS_100V",
  refPrefix: "Q",
  value: "N-MOSFET 100V (SQ4850EY)",
  description: "100 V N-channel power MOSFET, SOIC-8. The boost switch for the 54 V rail: 60 V is too close to a 54 V output plus ringing.",
  keywords: "mosfet n-channel power 100v",
  footprint: FP.soic8ep,
  pins: [
    { number: "1", name: "G", type: "input", side: "left" },
    { number: "2", name: "S", type: "passive", side: "left" },
    { number: "3", name: "D", type: "passive", side: "right" },
  ],
};

const RJ45: IcSymbolSpec = {
  libId: "Connector:RJ45_8P8C",
  refPrefix: "J",
  value: "RJ45 8P8C",
  description: "Plain 8P8C jack, no magnetics (Amphenol 54602-908 class, the same footprint class as v1's Ckmtw part). Pins 1/2/3/6 are the 100BASE-TX pairs; 4/5 and 7/8 carry PoE Mode B.",
  keywords: "rj45 8p8c ethernet jack",
  footprint: "Connector_RJ:RJ45_Amphenol_54602-x08_Horizontal",
  pins: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ number: String(n), name: String(n), type: "passive" as const, side: "left" as const })),
};

const MCU_STUB: IcSymbolSpec = {
  libId: "Connector:Conn_01x10",
  refPrefix: "J",
  value: "Conn_01x10",
  description: "Ten-pin 2.54 mm header.",
  keywords: "connector header",
  footprint: "Connector_PinHeader_2.54mm:PinHeader_1x10_P2.54mm_Vertical",
  pins: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ number: String(n), name: `Pin_${n}`, type: "passive" as const, side: "left" as const })),
};

// #region sheet
export function buildRadioKiosk(): Schematic {
  const schem = emptySchematic(crypto.randomUUID());
  schem.title = "FRC Radio Kiosk v2 - power tree + radio port (stages 1-2)";
  schem.rev = "A";
  schem.company = "Filip Kin";

  const ops: Op[] = [];
  const pinLabels: { ref: string; pin: string; text: string }[] = [];
  const noConnects: { ref: string; pin: string }[] = [];
  const label = (ref: string, pin: string, text: string) => pinLabels.push({ ref, pin, text });
  const nc = (ref: string, pin: string) => noConnects.push({ ref, pin });
  const footprints: [string, string][] = [];

  for (const spec of [LM74700, LMR33630, TLV7011, PMOS_40V, CR123A, BARREL, LM3478, TPS26600, NMOS_100V, RJ45, MCU_STUB]) ops.push({ op: "define_symbol", ...spec });

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
  for (const [pin, net] of [
    ["1", "VIN_SENSE"], ["2", "PACK_SENSE"], ["3", "TEST_LOAD"], ["4", "BK_ON"],
    ["5", "BOOST_SD"], ["6", "PASSIVE_EN"], ["7", "PASSIVE_IMON"], ["8", "PASSIVE_FLT"],
    ["9", "+3V3"], ["10", "GND"],
  ] as const) label("J4", pin, net);

  // #region stage 2: radio port
  // Both PoE flavours share the port pins: + on 4/5, - on 7/8 (802.3 Mode B,
  // same polarity v1 used). Active: the 54 V rail sits on PORT_P and the PSE
  // switches PORT_N to ground. Passive: the eFuse puts 12 V on PORT_P and Q13
  // ties PORT_N to ground. Never both: firmware holds BOOST_SD high whenever
  // PASSIVE_EN is high. The eFuse's back-to-back FETs block 54 V from reaching
  // the 12 V rail, and the boost diode blocks 12 V from reaching the boost.
  const px = 560, py = 40;

  // 12 V -> 54 V boost, LM3478 at 400 kHz. Sized for the radio (10-15 W), not a
  // full 30 W class-4 load: at D = 0.78 the LM3478 has ~84 mV of sense headroom,
  // and 20 mR puts the peak switch limit near 4 A.
  part("U20", LM3478.libId, "LM3478 54V boost", px, py);
  part("Q20", NMOS_100V.libId, "N-MOSFET 100V", px + 50, py - 20);
  part("L20", "Device:L", "33u 4A", px + 30, py - 40, "Inductor_SMD:L_12x12mm_H6mm");
  part("D20", "Device:D", "B3100 100V Schottky", px + 70, py - 40, FP.sma);
  r("R20", "20m 1W", px + 50, py + 6, "BOOST_CS", "GND", FP.r2512);
  r("R21", "40.2k", px - 30, py + 14, "BOOST_FA", "GND");
  r("R22", "402k", px + 100, py - 10, "+54V", "BOOST_FB");
  r("R23", "9.53k", px + 100, py + 2, "BOOST_FB", "GND");
  c("C20", "100p", px + 110, py + 2, "BOOST_FB", "GND");
  r("R24", "10k", px - 30, py - 10, "BOOST_COMP", "BOOST_COMPC");
  c("C21", "47n", px - 30, py + 2, "BOOST_COMPC", "GND");
  c("C22", "10u/25V", px - 30, py - 30, "+12V", "GND", FP.c1210);
  c("C23", "4.7u/100V", px + 100, py - 30, "+54V", "GND", FP.c1210);
  c("C24", "4.7u/100V", px + 108, py - 30, "+54V", "GND", FP.c1210);
  part("C25", "Device:C_Polarized", "47u/63V", px + 120, py - 30, FP.cRadial10);
  label("C25", "1", "+54V");
  label("C25", "2", "GND");
  // Shutdown from the MCU through a diode so R21 alone still sets the frequency.
  r("R25", "1k", px - 50, py + 26, "BOOST_SD", "BOOST_SDD");
  part("D21", "Device:D", "1N4148W", px - 40, py + 26);
  label("D21", "2", "BOOST_SDD");
  label("D21", "1", "BOOST_FA");
  label("U20", "1", "BOOST_CS");
  label("U20", "2", "BOOST_COMP");
  label("U20", "3", "BOOST_FB");
  label("U20", "4", "GND");
  label("U20", "5", "GND");
  label("U20", "6", "BOOST_DR");
  label("U20", "7", "BOOST_FA");
  label("U20", "8", "+12V");
  label("Q20", "1", "BOOST_DR");
  label("Q20", "2", "BOOST_CS");
  label("Q20", "3", "BOOST_SW");
  label("L20", "1", "+12V");
  label("L20", "2", "BOOST_SW");
  label("D20", "2", "BOOST_SW");
  label("D20", "1", "+54V");

  // Passive path: TPS26600 eFuse. ILIM 8.06k = 1.5 A (R = 12k / I). IMON into
  // 10k gives 0.78 V per amp on PASSIVE_IMON, so 1.5 A reads 1.17 V at the ADC.
  // A robot backfeeding through the radio's raw leads shows up here as current
  // the radio alone would never draw. SHDN low = off, so the port is dead until
  // firmware asks for passive.
  const ex = px, ey = py + 90;
  part("U21", TPS26600.libId, "TPS26600 eFuse", ex, ey);
  label("U21", "1", "+12V");
  label("U21", "2", "+12V");
  label("U21", "3", "GND"); // UVLO default
  nc("U21", "4");
  label("U21", "5", "GND"); // OVP default
  nc("U21", "6"); // MODE open = auto-retry
  label("U21", "7", "PASSIVE_EN");
  label("U21", "8", "GND");
  label("U21", "9", "GND");
  label("U21", "10", "PASSIVE_IMON");
  label("U21", "11", "PASSIVE_ILIM");
  label("U21", "12", "PASSIVE_DVDT");
  nc("U21", "13");
  label("U21", "14", "PASSIVE_FLT");
  label("U21", "15", "PORT_P");
  label("U21", "16", "PORT_P");
  label("U21", "17", "GND");
  r("R60", "8.06k", ex + 50, ey - 10, "PASSIVE_ILIM", "GND");
  r("R61", "10k", ex + 50, ey + 2, "PASSIVE_IMON", "GND");
  c("C60", "10n", ex + 50, ey + 14, "PASSIVE_DVDT", "GND");
  r("R62", "10k", ex + 50, ey + 26, "+3V3", "PASSIVE_FLT");
  r("R63", "100k", ex - 30, ey + 20, "PASSIVE_EN", "GND");
  c("C61", "1u/50V", ex - 30, ey - 10, "+12V", "GND", FP.c1206);
  c("C62", "1u/100V", ex + 70, ey - 10, "PORT_P", "GND", FP.c1210);
  // Passive return: ties PORT_N to ground while PASSIVE_EN is high. Off in
  // active mode so the PSE's own switch owns the return.
  part("Q13", "Transistor_FET:Power_NMOS_60V", "N-MOSFET 60V logic-level", ex + 100, ey + 10, FP.soic8ep);
  label("Q13", "1", "PASSIVE_EN");
  label("Q13", "2", "GND");
  label("Q13", "3", "PORT_N");

  // Port protection and the two jacks. J5 is the radio, J6 the laptop; only the
  // data pairs pass through, so the laptop never sees DC and links at 100 Mbps.
  const jx = px + 160, jy = ey + 60;
  part("D22", "Device:D", "SMAJ58A TVS", jx - 30, jy - 30, FP.sma);
  label("D22", "1", "PORT_P");
  label("D22", "2", "PORT_N");
  part("J5", RJ45.libId, "RJ45 radio", jx, jy);
  part("J6", RJ45.libId, "RJ45 laptop", jx + 60, jy);
  for (const p of ["1", "2", "3", "6"]) {
    label("J5", p, `ETH_${p}`);
    label("J6", p, `ETH_${p}`);
  }
  label("J5", "4", "PORT_P");
  label("J5", "5", "PORT_P");
  label("J5", "7", "PORT_N");
  label("J5", "8", "PORT_N");
  for (const p of ["4", "5", "7", "8"]) nc("J6", p);

  // #region notes
  const notes: [string, number][] = [
    ["STAGES 1+2 OF 4: power tree and radio port. Stage 3 = MCU, LEDs, fan, sensors. Stage 4 = board, keeping v1's port positions, cells on the bottom side.", 560],
    ["RADIO PORT: PORT_P = pins 4/5, PORT_N = pins 7/8 (Mode B). Active: +54V on PORT_P, the PSE switches PORT_N to ground. Passive: U21 eFuse puts 12 V on PORT_P, Q13 grounds PORT_N. Firmware never enables both: BOOST_SD high whenever PASSIVE_EN is high. Sequence: PSE detect first; valid signature = active; open/invalid = passive.", 650],
    ["PSE PENDING: the 802.3at controller (LTC4263-1 or LTC4279 class, autonomous single port, switch in the return lead) is not placed yet because its datasheet could not be fetched from this box. Its interface on this sheet: AGND = +54V, VEE = GND, OUT = PORT_N, plus a shutdown and a status line to J4.", 665],
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
