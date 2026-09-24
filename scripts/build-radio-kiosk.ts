// FRC radio kiosk v2, stages one and two: the power tree and the radio port.
//
// What this sheet does: take 14-26 V from either a USB-C PD trigger module or a
// DC barrel jack, OR them together, make a 12 V rail that a 4x CR123A pack
// steps in behind when the input drops, plus a 15.6 V laptop rail off the raw
// input (so it sheds itself on a dropout) and 5 V / 3.3 V for the logic.
//
// Stage three is the MCU (STM32F072, USB DFU, no radio), two WS2812B, the fan,
// an NTC and the battery-kill FET.
// Stage two adds the radio port: a 54 V boost for 802.3at, a TPS26600 eFuse for
// passive 12 V, a return switch, TVS and the two RJ45s with the data pairs
// passed straight through to the laptop. The PSE controller itself is not
// placed yet (its ADI datasheet could not be fetched from this box).
// Not done: the board (stage four).
//
// All SMT except the connectors and the cell holders, so the same BOM goes to
// an assembly house later without a part change. The first 2-4 are hand-built,
// so every IC is SO / SOT-23 / HTSSOP (no leadless packages) and passives are
// 0805 and up. Exposed pads get back-side vias for the hot-air pass.
//
// Run: bun run scripts/build-radio-kiosk.ts <project> [board]
import { library } from "../server/src/services/library";
import { emptySchematic, type Schematic } from "@loon/shared/schematic";
import { applyOps, autowireSheet, type LibResolver } from "@loon/shared/apply-ops";
import { compactSheet } from "@loon/shared/compact";
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
  c0805: "Capacitor_SMD:C_0805_2012Metric",
  c1206: "Capacitor_SMD:C_1206_3216Metric",
  c1210: "Capacitor_SMD:C_1210_3225Metric",
  cElec10: "Capacitor_SMD:CP_Elec_10x10.5",
  sma: "Diode_SMD:D_SMA",
  sot23: "Package_TO_SOT_SMD:SOT-23",
  sot23_5: "Package_TO_SOT_SMD:SOT-23-5",
  sot23_6: "Package_TO_SOT_SMD:SOT-23-6",
  hsoic8: "Package_SO:SOIC-8-1EP_3.9x4.9mm_P1.27mm_EP2.29x3mm",
  soic8ep: "Package_SO:SOIC-8-1EP_3.9x4.9mm_P1.27mm_EP2.41x3.3mm",
  to252: "Package_TO_SOT_SMD:TO-252-2",
  srp7028: "Inductor_SMD:L_Bourns_SRP7028A_7.3x6.6mm",
  lfpak33: "Package_TO_SOT_SMD:LFPAK33",
  cElec8: "Capacitor_SMD:CP_Elec_8x10.5",
  fuse1206: "Fuse:Fuse_1206_3216Metric",
  xh2: "LCSC:CONN-TH_XH-2A", // LCSC footprints imported with easyeda2kicad into data/footprints
  barrel: "LCSC:DC-IN-TH_PJ-002BH",
  cr123a: "LCSC:BAT-TH_BH-123A-A5BJ002",
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
    "36 V 3 A synchronous buck, 400 kHz, HSOIC-8. Used three times (12 V, 15.6 V, 5 V) so the BOM has one buck. Auto mode, so it skips pulses at very light load; the 12 V rail always carries the logic so it stays out of that region. If a rail whines, this is the part to swap.",
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
  value: "AOD4185 P-MOSFET 40V",
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
  description: "One CR123A lithium primary cell in a BH-123A PCB holder (LCSC C5290177, footprint from LCSC via easyeda2kicad; pad 1/2 polarity to be confirmed on the physical part). Four in series make the 12 V backup pack. Replace all four together.",
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
  value: "Barrel jack",
  description: "DC barrel jack 5.5x2.5, CUI PJ-002BH (LCSC C22359705, footprint from LCSC), centre positive. Pin 1 centre pin, 2 sleeve, 3 the normally-closed switch contact, left open.",
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

// SOIC-8 power FETs really are S on 1-3, G on 4, D on 5-8 (the 1EP pattern's
// tab is the drain). A three-pin symbol on this pattern puts the gate on a
// source pin and floats the drain, which is what the first cut of v2 did.
const SOIC8_FET_PINS: IcSymbolSpec["pins"] = [
  { number: "1", name: "S", type: "passive", side: "left" },
  { number: "2", name: "S", type: "passive", side: "left" },
  { number: "3", name: "S", type: "passive", side: "left" },
  { number: "4", name: "G", type: "input", side: "left" },
  { number: "5", name: "D", type: "passive", side: "right" },
  { number: "6", name: "D", type: "passive", side: "right" },
  { number: "7", name: "D", type: "passive", side: "right" },
  { number: "8", name: "D", type: "passive", side: "right" },
];
const NMOS_100V: IcSymbolSpec = {
  libId: "Transistor_FET:Power_NMOS_100V",
  refPrefix: "Q",
  value: "AO4482 N-MOSFET 100V",
  description: "100 V N-channel power MOSFET, SOIC-8. The boost switch for the 54 V rail: 60 V is too close to a 54 V output plus ringing.",
  keywords: "mosfet n-channel power 100v",
  footprint: FP.soic8ep,
  pins: [...SOIC8_FET_PINS, { number: "9", name: "D", type: "passive", side: "right" }],
};
const NMOS_60V: IcSymbolSpec = {
  libId: "Transistor_FET:Power_NMOS_60V_SO8",
  refPrefix: "Q",
  value: "SI4470EY N-MOSFET 60V",
  description: "60 V 10 A N-channel MOSFET, SOIC-8: the ideal-diode pass elements, the port FET and the pack test-load switch.",
  keywords: "mosfet n-channel power 60v",
  footprint: "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm",
  pins: SOIC8_FET_PINS,
};

const RJ45: IcSymbolSpec = {
  libId: "Connector:RJ45_8P8C",
  refPrefix: "J",
  value: "RJ45 8P8C",
  description: "Plain 8P8C jack, no magnetics: Ckmtw R-RJ45R08P-A004, the part v1 used (LCSC C385834, footprint from LCSC). Pins 1/2/3/6 are the 100BASE-TX pairs; 4/5 and 7/8 carry PoE Mode B.",
  keywords: "rj45 8p8c ethernet jack",
  footprint: "LCSC:RJ45-TH_R-RJ45R08P-A004",
  pins: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ number: String(n), name: String(n), type: "passive" as const, side: "left" as const })),
};

const LTC4279: IcSymbolSpec = {
  libId: "Power_Management:LTC4279",
  refPrefix: "U",
  value: "LTC4279IS#PBF",
  description:
    "Autonomous single-port 802.3at PSE controller, SO-16. Does detection, classification, inrush, current limit and disconnect on its own; the MCU only holds RESET and reads LED. Its 'AGND' is the port positive (54 V) and its 'VEE' is board ground: the external FET switches the port negative.",
  keywords: "poe pse controller 802.3at power sourcing",
  datasheet: "https://www.analog.com/media/en/technical-documentation/data-sheets/4279fa.pdf",
  footprint: "Package_SO:SOIC-16_3.9x9.9mm_P1.27mm",
  pins: [
    { number: "1", name: "MID", type: "input", side: "left" },
    { number: "2", name: "DNC", type: "no_connect", side: "left" },
    { number: "3", name: "DNC", type: "no_connect", side: "left" },
    { number: "4", name: "VSSK", type: "input", side: "left" },
    { number: "5", name: "SENSE", type: "input", side: "left" },
    { number: "6", name: "GATE", type: "output", side: "left" },
    { number: "7", name: "OUT", type: "input", side: "left" },
    { number: "8", name: "AGND", type: "power_in", side: "left" },
    { number: "9", name: "LED", type: "open_collector", side: "right" },
    { number: "10", name: "VEE", type: "power_in", side: "right" },
    { number: "11", name: "DNC", type: "no_connect", side: "right" },
    { number: "12", name: "PWRMODE", type: "passive", side: "right" },
    { number: "13", name: "LEGACY", type: "input", side: "right" },
    { number: "14", name: "DUALPD", type: "input", side: "right" },
    { number: "15", name: "DNC", type: "no_connect", side: "right" },
    { number: "16", name: "RESET", type: "input", side: "right" },
  ],
};

