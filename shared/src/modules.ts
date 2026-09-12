// #region Modules (parametric sub-circuits)
// A circuit is built from modules that interface with each other. A module is
// a parametric recipe: given parameters (and, later, a required spec like
// "3.3V at 1A"), it produces a small block of parts + internal wiring + the
// nets it exposes. The AI composes designs by instantiating modules instead of
// placing every part by hand.
//
// This is the seam where richer behaviour plugs in over time: part selection
// from supplier data, datasheet-driven pin maps, and big blocks like an
// on-board ATmega328P "Arduino core" or a buck converter around a chosen
// controller. The three recipes here are real and use the builtin library;
// the framework is what the bigger blocks slot into.

export interface ModuleParam {
  name: string;
  type: "number" | "string" | "enum";
  default: string | number;
  options?: string[];
  unit?: string;
  doc: string;
}

// A part inside a module, positioned relative to the module origin (dx, dy mm).
export interface ModulePart {
  local: string; // stable id within the module, used by wires/nets
  libId: string;
  value?: string;
  dx: number;
  dy: number;
  rotation?: number;
}

export interface ModuleWire {
  a: { local: string; pin: string };
  b: { local: string; pin: string };
}

// A named net exposed at a pin (rendered as a label so it joins by name).
export interface ModuleNet {
  local: string;
  pin: string;
  label: string;
}

export interface ModuleResult {
  parts: ModulePart[];
  wires: ModuleWire[];
  nets: ModuleNet[];
}

export interface ModuleDef {
  id: string;
  name: string;
  description: string;
  params: ModuleParam[];
  build: (params: Record<string, string | number>) => ModuleResult;
}

// #region helpers
// Standard E12 resistor values (one decade), for snapping computed values.
const E12 = [10, 12, 15, 18, 22, 27, 33, 39, 47, 56, 68, 82];
function nearestE12(value: number): string {
  if (value <= 0) return "0";
  const decade = Math.floor(Math.log10(value));
  const base = value / Math.pow(10, decade);
  let best = E12[0];
  for (const e of E12) if (Math.abs(e / 10 - base) < Math.abs(best / 10 - base)) best = e;
  const r = (best / 10) * Math.pow(10, decade);
  return r >= 1000 ? `${r / 1000}k` : `${r}`;
}


// Standard E96 1% values (one decade), for feedback dividers where E12 is too
// coarse to hit a regulated rail accurately.
const E96 = [
  100, 102, 105, 107, 110, 113, 115, 118, 121, 124, 127, 130, 133, 137, 140, 143, 147, 150, 154, 158,
  162, 165, 169, 174, 178, 182, 187, 191, 196, 200, 205, 210, 215, 221, 226, 232, 237, 243, 249, 255,
  261, 267, 274, 280, 287, 294, 301, 309, 316, 324, 332, 340, 348, 357, 365, 374, 383, 392, 402, 412,
  422, 432, 442, 453, 464, 475, 487, 499, 511, 523, 536, 549, 562, 576, 590, 604, 619, 634, 649, 665,
  681, 698, 715, 732, 750, 768, 787, 806, 825, 845, 866, 887, 909, 931, 953, 976,
];
function nearestE96(value: number): string {
  if (value <= 0) return "0";
  const decade = Math.floor(Math.log10(value)) - 2;
  const base = value / Math.pow(10, decade);
  let best = E96[0];
  for (const e of E96) if (Math.abs(e - base) < Math.abs(best - base)) best = e;
  const r = best * Math.pow(10, decade);
  if (r >= 1e6) return `${+(r / 1e6).toPrecision(3)}M`;
  if (r >= 1000) return `${+(r / 1000).toPrecision(3)}k`;
  return `${+r.toPrecision(3)}`;
}

const LED_VF: Record<string, number> = { red: 1.8, yellow: 2.0, green: 2.1, blue: 3.0, white: 3.1 };
const SUPPLY_V: Record<string, number> = { "+5V": 5, "+3V3": 3.3 };
const SUPPLY_SYM: Record<string, string> = { "+5V": "power:+5V", "+3V3": "power:+3V3" };

function p(params: Record<string, string | number>, name: string, fallback: string | number) {
  return params[name] ?? fallback;
}