const PSMN075: IcSymbolSpec = {
  libId: "Transistor_FET:PSMN075-100MSEX",
  refPrefix: "Q",
  value: "PSMN075-100MSEX",
  description: "100 V N-channel MOSFET in LFPAK33, the part ADI recommends for the LTC4279 port switch (its SOA is what matters, not RDS(on)). Pins 1-3 source, 4 gate, tab drain.",
  keywords: "mosfet n-channel poe pse switch lfpak33",
  footprint: FP.lfpak33,
  pins: [
    { number: "1", name: "S", type: "passive", side: "left" },
    { number: "2", name: "S", type: "passive", side: "left" },
    { number: "3", name: "S", type: "passive", side: "left" },
    { number: "4", name: "G", type: "input", side: "left" },
    { number: "5", name: "D", type: "passive", side: "right" },
  ],
};

// STM32F072CBT6, LQFP-48, pin numbers from DocID025004 Table 13 (LQFP48 column).
// Crystal-less USB (HSI48) with the ROM DFU bootloader, so the USB-C serial
// port is also the programmer: hold BOOT0 at reset and it enumerates as DFU.
const STM32_PINS: { n: number; name: string; t?: IcSymbolSpec["pins"][number]["type"] }[] = [
  { n: 1, name: "VBAT", t: "power_in" }, { n: 2, name: "PC13" }, { n: 3, name: "PC14/OSC32_IN" }, { n: 4, name: "PC15/OSC32_OUT" },
  { n: 5, name: "PF0/OSC_IN" }, { n: 6, name: "PF1/OSC_OUT" }, { n: 7, name: "NRST", t: "input" }, { n: 8, name: "VSSA", t: "power_in" },
  { n: 9, name: "VDDA", t: "power_in" }, { n: 10, name: "PA0/ADC0" }, { n: 11, name: "PA1/ADC1" }, { n: 12, name: "PA2/ADC2" },
  { n: 13, name: "PA3/ADC3" }, { n: 14, name: "PA4/ADC4" }, { n: 15, name: "PA5/ADC5" }, { n: 16, name: "PA6/ADC6/TIM3_CH1" },
  { n: 17, name: "PA7/ADC7" }, { n: 18, name: "PB0/ADC8" }, { n: 19, name: "PB1/ADC9" }, { n: 20, name: "PB2" },
  { n: 21, name: "PB10" }, { n: 22, name: "PB11" }, { n: 23, name: "VSS", t: "power_in" }, { n: 24, name: "VDD", t: "power_in" },
  { n: 25, name: "PB12" }, { n: 26, name: "PB13" }, { n: 27, name: "PB14" }, { n: 28, name: "PB15" },
  { n: 29, name: "PA8/TIM1_CH1" }, { n: 30, name: "PA9" }, { n: 31, name: "PA10" }, { n: 32, name: "PA11/USB_DM" },
  { n: 33, name: "PA12/USB_DP" }, { n: 34, name: "PA13/SWDIO" }, { n: 35, name: "VSS", t: "power_in" }, { n: 36, name: "VDDIO2", t: "power_in" },
  { n: 37, name: "PA14/SWCLK" }, { n: 38, name: "PA15" }, { n: 39, name: "PB3" }, { n: 40, name: "PB4" },
  { n: 41, name: "PB5" }, { n: 42, name: "PB6" }, { n: 43, name: "PB7" }, { n: 44, name: "BOOT0", t: "input" },
  { n: 45, name: "PB8" }, { n: 46, name: "PB9" }, { n: 47, name: "VSS", t: "power_in" }, { n: 48, name: "VDD", t: "power_in" },
];
const STM32F072: IcSymbolSpec = {
  libId: "MCU_ST_STM32F0:STM32F072CBT6",
  refPrefix: "U",
  value: "STM32F072CBT6",
  description:
    "STM32F072, Cortex-M0 48 MHz, 128 KB flash (the C8 at 64 KB left no room: the first firmware was 97% of it), LQFP-48. Crystal-less USB full-speed device with the ROM DFU bootloader, 12-bit ADC. No radio on the board.",
  keywords: "stm32 mcu cortex-m0 usb dfu lqfp48",
  datasheet: "https://www.st.com/resource/en/datasheet/stm32f072cb.pdf",
  footprint: "Package_QFP:LQFP-48_7x7mm_P0.5mm",
  pins: STM32_PINS.map((p, i) => ({ number: String(p.n), name: p.name, type: p.t ?? "bidirectional", side: i < 24 ? "left" : "right" })),
};

const SWD_HDR: IcSymbolSpec = {
  libId: "Connector:Conn_01x04",
  refPrefix: "J",
  value: "SWD",
  description: "Four-pin 2.54 mm header: SWDIO, SWCLK, 3V3, GND. Only needed if the DFU bootloader is ever lost.",
  keywords: "connector header swd debug",
  footprint: "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical",
  pins: [1, 2, 3, 4].map((n) => ({ number: String(n), name: `Pin_${n}`, type: "passive" as const, side: "left" as const })),
};

const INA180: IcSymbolSpec = {
  libId: "Amplifier_Current:INA180A1",
  refPrefix: "U",
  value: "INA180A1IDBVR",
  description: "High-side current-sense amplifier, gain 20, 26 V common mode, SOT-23-5 (pinout A). Measures the USB-C input current.",
  keywords: "current sense amplifier high side",
  datasheet: "https://www.ti.com/lit/ds/symlink/ina180.pdf",
  footprint: FP.sot23_5,
  pins: [
    { number: "1", name: "OUT", type: "output", side: "right" },
    { number: "2", name: "GND", type: "power_in", side: "left" },
    { number: "3", name: "IN+", type: "input", side: "left" },
    { number: "4", name: "IN-", type: "input", side: "left" },
    { number: "5", name: "VS", type: "power_in", side: "right" },
  ],
};

const INA180A2: IcSymbolSpec = { ...INA180, libId: "Amplifier_Current:INA180A2", value: "INA180A2IDBVR", description: "High-side current-sense amplifier, gain 50, SOT-23-5 (pinout A). Laptop rail current for the constant-current loop: 1 V per amp with a 20 mR shunt." };

const LMV321: IcSymbolSpec = {
  libId: "Amplifier_Operational:LMV321",
  refPrefix: "U",
  value: "LMV321",
  description: "Rail-to-rail single op-amp, SOT-23-5. The integrator of the laptop rail's constant-current loop: when the rail current exceeds the firmware setpoint it lifts the buck's FB pin and the rail folds back instead of the charger tripping.",
  keywords: "opamp single rail-to-rail",
  datasheet: "https://www.ti.com/lit/ds/symlink/lmv321.pdf",
  footprint: FP.sot23_5,
  pins: [
    { number: "1", name: "IN+", type: "input", side: "left" },
    { number: "2", name: "GND", type: "power_in", side: "left" },
    { number: "3", name: "IN-", type: "input", side: "left" },
    { number: "4", name: "OUT", type: "output", side: "right" },
    { number: "5", name: "VCC", type: "power_in", side: "right" },
  ],
};

const USBC_PD: IcSymbolSpec = {
  libId: "Connector:USB_C_Receptacle_PD",
  refPrefix: "J",
  value: "TYPE-C-31-M-12",
  description: "USB-C 16-pin receptacle rated 20 V 5 A (Korean Hroparts TYPE-C-31-M-12, LCSC C165948, footprint from LCSC). The USB 2.0 subset: VBUS, GND, CC1/CC2, D+/D-, SBU. Pad names follow the land pattern, paired pads share a name.",
  keywords: "usb-c receptacle power delivery 100w",
  footprint: "LCSC:USB-C_TYPE-C-31-M-12",
  pins: [
    { number: "A4B9", name: "VBUS", type: "power_in", side: "left" },
    { number: "B4A9", name: "VBUS", type: "power_in", side: "left" },
    { number: "A1B12", name: "GND", type: "power_in", side: "left" },
    { number: "B1A12", name: "GND", type: "power_in", side: "left" },
    { number: "A5", name: "CC1", type: "bidirectional", side: "right" },
    { number: "B5", name: "CC2", type: "bidirectional", side: "right" },
    { number: "A6", name: "D+", type: "bidirectional", side: "right" },
    { number: "A7", name: "D-", type: "bidirectional", side: "right" },
    { number: "B6", name: "D+2", type: "bidirectional", side: "right" },
    { number: "B7", name: "D-2", type: "bidirectional", side: "right" },
    { number: "A8", name: "SBU1", type: "no_connect", side: "right" },
    { number: "B8", name: "SBU2", type: "no_connect", side: "right" },
    { number: "1", name: "SHELL", type: "passive", side: "left" },
    { number: "2", name: "SHELL", type: "passive", side: "left" },
    { number: "3", name: "SHELL", type: "passive", side: "left" },
    { number: "4", name: "SHELL", type: "passive", side: "left" },
  ],
};

const CH224A: IcSymbolSpec = {
  libId: "Interface_USB:CH224A",
  refPrefix: "U",
  value: "CH224A",
  description: "USB PD sink controller, ESSOP-10. Asks the charger for 20 V (CFG1 120k to GND, CFG2/CFG3 have internal pull-ups). VHV takes VBUS directly. PG is open-drain, low when the request was granted. Replaces the plug-in trigger board. Pinout from the WCH CH224 datasheet v2.0 Table 4-1.",
  keywords: "usb pd sink trigger decoy",
  footprint: "LCSC:ESSOP-10_CH224A",
  pins: [
    { number: "1", name: "VHV", type: "power_in", side: "left" },
    { number: "2", name: "CFG2/SCL", type: "input", side: "left" },
    { number: "3", name: "CFG3/SDA", type: "input", side: "left" },
    { number: "4", name: "DP", type: "bidirectional", side: "left" },
    { number: "5", name: "DM", type: "bidirectional", side: "left" },
    { number: "6", name: "CC2", type: "bidirectional", side: "right" },
    { number: "7", name: "CC1", type: "bidirectional", side: "right" },
    { number: "8", name: "VBUS", type: "input", side: "right" },
    { number: "9", name: "CFG1", type: "input", side: "right" },
    { number: "10", name: "PG", type: "open_collector", side: "right" },
    { number: "11", name: "EPAD", type: "power_in", side: "right" },
  ],
};

const WS2812B_4020: IcSymbolSpec = {
  libId: "LED:WS2812B-4020",
  refPrefix: "D",
  value: "WS2812B-4020",
  description: "Side-emitting addressable RGB LED, 4 x 2 mm, sits at the board edge and shines out through the case wall next to the port it describes. Pinout from the WS2812B-4020 datasheet (LCSC C965557).",
  keywords: "rgb led addressable side view",
  footprint: "LCSC:LED-SMD_WS2812B-4020",
  pins: [
    { number: "1", name: "DIN", type: "input", side: "left" },
    { number: "2", name: "VDD", type: "power_in", side: "left" },
    { number: "3", name: "DOUT", type: "output", side: "right" },
    { number: "4", name: "VSS", type: "power_in", side: "left" },
  ],
};

const XH3: IcSymbolSpec = {
  libId: "Connector:Conn_XH_1x03",
  refPrefix: "J",
  value: "XH-3A",
  description: "JST XH 3-pin: 5 V, WS2812 data, GND, for LEDs on the lid (a WS2812 string on a wire, or a small carrier), chained after D31.",
  keywords: "connector xh led lid",
  footprint: "LCSC:CONN-TH_XH-3A",
  pins: [
    { number: "1", name: "5V", type: "power_in", side: "left" },
    { number: "2", name: "DATA", type: "input", side: "left" },
    { number: "3", name: "GND", type: "power_in", side: "left" },
  ],
};

const AHCT1G125: IcSymbolSpec = {
  libId: "Logic_LevelTranslator:SN74AHCT1G125",
  refPrefix: "U",
  value: "SN74AHCT1G125DBVR",
  description: "Single 5 V buffer with TTL-level input, SOT-23-5. Lifts the ESP32's 3.3 V LED data line to 5 V, which the WS2812B needs (its VIH is 0.7 x VDD).",
  keywords: "buffer level shifter 3v3 to 5v",
  datasheet: "https://www.ti.com/lit/ds/symlink/sn74ahct1g125.pdf",
  footprint: FP.sot23_5,
  pins: [
    { number: "1", name: "OE", type: "input", side: "left" },
    { number: "2", name: "A", type: "input", side: "left" },
    { number: "3", name: "GND", type: "power_in", side: "left" },
    { number: "4", name: "Y", type: "output", side: "right" },
    { number: "5", name: "VCC", type: "power_in", side: "right" },
  ],
};

const WS2812B: IcSymbolSpec = {
  libId: "LED:WS2812B",
  refPrefix: "D",
  value: "WS2812B-B",
  description: "Addressable RGB LED, 5050, one data line for any number of them. Pinout from the WS2812B-B/T datasheet (LCSC C2761795).",
  keywords: "rgb led addressable neopixel",
  footprint: "LED_SMD:LED_WS2812B_PLCC4_5.0x5.0mm_P3.2mm",
  pins: [
    { number: "1", name: "VDD", type: "power_in", side: "left" },
    { number: "2", name: "DOUT", type: "output", side: "right" },
    { number: "3", name: "VSS", type: "power_in", side: "left" },
    { number: "4", name: "DIN", type: "input", side: "left" },
  ],
};

const NTC: IcSymbolSpec = {
  libId: "Device:Thermistor_NTC",
  refPrefix: "RT",
  value: "10k NTC B3380 (NCP18XH103F03RB)",
  description: "10 k NTC thermistor, 0603, placed between the bucks and the boost. Half of a divider with a 10 k to 3.3 V.",
  keywords: "ntc thermistor temperature",
  footprint: "Resistor_SMD:R_0603_1608Metric",
  pins: [
    { number: "1", name: "1", type: "passive", side: "left" },
    { number: "2", name: "2", type: "passive", side: "right" },
  ],
};