// #region recipes
const modules: ModuleDef[] = [
  {
    id: "led_indicator",
    name: "LED indicator",
    description: "An LED with a current-limiting resistor from a supply rail to ground. Resistor value is computed from supply voltage, LED colour, and target current.",
    params: [
      { name: "supply", type: "enum", default: "+5V", options: ["+5V", "+3V3"], doc: "Supply rail" },
      { name: "color", type: "enum", default: "red", options: ["red", "yellow", "green", "blue", "white"], doc: "LED colour (sets forward voltage)" },
      { name: "current_ma", type: "number", default: 10, unit: "mA", doc: "Target LED current" },
    ],
    build(params) {
      const supply = String(p(params, "supply", "+5V"));
      const color = String(p(params, "color", "red"));
      const iMa = Number(p(params, "current_ma", 10));
      const vs = SUPPLY_V[supply] ?? 5;
      const vf = LED_VF[color] ?? 1.8;
      const r = Math.max(0, (vs - vf) / (iMa / 1000));
      return {
        parts: [
          { local: "SUP", libId: SUPPLY_SYM[supply] ?? "power:+5V", dx: 0, dy: -8 },
          { local: "R", libId: "Device:R", value: nearestE12(r), dx: 0, dy: 4 },
          { local: "D", libId: "Device:LED", value: `${color} LED`, dx: 0, dy: 16 },
          { local: "GND", libId: "power:GND", dx: 0, dy: 26 },
        ],
        wires: [
          { a: { local: "SUP", pin: "1" }, b: { local: "R", pin: "1" } },
          { a: { local: "R", pin: "2" }, b: { local: "D", pin: "2" } }, // anode
          { a: { local: "D", pin: "1" }, b: { local: "GND", pin: "1" } }, // cathode
        ],
        nets: [],
      };
    },
  },
  {
    id: "decoupling",
    name: "Decoupling capacitors",
    description: "One or more decoupling capacitors between VCC and GND, labelled on both nets so they join a power rail by name.",
    params: [
      { name: "count", type: "number", default: 2, doc: "Number of capacitors" },
      { name: "value", type: "string", default: "100n", doc: "Capacitance (e.g. 100n, 1u)" },
      { name: "rail", type: "string", default: "VCC", doc: "Positive net label" },
    ],
    build(params) {
      const count = Math.max(1, Math.min(8, Number(p(params, "count", 2))));
      const value = String(p(params, "value", "100n"));
      const rail = String(p(params, "rail", "VCC"));
      const parts: ModulePart[] = [];
      const nets: ModuleNet[] = [];
      for (let i = 0; i < count; i++) {
        const local = `C${i}`;
        parts.push({ local, libId: "Device:C", value, dx: i * 10, dy: 0 });
        nets.push({ local, pin: "1", label: rail });
        nets.push({ local, pin: "2", label: "GND" });
      }
      return { parts, wires: [], nets };
    },
  },
  {
    id: "voltage_divider",
    name: "Voltage divider",
    description: "Two resistors dividing an input net to an output tap. Values computed from the requested ratio.",
    params: [
      { name: "vin_net", type: "string", default: "VIN", doc: "Input net label" },
      { name: "vout_net", type: "string", default: "VOUT", doc: "Output tap net label" },
      { name: "ratio", type: "number", default: 0.5, doc: "Vout/Vin (0-1)" },
      { name: "total_k", type: "number", default: 20, unit: "kohm", doc: "R1+R2 in kohm" },
    ],
    build(params) {
      const ratio = Math.min(0.99, Math.max(0.01, Number(p(params, "ratio", 0.5))));
      const totalK = Number(p(params, "total_k", 20));
      const r2 = totalK * ratio; // bottom resistor
      const r1 = totalK - r2; // top resistor
      const vin = String(p(params, "vin_net", "VIN"));
      const vout = String(p(params, "vout_net", "VOUT"));
      return {
        parts: [
          { local: "R1", libId: "Device:R", value: nearestE12(r1 * 1000), dx: 0, dy: 0 },
          { local: "R2", libId: "Device:R", value: nearestE12(r2 * 1000), dx: 0, dy: 12 },
          { local: "GND", libId: "power:GND", dx: 0, dy: 22 },
        ],
        wires: [
          { a: { local: "R1", pin: "2" }, b: { local: "R2", pin: "1" } },
          { a: { local: "R2", pin: "2" }, b: { local: "GND", pin: "1" } },
        ],
        nets: [
          { local: "R1", pin: "1", label: vin },
          { local: "R1", pin: "2", label: vout },
        ],
      };
    },
  },

  // #region ESP32-S3 core
  {
    id: "esp32s3_core",
    name: "ESP32-S3 on-board MCU",
    description:
      "A complete on-board ESP32-S3-WROOM-1: module, 3V3 bulk and decoupling, the EN reset RC the datasheet asks for, a RESET button and a BOOT button. This is the whole 'make an ESP32 work' block - the board is the dev board, there is nothing to plug in. Pair it with usb_c_program for programming over USB-C.",
    params: [
      { name: "reset_button", type: "enum", default: "yes", options: ["yes", "no"], doc: "Fit a RESET button on EN" },
      { name: "boot_button", type: "enum", default: "yes", options: ["yes", "no"], doc: "Fit a BOOT button on IO0 (needed to force download mode)" },
      { name: "usb", type: "enum", default: "yes", options: ["yes", "no"], doc: "Expose the native USB pins (IO19/IO20) as USB_D-/USB_D+ nets" },
    ],
    build(params) {
      const withReset = String(p(params, "reset_button", "yes")) !== "no";
      const withBoot = String(p(params, "boot_button", "yes")) !== "no";
      const withUsb = String(p(params, "usb", "yes")) !== "no";
      const parts: ModulePart[] = [
        { local: "U", libId: "RF_Module:ESP32-S3-WROOM-1", value: "ESP32-S3-WROOM-1-N8", dx: 0, dy: 0 },
        // 22uF bulk + 100nF at the module pin: the Wi-Fi TX current step is
        // what browns out an under-decoupled ESP32 mid-transmit.
        { local: "CB", libId: "Device:C", value: "22u", dx: -30, dy: -14 },
        { local: "CD", libId: "Device:C", value: "100n", dx: -22, dy: -14 },
        // EN delay: 10k pull-up + 1uF holds EN low until 3V3 is stable.
        { local: "REN", libId: "Device:R", value: "10k", dx: -40, dy: -24 },
        { local: "CEN", libId: "Device:C", value: "1u", dx: -40, dy: -10 },
      ];
      const nets: ModuleNet[] = [
        { local: "U", pin: "2", label: "+3V3" },
        { local: "U", pin: "1", label: "GND" },
        { local: "U", pin: "40", label: "GND" },
        { local: "U", pin: "41", label: "GND" },
        { local: "U", pin: "3", label: "EN" },
        { local: "CB", pin: "1", label: "+3V3" },
        { local: "CB", pin: "2", label: "GND" },
        { local: "CD", pin: "1", label: "+3V3" },
        { local: "CD", pin: "2", label: "GND" },
        { local: "REN", pin: "1", label: "+3V3" },
        { local: "REN", pin: "2", label: "EN" },
        { local: "CEN", pin: "1", label: "EN" },
        { local: "CEN", pin: "2", label: "GND" },
      ];
      if (withReset) {
        parts.push({ local: "SWR", libId: "Switch:SW_Push", value: "RESET", dx: -54, dy: -10 });
        nets.push({ local: "SWR", pin: "1", label: "EN" });
        nets.push({ local: "SWR", pin: "2", label: "GND" });
      }
      if (withBoot) {
        parts.push({ local: "SWB", libId: "Switch:SW_Push", value: "BOOT", dx: -54, dy: 6 });
        nets.push({ local: "SWB", pin: "1", label: "IO0_BOOT" });
        nets.push({ local: "SWB", pin: "2", label: "GND" });
        nets.push({ local: "U", pin: "27", label: "IO0_BOOT" });
      }
      if (withUsb) {
        nets.push({ local: "U", pin: "13", label: "USB_D-" });
        nets.push({ local: "U", pin: "14", label: "USB_D+" });
      }
      return { parts, wires: [], nets };
    },
  },

  // #region USB-C programming port
  {
    id: "usb_c_program",
    name: "USB-C programming port",
    description:
      "USB-C receptacle wired straight to the ESP32-S3's native USB pins, with the two 5.1k CC pulldowns and a USBLC6-2SC6 ESD array. The S3 enumerates on its own USB-Serial-JTAG peripheral, so there is no CH340 and no DTR/RTS auto-reset circuit to get wrong.",
    params: [
      { name: "vbus_net", type: "string", default: "VBUS", doc: "Net for USB 5V (leave unconnected to board 5V unless you want bus power)" },
    ],
    build(params) {
      const vbus = String(p(params, "vbus_net", "VBUS"));
      return {
        parts: [
          { local: "J", libId: "Connector:USB_C_Receptacle_USB2.0", value: "USB-C", dx: 0, dy: 0 },
          { local: "RC1", libId: "Device:R", value: "5.1k", dx: 26, dy: -12 },
          { local: "RC2", libId: "Device:R", value: "5.1k", dx: 34, dy: -12 },
          { local: "ESD", libId: "Power_Protection:USBLC6-2SC6", value: "USBLC6-2SC6", dx: 30, dy: 16 },
          { local: "CV", libId: "Device:C", value: "10u", dx: 44, dy: -12 },
        ],
        wires: [],
        nets: [
          { local: "J", pin: "A1", label: "GND" },
          { local: "J", pin: "B1", label: "GND" },
          { local: "J", pin: "S1", label: "GND" },
          { local: "J", pin: "A4", label: vbus },
          { local: "J", pin: "B4", label: vbus },
          { local: "J", pin: "A5", label: "CC1" },
          { local: "J", pin: "B5", label: "CC2" },
          { local: "J", pin: "A6", label: "USB_DP_CON" },
          { local: "J", pin: "B6", label: "USB_DP_CON" },
          { local: "J", pin: "A7", label: "USB_DM_CON" },
          { local: "J", pin: "B7", label: "USB_DM_CON" },
          { local: "RC1", pin: "1", label: "CC1" },
          { local: "RC1", pin: "2", label: "GND" },
          { local: "RC2", pin: "1", label: "CC2" },
          { local: "RC2", pin: "2", label: "GND" },
          { local: "CV", pin: "1", label: vbus },
          { local: "CV", pin: "2", label: "GND" },
          { local: "ESD", pin: "1", label: "USB_DM_CON" },
          { local: "ESD", pin: "3", label: "USB_DP_CON" },
          { local: "ESD", pin: "2", label: "GND" },
          { local: "ESD", pin: "5", label: vbus },
          { local: "ESD", pin: "6", label: "USB_D-" },
          { local: "ESD", pin: "4", label: "USB_D+" },
        ],
      };
    },
  },

  // #region 24V bus buck
  {
    id: "buck_24v",
    name: "Buck converter from the 24V bus",
    description:
      "TPS54360 step-down from a motor battery bus to a logic rail. 60V part on purpose: a 24V pack under regen braking overshoots well past 24V and kills 28V-rated regulators. Values follow the datasheet's 5V/3.5A example; the feedback divider is computed for the requested output.",
    params: [
      { name: "vout", type: "number", default: 5, unit: "V", doc: "Output voltage" },
      { name: "vin_net", type: "string", default: "+24V", doc: "Input net label (the fused, post-breaker bus)" },
      { name: "vout_net", type: "string", default: "+5V", doc: "Output net label" },
    ],
    build(params) {
      const vout = Math.max(0.8, Number(p(params, "vout", 5)));
      const vinNet = String(p(params, "vin_net", "+24V"));
      const voutNet = String(p(params, "vout_net", "+5V"));
      // RHS = RLS x (VOUT - 0.8) / 0.8, with RLS = 10.2k per the datasheet.
      const rls = 10200;
      const rhs = (rls * (vout - 0.8)) / 0.8;
      return {
        parts: [
          { local: "U", libId: "Regulator_Switching:TPS54360", value: "TPS54360", dx: 0, dy: 0 },
          { local: "CIN1", libId: "Device:C", value: "2.2u/100V", dx: -30, dy: -6 },
          { local: "CIN2", libId: "Device:C", value: "2.2u/100V", dx: -22, dy: -6 },
          { local: "CB", libId: "Device:C", value: "100n", dx: -8, dy: -26 },
          { local: "L", libId: "Device:L", value: "8.2u", dx: 34, dy: -8 },
          { local: "D", libId: "Device:D", value: "B560C", dx: 22, dy: 8 },
          { local: "CO1", libId: "Device:C", value: "47u", dx: 46, dy: 4 },
          { local: "CO2", libId: "Device:C", value: "47u", dx: 54, dy: 4 },
          { local: "RHS", libId: "Device:R", value: nearestE96(rhs), dx: 40, dy: 22 },
          { local: "RLS", libId: "Device:R", value: "10.2k", dx: 40, dy: 34 },
          { local: "RT", libId: "Device:R", value: "523k", dx: -22, dy: 14 },
          { local: "RCOMP", libId: "Device:R", value: "13k", dx: 12, dy: 30 },
          { local: "CCOMP", libId: "Device:C", value: "6800p", dx: 12, dy: 40 },
        ],
        wires: [
          { a: { local: "RHS", pin: "2" }, b: { local: "RLS", pin: "1" } },
          { a: { local: "RCOMP", pin: "2" }, b: { local: "CCOMP", pin: "1" } },
        ],
        nets: [
          { local: "U", pin: "2", label: vinNet },
          { local: "U", pin: "7", label: "GND" },
          { local: "U", pin: "9", label: "GND" },
          { local: "U", pin: "8", label: "SW" },
          { local: "U", pin: "1", label: "BOOT" },
          { local: "U", pin: "5", label: "FB" },
          { local: "U", pin: "6", label: "COMP" },
          { local: "U", pin: "4", label: "RT" },
          { local: "CIN1", pin: "1", label: vinNet },
          { local: "CIN1", pin: "2", label: "GND" },
          { local: "CIN2", pin: "1", label: vinNet },
          { local: "CIN2", pin: "2", label: "GND" },
          { local: "CB", pin: "1", label: "BOOT" },
          { local: "CB", pin: "2", label: "SW" },
          { local: "L", pin: "1", label: "SW" },
          { local: "L", pin: "2", label: voutNet },
          { local: "D", pin: "2", label: "SW" },
          { local: "D", pin: "1", label: "GND" },
          { local: "CO1", pin: "1", label: voutNet },
          { local: "CO1", pin: "2", label: "GND" },
          { local: "CO2", pin: "1", label: voutNet },
          { local: "CO2", pin: "2", label: "GND" },
          { local: "RHS", pin: "1", label: voutNet },
          { local: "RHS", pin: "2", label: "FB" },
          { local: "RLS", pin: "2", label: "GND" },
          { local: "RT", pin: "1", label: "RT" },
          { local: "RT", pin: "2", label: "GND" },
          { local: "RCOMP", pin: "1", label: "COMP" },
          { local: "CCOMP", pin: "2", label: "GND" },
        ],
      };
    },
  },

  // #region 3V3 LDO
  {
    id: "ldo_3v3",
    name: "3.3V LDO from 5V",
    description: "AP2112K-3.3, 600mA, with input and output capacitors. Feed it from the 5V rail - an LDO straight off 24V burns 10W and dies.",
    params: [
      { name: "vin_net", type: "string", default: "+5V", doc: "Input rail (must be 6V or less)" },
    ],
    build(params) {
      const vin = String(p(params, "vin_net", "+5V"));
      return {
        parts: [
          { local: "U", libId: "Regulator_Linear:AP2112K-3.3", value: "AP2112K-3.3", dx: 0, dy: 0 },
          { local: "CI", libId: "Device:C", value: "1u", dx: -22, dy: 2 },
          { local: "CO", libId: "Device:C", value: "10u", dx: 24, dy: 2 },
        ],
        wires: [],
        nets: [
          { local: "U", pin: "1", label: vin },
          { local: "U", pin: "3", label: vin },
          { local: "U", pin: "2", label: "GND" },
          { local: "U", pin: "5", label: "+3V3" },
          { local: "CI", pin: "1", label: vin },
          { local: "CI", pin: "2", label: "GND" },
          { local: "CO", pin: "1", label: "+3V3" },
          { local: "CO", pin: "2", label: "GND" },
        ],
      };
    },
  },

  // #region E-stop button input
  {
    id: "estop_input",
    name: "E-stop button input (fail-safe)",
    description:
      "A 2-pin connector for an external e-stop, wired fail-safe: a normally-closed button holds the pin at GND, so pressing the button OR cutting the cable reads as a stop. Includes the pull-up and an RC filter against motor noise.",
    params: [
      { name: "net", type: "string", default: "ESTOP1", doc: "Signal net into the MCU" },
    ],
    build(params) {
      const net = String(p(params, "net", "ESTOP1"));
      return {
        parts: [
          { local: "J", libId: "Connector:Conn_01x02", value: "E-stop (NC)", dx: 0, dy: 0 },
          { local: "RPU", libId: "Device:R", value: "10k", dx: 18, dy: -14 },
          { local: "RS", libId: "Device:R", value: "1k", dx: 18, dy: 2 },
          { local: "CF", libId: "Device:C", value: "100n", dx: 30, dy: 10 },
        ],
        wires: [],
        nets: [
          { local: "J", pin: "1", label: `${net}_RAW` },
          { local: "J", pin: "2", label: "GND" },
          { local: "RPU", pin: "1", label: "+3V3" },
          { local: "RPU", pin: "2", label: `${net}_RAW` },
          { local: "RS", pin: "1", label: `${net}_RAW` },
          { local: "RS", pin: "2", label: net },
          { local: "CF", pin: "1", label: net },
          { local: "CF", pin: "2", label: "GND" },
        ],
      };
    },
  },

  // #region I2C current monitor
  {
    id: "current_sense_i2c",
    name: "Current monitor (INA226 + shunt)",
    description:
      "One I2C current monitor across a shunt in a channel. Costs no ADC pins: 16 of these share the same two I2C wires by strapping A0/A1, so channel count is not limited by the MCU. Shunt value is computed from the channel's full-scale current for the INA226's 81.92mV range.",
    params: [
      { name: "channel", type: "string", default: "CH1", doc: "Channel name (net prefix)" },
      { name: "amps", type: "number", default: 20, unit: "A", doc: "Full-scale current for this channel" },
      { name: "addr", type: "number", default: 0, doc: "Address index 0-15 (sets the A0/A1 straps)" },
    ],
    build(params) {
      const ch = String(p(params, "channel", "CH1"));
      const amps = Math.max(0.1, Number(p(params, "amps", 20)));
      const addr = Math.max(0, Math.min(15, Math.round(Number(p(params, "addr", 0)))));
      // INA226 full-scale shunt voltage is 81.92mV; target ~75mV at full load.
      const rShunt = 0.075 / amps;
      const mOhm = rShunt * 1000;
      const shuntVal = `${+mOhm.toPrecision(2)}m`;
      // A1/A0 straps: low two bits pick GND/VS on A0, next two on A1.
      const a0 = addr % 4 < 2 ? "GND" : "+3V3";
      const a1 = addr < 8 ? "GND" : "+3V3";
      return {
        parts: [
          { local: "U", libId: "Sensor_Current:INA226", value: `INA226 (addr ${addr})`, dx: 0, dy: 0 },
          { local: "RS", libId: "Device:R", value: `${shuntVal} shunt`, dx: -30, dy: 0 },
          { local: "CD", libId: "Device:C", value: "100n", dx: 26, dy: -16 },
          { local: "RF1", libId: "Device:R", value: "10", dx: -18, dy: -8 },
          { local: "RF2", libId: "Device:R", value: "10", dx: -18, dy: 8 },
        ],
        wires: [],
        nets: [
          { local: "RS", pin: "1", label: `${ch}_HI` },
          { local: "RS", pin: "2", label: `${ch}_LO` },
          { local: "RF1", pin: "1", label: `${ch}_HI` },
          { local: "RF1", pin: "2", label: `${ch}_INP` },
          { local: "RF2", pin: "1", label: `${ch}_LO` },
          { local: "RF2", pin: "2", label: `${ch}_INN` },
          { local: "U", pin: "1", label: `${ch}_INP` },
          { local: "U", pin: "2", label: `${ch}_INN` },
          { local: "U", pin: "4", label: `${ch}_INP` },
          { local: "U", pin: "5", label: "GND" },
          { local: "U", pin: "10", label: "+3V3" },
          { local: "U", pin: "9", label: "SCL" },
          { local: "U", pin: "8", label: "SDA" },
          { local: "U", pin: "6", label: a0 },
          { local: "U", pin: "7", label: a1 },
          { local: "U", pin: "3", label: `${ch}_ALERT` },
          { local: "CD", pin: "1", label: "+3V3" },
          { local: "CD", pin: "2", label: "GND" },
        ],
      };
    },
  },

  // #region switched high-side channel
  {
    id: "high_side_channel",
    name: "Switched 24V channel (smart high-side switch)",
    description:
      "One 24V output the MCU can cut, using a TPS27S100B smart high-side switch: logic-level enable, its own current limit, and an IMON analog current output. This is the e-stop actuator for a channel and its current monitor in one part, at the cost of one GPIO and one ADC pin.",
    params: [
      { name: "channel", type: "string", default: "CH1", doc: "Channel name (net prefix)" },
      { name: "vin_net", type: "string", default: "+24V", doc: "Bus input net" },
      { name: "ilim_a", type: "number", default: 10, unit: "A", doc: "Current limit target" },
    ],
    build(params) {
      const ch = String(p(params, "channel", "CH1"));
      const vin = String(p(params, "vin_net", "+24V"));
      return {
        parts: [
          { local: "U", libId: "Power_Switch:TPS27S100B", value: "TPS27S100B", dx: 0, dy: 0 },
          { local: "RG", libId: "Device:R", value: "1k", dx: -30, dy: -6 },
          { local: "RILIM", libId: "Device:R", value: "30k", dx: 30, dy: 14 },
          { local: "RIMON", libId: "Device:R", value: "1k", dx: 42, dy: 14 },
          { local: "CIN", libId: "Device:C", value: "100n", dx: -30, dy: 14 },
        ],
        wires: [],
        nets: [
          { local: "U", pin: "8", label: vin },
          { local: "U", pin: "9", label: vin },
          { local: "U", pin: "10", label: vin },
          { local: "U", pin: "2", label: "GND" },
          { local: "U", pin: "3", label: `${ch}_EN` },
          { local: "U", pin: "5", label: `${ch}_OUT` },
          { local: "U", pin: "6", label: `${ch}_OUT` },
          { local: "U", pin: "7", label: `${ch}_OUT` },
          { local: "U", pin: "12", label: "+3V3" },
          { local: "U", pin: "13", label: `${ch}_ILIM` },
          { local: "U", pin: "14", label: `${ch}_IMON` },
          { local: "RG", pin: "1", label: `${ch}_EN_MCU` },
          { local: "RG", pin: "2", label: `${ch}_EN` },
          { local: "RILIM", pin: "1", label: `${ch}_ILIM` },
          { local: "RILIM", pin: "2", label: "GND" },
          { local: "RIMON", pin: "1", label: `${ch}_IMON` },
          { local: "RIMON", pin: "2", label: "GND" },
          { local: "CIN", pin: "1", label: vin },
          { local: "CIN", pin: "2", label: "GND" },
        ],
      };
    },
  },

  // #region RF heartbeat radio
  {
    id: "rf_heartbeat",
    name: "RF module for the remote e-stop heartbeat",
    description:
      "An SPI radio module on the board, for the remote e-stop's heartbeat. The MCU treats loss of heartbeat as a stop, so the radio only ever has to be believed when it says 'still alive'.",
    params: [
      { name: "cs_net", type: "string", default: "RF_CS", doc: "Chip select net" },
    ],
    build(params) {
      const cs = String(p(params, "cs_net", "RF_CS"));
      return {
        parts: [
          { local: "U", libId: "RF_Module:nRF24L01_Module", value: "nRF24L01+", dx: 0, dy: 0 },
          { local: "CD", libId: "Device:C", value: "10u", dx: -24, dy: 4 },
        ],
        wires: [],
        nets: [
          { local: "U", pin: "1", label: "GND" },
          { local: "U", pin: "2", label: "+3V3" },
          { local: "U", pin: "3", label: "RF_CE" },
          { local: "U", pin: "4", label: cs },
          { local: "U", pin: "5", label: "SPI_SCK" },
          { local: "U", pin: "6", label: "SPI_MOSI" },
          { local: "U", pin: "7", label: "SPI_MISO" },
          { local: "U", pin: "8", label: "RF_IRQ" },
          { local: "CD", pin: "1", label: "+3V3" },
          { local: "CD", pin: "2", label: "GND" },
        ],
      };
    },
  },
];


export const MODULES: Record<string, ModuleDef> = Object.fromEntries(modules.map((m) => [m.id, m]));

export function moduleSummaries(): { id: string; name: string; description: string; params: ModuleParam[] }[] {
  return modules.map((m) => ({ id: m.id, name: m.name, description: m.description, params: m.params }));
}