// #region sheet
export function buildRadioKiosk(): Schematic {
  const schem = emptySchematic(crypto.randomUUID());
  schem.title = "FRC Radio Kiosk v2";
  schem.rev = "A";
  schem.company = "Filip Kin";

  const ops: Op[] = [];
  const pinLabels: { ref: string; pin: string; text: string }[] = [];
  const noConnects: { ref: string; pin: string }[] = [];
  const label = (ref: string, pin: string, text: string) => pinLabels.push({ ref, pin, text });
  const nc = (ref: string, pin: string) => noConnects.push({ ref, pin });
  const footprints: [string, string][] = [];

  for (const spec of [LM74700, LMR33630, TLV7011, PMOS_40V, NMOS_60V, CR123A, BARREL, LM3478, TPS26600, NMOS_100V, RJ45, LTC4279, PSMN075, STM32F072, SWD_HDR, INA180, INA180A2, LMV321, AHCT1G125, WS2812B, WS2812B_4020, USBC_PD, CH224A, NTC, XH3]) ops.push({ op: "define_symbol", ...spec });

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
    part(q, NMOS_60V.libId, "SI4470EY", x + 30, y - 10);
    c(cc, "100n", x + 30, y + 14, `${u}_VCAP`, inNet);
    label(u, "1", `${u}_VCAP`);
    label(u, "2", "GND");
    label(u, "3", inNet);
    label(u, "4", outNet);
    label(u, "5", `${u}_GATE`);
    label(u, "6", inNet);
    label(q, "4", `${u}_GATE`);
    for (const n of ["1", "2", "3"]) label(q, n, inNet);
    for (const n of ["5", "6", "7", "8"]) label(q, n, outNet);
  };

  // An LMR33630 buck at 400 kHz. Values are the datasheet's Table 9-1 rows for
  // 12 V and 5 V; the 15.6 V row is derived (RFBB = 100k / (Vout - 1)).
  // One 10 uH XAL7030 for all three: the 12 V row asks for 15 uH, which only
  // buys lower ripple at loads this board never reaches.
  const buck = (n: number, vout: number, rfbb: string, coutV: string, vinNet: string, voutNet: string, x: number, y: number, enNet?: string) => {
    const u = `U${n}`;
    const L = (s: string) => `${u}_${s}`;
    part(u, LMR33630.libId, `LMR33630 ${vout}V`, x, y);
    c(`C${n}0`, "10u/50V", x - 34, y - 6, vinNet, "GND", FP.c1210);
    c(`C${n}1`, "220n/50V", x - 26, y - 6, vinNet, "GND");
    c(`C${n}2`, "1u", x + 34, y + 14, L("VCC"), "GND");
    c(`C${n}3`, "100n", x + 26, y - 20, L("BOOT"), L("SW"));
    part(`L${n}`, "Device:L", "SRP7028A-100M 10u 5A", x + 40, y - 12, FP.srp7028);
    label(`L${n}`, "1", L("SW"));
    label(`L${n}`, "2", voutNet);
    for (let i = 0; i < 4; i++) c(`C${n}${4 + i}`, `22u/${coutV}`, x + 56 + i * 8, y + 2, voutNet, "GND", FP.c1210);
    r(`R${n}0`, "100k", x + 48, y + 22, voutNet, L("FB"));
    r(`R${n}1`, rfbb, x + 48, y + 34, L("FB"), "GND");
    label(u, "1", "GND");
    label(u, "2", vinNet);
    label(u, "3", enNet ?? vinNet); // EN to VIN = on whenever its input is; or to an MCU line
    nc(u, "4"); // PG unused
    label(u, "5", L("FB"));
    label(u, "6", L("VCC"));
    label(u, "7", L("BOOT"));
    label(u, "8", L("SW"));
    label(u, "9", "GND");
  };

  // #region inputs: USB-C PD trigger module and a DC jack, ideal-diode ORed onto VIN
  // USB-C PD input on the board: the receptacle and a CH224A asking for 20 V.
  // VBUS lands on VIN_USB as the trigger board's output used to.
  part("J1", USBC_PD.libId, "USB-C PD in", 30, 40);
  label("J1", "A4B9", "VIN_USB");
  label("J1", "B4A9", "VIN_USB");
  label("J1", "A1B12", "GND");
  label("J1", "B1A12", "GND");
  label("J1", "A5", "PD_CC1");
  label("J1", "B5", "PD_CC2");
  label("J1", "A6", "PD_DP");
  label("J1", "A7", "PD_DM");
  label("J1", "B6", "PD_DP");
  label("J1", "B7", "PD_DM");
  nc("J1", "A8");
  nc("J1", "B8");
  for (const p of ["1", "2", "3", "4"]) label("J1", p, "GND");
  part("U50", CH224A.libId, "CH224A", 30, 60);
  label("U50", "1", "VIN_USB");
  label("U50", "8", "VIN_USB");
  // CFG2/CFG3 double as I2C (address 0x22): status, granted-level current
  // and the source's PDO list (regs 0x60-0x8F). Internal pull-ups, 3.3 V ok.
  label("U50", "2", "PD_SCL");
  label("U50", "3", "PD_SDA");
  label("U50", "4", "PD_DP");
  label("U50", "5", "PD_DM");
  label("U50", "6", "PD_CC2");
  label("U50", "7", "PD_CC1");
  label("U50", "9", "PD_CFG1");
  label("U50", "10", "PD_PG");
  label("U50", "11", "GND");
  r("R120", "120k 1%", 50, 60, "PD_CFG1", "GND"); // 120k = 20 V (CH224 Table 5-1)
  c("C140", "1u/50V", 50, 70, "VIN_USB", "GND", FP.c1206);
  r("R121", "10k", 62, 80, "+3V3", "PD_PG"); // not under C140: their pin ends would meet and join +3V3 to GND
  part("J2", BARREL.libId, "DC in 18-26V, PJ-002BH 5.5x2.5", 30, 90);
  label("J2", "1", "VIN_DC");
  label("J2", "2", "GND");
  nc("J2", "3");
  part("D1", "Device:D", "SMAJ28A TVS", 60, 40, FP.sma);
  label("D1", "1", "VIN_USB");
  label("D1", "2", "GND");
  part("D2", "Device:D", "SMAJ28A TVS", 60, 90, FP.sma);
  label("D2", "1", "VIN_DC");
  label("D2", "2", "GND");
  // USB input current: 20 mR shunt, INA180A1 (x20) -> 2 V at 5 A on USB_ISENSE.
  // What the box draws from a shared GaN charger, so firmware can keep it
  // inside the port's allocation.
  r("R93", "20m 1W", 80, 52, "VIN_USB", "VIN_USBS", FP.r2512);
  part("U41", INA180.libId, "INA180A1", 80, 66);
  label("U41", "1", "USB_ISENSE");
  label("U41", "2", "GND");
  label("U41", "3", "VIN_USB");
  label("U41", "4", "VIN_USBS");
  label("U41", "5", "+3V3");
  c("C115", "100n", 96, 66, "+3V3", "GND");
  // Which input is live: a divider on the DC jack side, same ratio as VIN_SENSE.
  r("R94", "100k", 80, 110, "VIN_DC", "DCIN_SENSE");
  r("R95", "14.0k", 80, 122, "DCIN_SENSE", "GND");
  idealDiode(1, "VIN_USBS", "VIN", 100, 40);
  idealDiode(2, "VIN_DC", "VIN", 100, 90);
  c("C90", "22u/50V", 180, 60, "VIN", "GND", FP.c1210);
  c("C91", "22u/50V", 188, 60, "VIN", "GND", FP.c1210);
  // Vin sense: 100k / 14.0k puts 13.4 V at 1.65 V, the comparator's reference.
  // Low enough that the Toughbook's 15.6 V brick and the PD 15 V profile both
  // count as a live input; the 12 V buck is fine down to ~13 V.
  r("R90", "100k", 210, 50, "VIN", "VIN_SENSE");
  r("R91", "14.0k", 210, 62, "VIN_SENSE", "GND");

  // #region rails
  buck(3, 12, "9.09k", "25V", "VIN", "+12V_BUCK", 80, 170);
  idealDiode(6, "+12V_BUCK", "+12V", 230, 170); // blocks the pack from pushing into a dead buck
  buck(4, 15.6, "6.81k", "25V", "VIN", "+15V6_BUCK", 80, 260, "LAPTOP_EN");
  // Laptop rail under firmware control, off at reset. On a shared USB-C port
  // the laptop's charge demand can exceed the allocation; firmware decides.
  r("R92", "100k", 80, 300, "LAPTOP_EN", "GND");
  // Constant-current limit on the laptop rail. R96 + U42 read the rail current
  // (1 V/A). U43 integrates (sense - setpoint): above the setpoint its output
  // rises and, through D40/R98, lifts the buck's FB node so the rail folds
  // back. The setpoint LAPTOP_ILIM is a filtered PWM from the MCU, 1 V per amp,
  // so firmware sets the laptop's share of a shared charger and the charger
  // never sees an overload. Below the limit D40 is off and the buck is a
  // normal 15.6 V source.
  r("R96", "20m 1W", 170, 246, "+15V6_BUCK", "+15V6_S", FP.r2512);
  part("U42", INA180A2.libId, "INA180A2", 170, 262);
  label("U42", "1", "LAPTOP_ISENSE");
  label("U42", "2", "GND");
  label("U42", "3", "+15V6_BUCK");
  label("U42", "4", "+15V6_S");
  label("U42", "5", "+3V3");
  c("C116", "100n", 186, 262, "+3V3", "GND");
  part("U43", LMV321.libId, "LMV321", 170, 290);
  label("U43", "1", "LAPTOP_ISENSE");
  label("U43", "2", "GND");
  label("U43", "3", "LAPTOP_ILIM_N");
  label("U43", "4", "LAPTOP_CC");
  label("U43", "5", "+3V3");
  r("R97", "100k", 150, 290, "LAPTOP_ILIM", "LAPTOP_ILIM_N");
  c("C117", "10n", 186, 300, "LAPTOP_CC", "LAPTOP_ILIM_N");
  part("D40", "Device:D", "1N4148W", 200, 290, "Diode_SMD:D_SOD-123");
  label("D40", "2", "LAPTOP_CC");
  label("D40", "1", "LAPTOP_CC_D");
  r("R98", "4.7k", 210, 290, "LAPTOP_CC_D", "U4_FB");
  r("R99", "10k", 130, 290, "LAPTOP_ILIM_PWM", "LAPTOP_ILIM");
  c("C118", "1u", 130, 304, "LAPTOP_ILIM", "GND");
  idealDiode(7, "+15V6_S", "LAPTOP_OUT", 230, 260); // a brick in the wrong jack cannot feed the board
  part("J3", BARREL.libId, "Laptop out 15.6V, PJ-002BH 5.5x2.5 (v1 jack)", 300, 260);
  label("J3", "1", "LAPTOP_OUT");
  label("J3", "2", "GND");
  nc("J3", "3");
  buck(5, 5, "24.9k", "25V", "VIN", "+5V", 80, 350);
  ops.push({ op: "instantiate_module", moduleId: "ldo_3v3", params: { vin_net: "+5V" }, at: { x: 230, y: 350 } });
  // Bulk on the backed-up rail: covers the microseconds between the input
  // dropping and the battery FET closing.
  part("C98", "Device:C_Polarized", "470u/25V", 330, 180, FP.cElec10);
  label("C98", "1", "+12V");
  label("C98", "2", "GND");
  part("C97", "Device:C_Polarized", "470u/25V", 342, 180, FP.cElec10);
  label("C97", "1", "+12V");
  label("C97", "2", "GND");

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
  part("Q8", PMOS_40V.libId, "AOD4185", bx + 150, by - 10);
  label("Q8", "3", "PACK_F");
  label("Q8", "2", "+12V");
  label("Q8", "1", "BK_GATE");
  r("R80", "100k", bx + 150, by + 14, "PACK_F", "BK_GATE");
  part("Q9", "Device:Q_NMOS_GSD", "2N7002", bx + 180, by + 14, FP.sot23);
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
  // Two 24R 2512 in parallel: 12R, 2 W continuous, and the test is 2.4 J pulses.
  r("R85", "24R 1W", bx + 300, by - 10, "PACK_F", "TEST_NODE", FP.r2512);
  r("R88", "24R 1W", bx + 310, by - 10, "PACK_F", "TEST_NODE", FP.r2512);
  part("Q11", NMOS_60V.libId, "SI4470EY", bx + 300, by + 14);
  for (const n of ["5", "6", "7", "8"]) label("Q11", n, "TEST_NODE");
  for (const n of ["1", "2", "3"]) label("Q11", n, "GND");
  label("Q11", "4", "TEST_LOAD");
  r("R86", "100k", bx + 330, by - 10, "PACK_F", "PACK_SENSE");
  r("R87", "11.5k", bx + 330, by + 2, "PACK_SENSE", "GND");

  // Firmware can drop the battery too (2 s of no load, or the 5 min cap):
  // Q10 pulls the Q9 gate low regardless of what the comparator says.
  part("Q10", "Device:Q_NMOS_GSD", "2N7002", bx + 210, by + 34, FP.sot23);
  label("Q10", "3", "BK_DRV");
  label("Q10", "2", "GND");
  label("Q10", "1", "BK_KILL");
  r("R89", "100k", bx + 210, by + 54, "BK_KILL", "GND");

  // #region stage 2: radio port
  // Both PoE flavours share the port pins: + on 4/5, - on 7/8 (802.3 Mode B,
  // same polarity v1 used). Active: the 54 V rail sits on PORT_P and the PSE
  // switches PORT_N to ground. Passive: the eFuse puts 12 V on PORT_P and Q13
  // ties PORT_N to ground. Never both: firmware holds BOOST_SD high whenever
  // PASSIVE_EN is high. The eFuse's back-to-back FETs block 54 V from reaching
  // the 12 V rail, and the boost diode blocks 12 V from reaching the boost.
  const px = 560, py = 40;

  // 12 V -> 54 V boost, LM3478 at 400 kHz. Its output is PORT_P itself: the
  // port positive, the PSE's AGND supply and the eFuse output are one node.
  // With the boost off that node sits at ~11.5 V through D20, or at 12 V when
  // the eFuse is on; the PSE is in UVLO below 45 V and holds its switch off. Sized for the radio (10-15 W), not a
  // full 30 W class-4 load: at D = 0.78 the LM3478 has ~84 mV of sense headroom,
  // and 20 mR puts the peak switch limit near 4 A.
  part("U20", LM3478.libId, "LM3478 54V boost", px, py);
  part("Q20", NMOS_100V.libId, "AO4482", px + 50, py - 20);
  part("L20", "Device:L", "MDA1365-330M 33u 4.5A", px + 30, py - 40, "Inductor_SMD:L_12x12mm_H8mm");
  part("D20", "Device:D", "SS310 100V Schottky", px + 70, py - 40, FP.sma);
  r("R20", "20m 1W", px + 50, py + 6, "BOOST_CS", "GND", FP.r2512);
  r("R21", "40.2k", px - 30, py + 14, "BOOST_FA", "GND");
  r("R22", "402k", px + 100, py - 10, "PORT_P", "BOOST_FB");
  r("R23", "9.53k", px + 100, py + 2, "BOOST_FB", "GND");
  c("C20", "100p", px + 110, py + 2, "BOOST_FB", "GND");
  r("R24", "10k", px - 30, py - 10, "BOOST_COMP", "BOOST_COMPC");
  c("C21", "47n", px - 30, py + 2, "BOOST_COMPC", "GND");
  c("C22", "10u/25V", px - 30, py - 30, "+12V", "GND", FP.c1210);
  c("C23", "4.7u/100V", px + 100, py - 30, "PORT_P", "GND", FP.c1210);
  c("C24", "4.7u/100V", px + 108, py - 30, "PORT_P", "GND", FP.c1210);
  part("C25", "Device:C_Polarized", "47u/63V", px + 120, py - 30, FP.cElec8);
  label("C25", "1", "PORT_P");
  label("C25", "2", "GND");
  // Shutdown from the MCU through a diode so R21 alone still sets the frequency.
  r("R25", "1k", px - 50, py + 26, "BOOST_SD", "BOOST_SDD");
  part("D21", "Device:D", "1N4148W", px - 40, py + 26, "Diode_SMD:D_SOD-123");
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
  label("Q20", "4", "BOOST_DR");
  for (const n of ["1", "2", "3"]) label("Q20", n, "BOOST_CS");
  for (const n of ["5", "6", "7", "8", "9"]) label("Q20", n, "BOOST_SW");
  label("L20", "1", "+12V");
  label("L20", "2", "BOOST_SW");
  label("D20", "2", "BOOST_SW");
  label("D20", "1", "PORT_P");

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
  part("Q13", NMOS_60V.libId, "SI4470EY", ex + 100, ey + 10);
  label("Q13", "4", "PASSIVE_EN");
  for (const n of ["1", "2", "3"]) label("Q13", n, "GND");
  for (const n of ["5", "6", "7", "8"]) label("Q13", n, "PORT_N");

  // 802.3at PSE: LTC4279 wired per its datasheet Figure 13. Port positive is
  // PORT_P (the chip's AGND supply, through the 10 R surge resistor), board
  // ground is the chip's VEE, and Q22 switches the port negative. PWRMODE 3.32k
  // = Type 2 (25.5 W). MID / LEGACY / DUALPD low: endpoint, IEEE PDs only, no
  // dual-signature. RESET is pulled down so the port stays off until the MCU
  // raises PSE_EN; LED is open-drain low while the port is powered (PSE_ON).
  const qx = px + 250, qy = py + 10;
  part("U22", LTC4279.libId, "LTC4279", qx, qy);
  label("U22", "1", "PSE_MID");
  nc("U22", "2");
  nc("U22", "3");
  label("U22", "4", "GND"); // Kelvin: route to the R72 ground pad, not the plane
  label("U22", "5", "PSE_SENSE");
  label("U22", "6", "PSE_GATE_DRV");
  label("U22", "7", "PORT_N");
  label("U22", "8", "PSE_AGND");
  label("U22", "9", "PSE_ON");
  label("U22", "10", "GND");
  nc("U22", "11");
  label("U22", "12", "PSE_PWRMODE");
  label("U22", "13", "PSE_LEGACY");
  label("U22", "14", "PSE_DUALPD");
  nc("U22", "15");
  label("U22", "16", "PSE_RESET");
  r("R70", "10R", qx - 40, qy - 30, "PORT_P", "PSE_AGND");
  c("C70", "1u/100V", qx - 40, qy - 18, "PSE_AGND", "GND", FP.c1210);
  part("D70", "Device:D", "SMAJ58A TVS", qx - 40, qy - 6, FP.sma);
  label("D70", "1", "PSE_AGND");
  label("D70", "2", "GND");
  part("D71", "Device:D", "S1B clamp", qx - 40, qy + 6, FP.sma);
  label("D71", "2", "PORT_N");
  label("D71", "1", "PSE_AGND");
  c("C71", "220n/100V", qx - 40, qy + 18, "PORT_N", "PSE_AGND", FP.c1210);
  r("R71", "200R", qx - 40, qy + 30, "PSE_GATE_DRV", "PSE_GATE");
  part("Q22", PSMN075.libId, "PSMN075-100MSEX", qx - 40, qy + 50);
  label("Q22", "1", "PSE_SENSE");
  label("Q22", "2", "PSE_SENSE");
  label("Q22", "3", "PSE_SENSE");
  label("Q22", "4", "PSE_GATE");
  label("Q22", "5", "PORT_N");
  r("R72", "0.1R 1% 2W", qx, qy + 50, "PSE_SENSE", "GND", FP.r2512);
  r("R73", "3.32k 1%", qx + 40, qy - 30, "PSE_PWRMODE", "GND");
  r("R74", "100R", qx + 40, qy - 18, "PSE_MID", "GND");
  r("R75", "100R", qx + 40, qy - 6, "PSE_LEGACY", "GND");
  r("R76", "100R", qx + 40, qy + 6, "PSE_DUALPD", "GND");
  r("R77", "100R", qx + 40, qy + 18, "PSE_EN", "PSE_RESET");
  r("R78", "10k", qx + 40, qy + 30, "PSE_RESET", "GND");
  r("R79", "10k", qx + 40, qy + 42, "+3V3", "PSE_ON");

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

  // #region stage 3: MCU, LEDs, fan, temperature, USB serial
  // STM32F072C8T6 with its USB on an outside-facing USB-C. The port is
  // self-powered: USB VBUS goes nowhere but the ESD array, so a laptop can
  // never back-drive the 5 V rail and the board must have its brick or its
  // battery to talk. Outputs that matter at reset have a pull so a floating
  // GPIO means "off": BOOST_SD up (boost off), TEST_LOAD / FAN / BK_KILL down.
  const mx = 560, my = 330;
  part("U40", STM32F072.libId, "STM32F072CBT6", mx, my);
  const mcuPins: Record<string, string> = {
    "1": "+3V3", "8": "GND", "9": "MCU_VDDA", "23": "GND", "35": "GND", "47": "GND", "24": "+3V3", "36": "+3V3", "48": "+3V3",
    "7": "MCU_NRST", "44": "MCU_BOOT0",
    "10": "VIN_SENSE", "11": "PACK_SENSE", "12": "PASSIVE_IMON", "13": "TEMP_SENSE", "14": "FAN_SENSE", // ADC0-4
    "15": "USB_ISENSE", "17": "DCIN_SENSE", "19": "LAPTOP_ISENSE", // ADC5, ADC7, ADC9
    "20": "LAPTOP_EN", // PB2
    "30": "LAPTOP_ILIM_PWM", // PA9 TIM1_CH2, filtered to the CC setpoint (1 V per amp)
    "25": "TEST_LOAD", "26": "BOOST_SD", "27": "PASSIVE_EN", "28": "PSE_EN", // PB12-15
    "16": "FAN_PWM", // PA6 TIM3_CH1
    "29": "LED_DATA", // PA8 TIM1_CH1 (PWM+DMA for the WS2812 stream)
    "21": "PD_SCL", "22": "PD_SDA", // PB10/PB11 I2C2 to the CH224A
    "31": "BK_KILL", // PA10
    "39": "BK_ON", "40": "PASSIVE_FLT", "41": "PSE_ON", // PB3-5 inputs
    "32": "USB_D-", "33": "USB_D+", "34": "SWDIO", "37": "SWCLK",
    "42": "UART_TX", "43": "UART_RX", // PB6/PB7 USART1
    "45": "PD_PG", // PB8, low = the charger granted 20 V
  };
  for (const [pin, net] of Object.entries(mcuPins)) label("U40", pin, net);
  // Power pins per the datasheet power supply scheme: 100n at each VDD plus
  // 4.7u bulk, VDDA through a 10R/1u+10n filter, VBAT tied to 3V3 (no RTC).
  c("C130", "4.7u", mx - 60, my - 40, "+3V3", "GND");
  c("C131", "100n", mx - 52, my - 40, "+3V3", "GND");
  c("C132", "100n", mx - 44, my - 40, "+3V3", "GND");
  c("C133", "100n", mx - 36, my - 40, "+3V3", "GND");
  r("R112", "10R", mx - 60, my - 24, "+3V3", "MCU_VDDA");
  c("C134", "1u", mx - 52, my - 24, "MCU_VDDA", "GND");
  c("C135", "10n", mx - 44, my - 24, "MCU_VDDA", "GND");
  // Reset and boot. NRST has an internal pull-up; the 100n is the datasheet's
  // noise filter. BOOT0 pulled down; holding SW2 at reset enters USB DFU.
  part("SW1", "Switch:SW_Push", "RESET", mx - 60, my);
  label("SW1", "1", "MCU_NRST");
  label("SW1", "2", "GND");
  c("C136", "100n", mx - 60, my + 14, "MCU_NRST", "GND");
  part("SW2", "Switch:SW_Push", "BOOT0 (DFU)", mx - 60, my + 30);
  label("SW2", "1", "MCU_BOOT0");
  label("SW2", "2", "+3V3");
  r("R111", "10k", mx - 60, my + 44, "MCU_BOOT0", "GND");
  part("J9", SWD_HDR.libId, "SWD", mx - 60, my + 64);
  label("J9", "1", "SWDIO");
  label("J9", "2", "SWCLK");
  label("J9", "3", "+3V3");
  label("J9", "4", "GND");
  // Direct serial to the MCU, USART1 on PB6/PB7, for a bench console that
  // does not depend on the USB stack being alive.
  part("J11", SWD_HDR.libId, "UART", mx - 60, my + 80);
  label("J11", "1", "UART_TX");
  label("J11", "2", "UART_RX");
  label("J11", "3", "+3V3");
  label("J11", "4", "GND");
  ops.push({ op: "instantiate_module", moduleId: "usb_c_program", params: { vbus_net: "USB_VBUS" }, at: { x: mx + 200, y: my - 60 } });
  r("R26", "100k", mx - 100, my - 40, "+3V3", "BOOST_SD");
  r("R100", "100k", mx - 100, my - 28, "TEST_LOAD", "GND");

  // Two WS2812B behind one AHCT buffer: D30 sits by the power inputs, D31 by
  // the radio jack. Data: LED_DATA -> U30 -> 100R -> D30 -> D31.
  const lx = mx + 200, ly = my + 40;
  part("U30", AHCT1G125.libId, "SN74AHCT1G125", lx, ly);
  label("U30", "1", "GND");
  label("U30", "2", "LED_DATA");
  label("U30", "3", "GND");
  label("U30", "4", "LED_D0");
  label("U30", "5", "+5V");
  c("C110", "100n", lx, ly + 16, "+5V", "GND");
  r("R103", "100R", lx + 30, ly, "LED_D0", "LED_D0R");
  part("D30", WS2812B_4020.libId, "WS2812B-4020 power LED", lx + 60, ly);
  label("D30", "2", "+5V");
  label("D30", "4", "GND");
  label("D30", "1", "LED_D0R");
  label("D30", "3", "LED_D1");
  c("C111", "100n", lx + 60, ly + 16, "+5V", "GND");
  part("D31", WS2812B_4020.libId, "WS2812B-4020 radio LED", lx + 100, ly);
  label("D31", "2", "+5V");
  label("D31", "4", "GND");
  label("D31", "1", "LED_D1");
  label("D31", "3", "LED_D2");
  // Lid LEDs on a wire: the chain continues out of the box.
  part("J13", XH3.libId, "Lid LEDs", lx + 130, ly);
  label("J13", "1", "+5V");
  label("J13", "2", "LED_D2");
  label("J13", "3", "GND");
  c("C112", "100n", lx + 100, ly + 16, "+5V", "GND");

  // Fan: 2-pin 30 mm on the 12 V rail, low-side AO3400A at 25 kHz PWM, SS14
  // flyback. R104 is a 1R shunt in the source: the ADC sees the commutation
  // ripple of a spinning fan and flat DC from a stalled one.
  const fx = mx + 200, fy = my + 90;
  part("J8", "Connector:Conn_01x02", "Fan 12V", fx, fy, FP.xh2);
  label("J8", "1", "+12V");
  label("J8", "2", "FAN_N");
  part("D32", "Device:D", "SS14 flyback", fx + 24, fy, FP.sma);
  label("D32", "1", "+12V");
  label("D32", "2", "FAN_N");
  part("Q30", "Device:Q_NMOS_GSD", "AO3400A", fx + 50, fy + 10, FP.sot23);
  label("Q30", "3", "FAN_N");
  label("Q30", "2", "FAN_SHUNT");
  label("Q30", "1", "FAN_G");
  r("R104", "1R", fx + 50, fy + 30, "FAN_SHUNT", "GND");
  r("R105", "10k", fx + 80, fy + 10, "FAN_SHUNT", "FAN_SENSE");
  c("C113", "10n", fx + 80, fy + 26, "FAN_SENSE", "GND");
  r("R106", "100R", fx + 24, fy + 20, "FAN_PWM", "FAN_G");
  r("R101", "100k", fx + 24, fy + 34, "FAN_G", "GND");

  // Temperature: 10k / NTC divider, the NTC placed between the bucks and boost.
  part("RT1", NTC.libId, "10k NTC", fx + 120, fy);
  label("RT1", "1", "TEMP_SENSE");
  label("RT1", "2", "GND");
  r("R107", "10k", fx + 120, fy - 14, "+3V3", "TEMP_SENSE");
  c("C114", "100n", fx + 140, fy, "TEMP_SENSE", "GND");

  // #region notes
  const notes: [string, number][] = [
    ["STAGES 1-3 DONE: power tree, radio port, MCU. Stage 4 = the board. Port placement for the board: TOP edge = laptop side (J6 RJ45 laptop, J3 laptop DC out, the USB-C serial). RIGHT edge = power in (J1 PD trigger module, J2 DC jack). BOTTOM edge = radio (J5 RJ45 radio). D30 sits by the power inputs, D31 by the radio jack. Cells on the bottom side.", 560],
    ["RADIO PORT: PORT_P = pins 4/5, PORT_N = pins 7/8 (Mode B). Active: +54V on PORT_P, the PSE switches PORT_N to ground. Passive: U21 eFuse puts 12 V on PORT_P, Q13 grounds PORT_N. Firmware never enables both: BOOST_SD high whenever PASSIVE_EN is high. Sequence: PSE detect first; valid signature = active; open/invalid = passive.", 650],
    ["PSE: LTC4279 (SO-16) per datasheet Figure 13. PORT_P is its AGND supply through R70 10R; board GND is its VEE; Q22 (PSMN075-100MSEX, ADI's recommended FET) switches PORT_N through R72 0.1R. PWRMODE 3.32k = Type 2, 25.5 W. RESET pulled down: port off until the MCU raises PSE_EN. PSE_ON is low while powered. VSSK and R72's ground end must be one Kelvin trace.", 665],
    ["INPUTS: 14-26 V from a USB-C PD trigger module (J1) or a DC jack (J2), ideal-diode ORed. Highest wins. The USB-C PD sink (CH224A) is on the board now, no trigger module. Standard supply is a 24 V 5 A brick; the Toughbook's own 15.6 V brick or a 19-20 V laptop brick also work. J2 and J3 are both 5.5x2.5 so the laptop brick can power the box; a brick in J3 is blocked by U7, a laptop on J2 just sees VIN. VIN_SENSE: 20 V = 2.46 V, 15.6 V = 1.92 V, 13.4 V = 1.65 V (battery takes over), 9 V = 1.11 V, 5 V = 0.61 V.", 575],
    ["RAILS: +12V is the backed-up rail (radio passive output, 54 V PSE boost, 5 V, 3.3 V). LAPTOP_OUT is off the raw input so it sheds itself on a dropout. Bucks are LMR33630 at 400 kHz per datasheet Table 9-1; the laptop one is set to 15.6 V (the Toughbook brick voltage) and runs in dropout on that brick, passing ~15.3 V.", 590],
    ["BACKUP: 4x CR123A (12 V nominal, no boost, no BMS). Q8 closes when Vin < 16 V, opens when it returns. R84 hysteresis. Firmware (stage 3) opens it after 2 s of no radio load or 5 min, by pulling BK_ON low through a diode-OR at R81 (TBD stage 3). Self-test: TEST_LOAD high for 200 ms, read PACK_SENSE; below ~10 V loaded = replace all four cells.", 605],
    ["ASSEMBLY: all SMT except connectors and cell holders, so the BOM is production-ready as is. First units hand-built: every IC is SO / SOT-23 / HTSSOP, passives 0805+, exposed pads (3 bucks, eFuse, FETs) get thermal vias for hot air. No leadless packages.", 620],
    ["OPEN: Passive-mode radio draw (assumed 10 W) and the PD brick's dropout time still need measuring. Laptop rail is off at reset (LAPTOP_EN) and constant-current limited (LAPTOP_ILIM): firmware sets the limit to allocation minus the box draw so a shared charger never trips; what the Toughbook does when limited is untested (bench supply 15.6 V / 2.5 A). USB serial is self-powered: no brick or battery, no console.", 635],
    ["MCU: STM32F072CBT6 (128 KB), no radio. ADC: PA0 VIN_SENSE, PA1 PACK_SENSE, PA2 PASSIVE_IMON, PA3 TEMP_SENSE, PA4 FAN_SENSE. ADC5 USB_ISENSE (2 V = 5 A), ADC7 DCIN_SENSE, ADC9 LAPTOP_ISENSE (1 V = 1 A). Out: PB2 LAPTOP_EN (off at reset), PA9 LAPTOP_ILIM_PWM (CC setpoint, 1 V = 1 A), PB12 TEST_LOAD, PB13 BOOST_SD (pulled up = off), PB14 PASSIVE_EN, PB15 PSE_EN, PA6 FAN_PWM (TIM3_CH1), PA8 LED_DATA (TIM1_CH1 + DMA), PA10 BK_KILL. I2C2 PB10/PB11 reads the CH224A (status, PDO list). In: PB3 BK_ON, PB4 PASSIVE_FLT, PB5 PSE_ON. USB PA11/PA12, DFU via BOOT0 button, USART1 PB6/PB7 on J11. Firmware rule: PASSIVE_EN and PSE_EN never both high; BOOST_SD low only while PSE_EN is high.", 680],
  ];
  for (const [text, y] of notes) ops.push({ op: "add_text", text, at: { x: 30, y }, size: 2 });

  const { results } = applyOps(schem, ops, resolve);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.log("failed ops:", [...new Set(failed.map((f) => f.error))].join("; "));

  for (const [ref, fp] of footprints) {
    const inst = schem.symbols.find((x) => x.properties.Reference === ref);
    if (inst) inst.properties.Footprint = fp;
  }
  // LCSC part numbers (checked against JLCPCB's library 2026-09-23) so the
  // hand-built prototype and a JLC-assembled run share one BOM.
  const lcsc: Record<string, string> = {
    U1: "C2941042", U2: "C2941042", U6: "C2941042", U7: "C2941042", // LM74700QDBVRQ1
    Q1: "C7568913", Q2: "C7568913", Q6: "C7568913", Q7: "C7568913", Q11: "C7568913", Q13: "C7568913", // SI4470EY
    U3: "C841384", U4: "C841384", U5: "C841384", // LMR33630ADDAR
    L3: "C2687402", L4: "C2687402", L5: "C2687402", // SRP7028A-100M
    U10: "C702117", // TLV7011DBVR
    U20: "C115907", // LM3478MAX/NOPB
    U21: "C544399", // TPS26600PWPR
    Q8: "C400894", // AOD4185
    Q9: "C8545", // 2N7002 (basic)
    Q20: "C192576", // AO4482
    L20: "C2847586", // MDA1365-330M
    D1: "C148227", D2: "C148227", // SMAJ28A
    D20: "C15874", // SS310
    D21: "C2099", // 1N4148W
    D22: "C10762", // SMAJ58A
    F1: "C2838912", // 1206TD-2A
    C97: "C346948", C98: "C346948", // 470u/25V D10x10
    C25: "C970680", // 47u/63V D8x10
    C30: "C53084452", C40: "C53084452", C50: "C53084452", // 10u/50V 1210
    C34: "C53084530", C35: "C53084530", C36: "C53084530", C37: "C53084530", // 22u/25V 1210
    C54: "C53084530", C55: "C53084530", C56: "C53084530", C57: "C53084530",
    C44: "C53084530", C45: "C53084530", C46: "C53084530", C47: "C53084530", // 22u/25V 1210
    C22: "C53084452", // 10u/25V -> same 50V part
    C23: "C337978", C24: "C337978", // 4.7u/100V 1210
    J1: "C165948", // TYPE-C-31-M-12 receptacle, 20 V 5 A
    U50: "C42459160", // CH224A
    J2: "C22359705", J3: "C22359705", // PJ-002BH 5.5x2.5, same jack both ends so the laptop brick can feed the box
    J5: "C385834", J6: "C385834", // R-RJ45R08P-A004
    U22: "C687935", // LTC4279IS#PBF (10 in stock at JLC, buy the rest at DigiKey)
    Q22: "C478016", // PSMN075-100MSEX
    R72: "C844904", // WSL2512R1000FEA
    D70: "C10762", D71: "C96324", // SMAJ58A, S1B
    Q10: "C8545", // 2N7002
    U30: "C7484", // SN74AHCT1G125DBVR
    D30: "C965557", D31: "C965557", // WS2812B-4020 side view
    D32: "C2480", // SS14 (basic)
    Q30: "C20917", // AO3400A (basic)
    J8: "C20079", // XH-2A
    RT1: "C13564", // NCP18XH103F03RB
    J13: "C2316", // XH-3A
    U40: "C2969805", // STM32F072CBT6 (genuine: JLC stock 0, consign from DigiKey; APM32/FCM32 clones in stock are not it)
    U41: "C122228", // INA180A1IDBVR
    U42: "C192764", // INA180A2IDBVR
    U43: "C395459", // LMV321
    D40: "C2099", // 1N4148W
    BT1: "C5290177", BT2: "C5290177", BT3: "C5290177", BT4: "C5290177", // BH-123A-A1CJ002
  };
  for (const [ref, code] of Object.entries(lcsc)) {
    const inst = schem.symbols.find((x) => x.properties.Reference === ref);
    if (inst) inst.properties.LCSC = code;
    else console.log(`no part for LCSC ${ref}`);
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

  // LCSC numbers for module-placed parts, found by symbol rather than ref.
  const byLib: Record<string, string> = {
    "Connector:USB_C_Receptacle_USB2.0": "C5143397",
    "Power_Protection:USBLC6-2SC6": "C7519",
    "Regulator_Linear:AP2112K-3.3": "C51118",
  };
  for (const inst of schem.symbols) {
    const code = byLib[inst.libId];
    if (code && !inst.properties.LCSC) inst.properties.LCSC = code;
  }

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
  const schem = buildRadioKiosk();
  const defs = (libId: string) => library.get(libId)?.def ?? schem.libSymbols[libId];
  const nl = buildNetlist(schem, defs);
  // two rails on one net means two pin ends met on the sheet (it happened
  // with +3V3 and GND): refuse to write that
  const RAIL = /^(GND|\+\d|VIN|VBUS|PACK_P|PORT_P|LAPTOP_OUT)/;
  const merged = nl.nets.filter((n) => n.labels.filter((l) => RAIL.test(l)).length > 1);
  if (merged.length) { console.log("RAILS MERGED: " + merged.map((n) => n.labels.join("=")).join(", ")); process.exit(1); }
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
