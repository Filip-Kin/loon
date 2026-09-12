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
  // Land pattern, when the default for the symbol is wrong. A 3.5A buck's
  // inductor is not an 0805 and its input cap is not an 0603; leaving those at
  // the catalog default is how a power stage ends up the size of a signal.
  footprint?: string;
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
  // "local" nets are internal to one instance and get a per-instance suffix, so
  // instantiating a module twice does not short its internals together. Nets
  // without this are the block's interface and keep their name.
  scope?: "local";
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
          { local: "CIN1", libId: "Device:C", value: "2.2u/100V", dx: -30, dy: -6, footprint: "Capacitor_SMD:C_1210_3225Metric" },
          { local: "CIN2", libId: "Device:C", value: "2.2u/100V", dx: -22, dy: -6, footprint: "Capacitor_SMD:C_1210_3225Metric" },
          { local: "CB", libId: "Device:C", value: "100n", dx: -8, dy: -26 },
          { local: "L", libId: "Device:L", value: "8.2u 5A", dx: 34, dy: -8, footprint: "Inductor_SMD:L_Bourns_SRN6045TA" },
          { local: "D", libId: "Device:D", value: "B560C", dx: 22, dy: 8, footprint: "Diode_SMD:D_SMA" },
          { local: "CO1", libId: "Device:C", value: "47u", dx: 46, dy: 4, footprint: "Capacitor_SMD:C_1210_3225Metric" },
          { local: "CO2", libId: "Device:C", value: "47u", dx: 54, dy: 4, footprint: "Capacitor_SMD:C_1210_3225Metric" },
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
          { local: "U", pin: "8", label: "SW", scope: "local" },
          { local: "U", pin: "1", label: "BOOT", scope: "local" },
          { local: "U", pin: "5", label: "FB", scope: "local" },
          { local: "U", pin: "6", label: "COMP", scope: "local" },
          { local: "U", pin: "4", label: "RT", scope: "local" },
          { local: "CIN1", pin: "1", label: vinNet },
          { local: "CIN1", pin: "2", label: "GND" },
          { local: "CIN2", pin: "1", label: vinNet },
          { local: "CIN2", pin: "2", label: "GND" },
          { local: "CB", pin: "1", label: "BOOT", scope: "local" },
          { local: "CB", pin: "2", label: "SW", scope: "local" },
          { local: "L", pin: "1", label: "SW", scope: "local" },
          { local: "L", pin: "2", label: voutNet },
          { local: "D", pin: "2", label: "SW", scope: "local" },
          { local: "D", pin: "1", label: "GND" },
          { local: "CO1", pin: "1", label: voutNet },
          { local: "CO1", pin: "2", label: "GND" },
          { local: "CO2", pin: "1", label: voutNet },
          { local: "CO2", pin: "2", label: "GND" },
          { local: "RHS", pin: "1", label: voutNet },
          { local: "RHS", pin: "2", label: "FB", scope: "local" },
          { local: "RLS", pin: "2", label: "GND" },
          { local: "RT", pin: "1", label: "RT", scope: "local" },
          { local: "RT", pin: "2", label: "GND" },
          { local: "RCOMP", pin: "1", label: "COMP", scope: "local" },
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
    id: "ethernet_w5500",
    name: "Ethernet port (W5500 + MagJack)",
    description:
      "Wired Ethernet on SPI. The ESP32-S3 has no Ethernet MAC, so the network comes in through a W5500 hardwired TCP/IP controller, into an RJ45 with the magnetics inside it. Use this when something else on the robot has to be told what this board is doing - the e-stop state, channel currents - over a cable rather than a radio.",
    params: [
      { name: "cs_net", type: "string", default: "ETH_CS", doc: "Chip select net" },
      { name: "int_net", type: "string", default: "ETH_INT", doc: "Interrupt net" },
      { name: "rst_net", type: "string", default: "ETH_RST", doc: "Reset net" },
    ],
    build(params) {
      const cs = String(p(params, "cs_net", "ETH_CS"));
      const irq = String(p(params, "int_net", "ETH_INT"));
      const rst = String(p(params, "rst_net", "ETH_RST"));
      return {
        parts: [
          { local: "U", libId: "Interface_Ethernet:W5500", value: "W5500", dx: 0, dy: 0 },
          { local: "J", libId: "Connector:RJ45_MagJack", value: "RJ45 MagJack", dx: 70, dy: 0 },
          // 25MHz, and the datasheet is specific about it.
          { local: "Y", libId: "Device:Crystal_GND24", value: "25MHz", dx: -30, dy: 30 },
          { local: "CY1", libId: "Device:C", value: "22p", dx: -40, dy: 36 },
          { local: "CY2", libId: "Device:C", value: "22p", dx: -20, dy: 36 },
          // Biasing for the analog front end. 1% or the PHY drifts.
          { local: "REX", libId: "Device:R", value: "12.4k 1%", dx: -30, dy: -20 },
          { local: "CTO", libId: "Device:C", value: "4.7u", dx: -30, dy: -8, footprint: "Capacitor_SMD:C_0805_2012Metric" },
          { local: "C12", libId: "Device:C", value: "10n", dx: -30, dy: 2 },
          { local: "CD1", libId: "Device:C", value: "100n", dx: -46, dy: -30 },
          { local: "CD2", libId: "Device:C", value: "100n", dx: -38, dy: -30 },
          { local: "CD3", libId: "Device:C", value: "100n", dx: -30, dy: -30 },
          { local: "CD4", libId: "Device:C", value: "100n", dx: -22, dy: -30 },
          { local: "CB", libId: "Device:C", value: "10u", dx: -14, dy: -30, footprint: "Capacitor_SMD:C_0805_2012Metric" },
          // Centre taps sit on the rail with their own decoupling.
          { local: "CT1", libId: "Device:C", value: "100n", dx: 40, dy: -14 },
          { local: "CT2", libId: "Device:C", value: "100n", dx: 52, dy: -14 },
          { local: "RRST", libId: "Device:R", value: "10k", dx: 30, dy: -30 },
          { local: "RL1", libId: "Device:R", value: "330", dx: 100, dy: -10 },
          { local: "RL2", libId: "Device:R", value: "330", dx: 100, dy: 10 },
        ],
        wires: [],
        nets: [
          // Supplies. Every AVDD pin gets the rail; the decoupling sits on it.
          { local: "U", pin: "4", label: "+3V3" },
          { local: "U", pin: "8", label: "+3V3" },
          { local: "U", pin: "11", label: "+3V3" },
          { local: "U", pin: "15", label: "+3V3" },
          { local: "U", pin: "17", label: "+3V3" },
          { local: "U", pin: "21", label: "+3V3" },
          { local: "U", pin: "28", label: "+3V3" },
          { local: "U", pin: "3", label: "GND" },
          { local: "U", pin: "9", label: "GND" },
          { local: "U", pin: "14", label: "GND" },
          { local: "U", pin: "16", label: "GND" },
          { local: "U", pin: "19", label: "GND" },
          { local: "U", pin: "29", label: "GND" },
          { local: "U", pin: "48", label: "GND" },
          // RSVD pin 23 is tied to ground; 38-42 are left open on their own
          // pull-downs, and PMODE 43-45 float to "all capable, auto-negotiate".
          { local: "U", pin: "23", label: "GND" },
          // Analog housekeeping.
          { local: "U", pin: "10", label: "ETH_EXRES", scope: "local" },
          { local: "REX", pin: "1", label: "ETH_EXRES", scope: "local" },
          { local: "REX", pin: "2", label: "GND" },
          { local: "U", pin: "20", label: "ETH_TOCAP", scope: "local" },
          { local: "CTO", pin: "1", label: "ETH_TOCAP", scope: "local" },
          { local: "CTO", pin: "2", label: "GND" },
          { local: "U", pin: "22", label: "ETH_1V2", scope: "local" },
          { local: "C12", pin: "1", label: "ETH_1V2", scope: "local" },
          { local: "C12", pin: "2", label: "GND" },
          // Clock.
          { local: "U", pin: "30", label: "ETH_XI", scope: "local" },
          { local: "U", pin: "31", label: "ETH_XO", scope: "local" },
          { local: "Y", pin: "1", label: "ETH_XI", scope: "local" },
          { local: "Y", pin: "3", label: "ETH_XO", scope: "local" },
          { local: "Y", pin: "2", label: "GND" },
          { local: "Y", pin: "4", label: "GND" },
          { local: "CY1", pin: "1", label: "ETH_XI", scope: "local" },
          { local: "CY1", pin: "2", label: "GND" },
          { local: "CY2", pin: "1", label: "ETH_XO", scope: "local" },
          { local: "CY2", pin: "2", label: "GND" },
          // The SPI bus, shared with the radio; only the chip select is its own.
          { local: "U", pin: "32", label: cs },
          { local: "U", pin: "33", label: "SPI_SCK" },
          { local: "U", pin: "34", label: "SPI_MISO" },
          { local: "U", pin: "35", label: "SPI_MOSI" },
          { local: "U", pin: "36", label: irq },
          { local: "U", pin: "37", label: rst },
          { local: "RRST", pin: "1", label: "+3V3" },
          { local: "RRST", pin: "2", label: rst },
          // The wire itself. 1:1 transformers inside the jack, centre taps on
          // the rail.
          { local: "U", pin: "2", label: "ETH_TXP", scope: "local" },
          { local: "U", pin: "1", label: "ETH_TXN", scope: "local" },
          { local: "U", pin: "6", label: "ETH_RXP", scope: "local" },
          { local: "U", pin: "5", label: "ETH_RXN", scope: "local" },
          { local: "J", pin: "R1", label: "ETH_TXP", scope: "local" },
          { local: "J", pin: "R2", label: "ETH_TXN", scope: "local" },
          { local: "J", pin: "R3", label: "ETH_RXP", scope: "local" },
          { local: "J", pin: "R6", label: "ETH_RXN", scope: "local" },
          { local: "J", pin: "R4", label: "+3V3" },
          { local: "J", pin: "R5", label: "+3V3" },
          { local: "J", pin: "R8", label: "GND" },
          { local: "CT1", pin: "1", label: "+3V3" },
          { local: "CT1", pin: "2", label: "GND" },
          { local: "CT2", pin: "1", label: "+3V3" },
          { local: "CT2", pin: "2", label: "GND" },
          // Link and activity lights. The W5500 sinks them, so the anode is on
          // the rail.
          { local: "RL1", pin: "1", label: "+3V3" },
          { local: "RL1", pin: "2", label: "ETH_LEDG_A", scope: "local" },
          { local: "J", pin: "L4", label: "ETH_LEDG_A", scope: "local" },
          { local: "J", pin: "L3", label: "ETH_LINK", scope: "local" },
          { local: "U", pin: "25", label: "ETH_LINK", scope: "local" },
          { local: "RL2", pin: "1", label: "+3V3" },
          { local: "RL2", pin: "2", label: "ETH_LEDY_A", scope: "local" },
          { local: "J", pin: "L1", label: "ETH_LEDY_A", scope: "local" },
          { local: "J", pin: "L2", label: "ETH_ACT", scope: "local" },
          { local: "U", pin: "27", label: "ETH_ACT", scope: "local" },
          // Decoupling.
          { local: "CD1", pin: "1", label: "+3V3" },
          { local: "CD1", pin: "2", label: "GND" },
          { local: "CD2", pin: "1", label: "+3V3" },
          { local: "CD2", pin: "2", label: "GND" },
          { local: "CD3", pin: "1", label: "+3V3" },
          { local: "CD3", pin: "2", label: "GND" },
          { local: "CD4", pin: "1", label: "+3V3" },
          { local: "CD4", pin: "2", label: "GND" },
          { local: "CB", pin: "1", label: "+3V3" },
          { local: "CB", pin: "2", label: "GND" },
        ],
      };
    },
  },
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
  // #region e-stop latch
  {
    id: "estop_latch",
    name: "E-stop latch (hardware, with the software path wired in)",
    description:
      "A latch that holds the board stopped until a person arms it again. Any panel e-stop drives a diode OR straight into the flip-flop's asynchronous CLR - no firmware involved. The MCU joins the same OR through a charge-pump watchdog: it has to keep toggling WDT_KICK to stay armed, so a lost RF heartbeat, a pressed remote e-stop, a firmware hang or a dead MCU all stop the board through the same hardware path. Arming needs a rising edge on ARM from the MCU, so nothing re-enables itself, and an RC on CLR holds the board stopped through power-up.",
    params: [
      { name: "run_net", type: "string", default: "ESTOP_RUN", doc: "Enable net for the switched channels (high = allowed to run)" },
      { name: "inputs", type: "number", default: 2, doc: "Number of panel e-stop inputs joining the OR" },
      { name: "decay_ms", type: "number", default: 20, unit: "ms", doc: "How long after the MCU stops toggling the latch trips" },
    ],
    build(params) {
      const run = String(p(params, "run_net", "ESTOP_RUN"));
      const nIn = Math.max(1, Math.min(4, Math.round(Number(p(params, "inputs", 2)))));
      const decayMs = Math.max(5, Number(p(params, "decay_ms", 20)));
      // Watchdog detector decay is R x C, with C fixed at 470n.
      const rDet = decayMs / 1000 / 470e-9;
      const parts: ModulePart[] = [
        { local: "U", libId: "Logic_Flipflop:SN74LVC1G74", value: "SN74LVC1G74", dx: 0, dy: 0 },
        { local: "CD", libId: "Device:C", value: "100n", dx: 24, dy: -22 },
        { local: "RD", libId: "Device:R", value: "10k", dx: -34, dy: -26 },
        { local: "RPRE", libId: "Device:R", value: "10k", dx: -34, dy: -12 },
        { local: "RCLR", libId: "Device:R", value: "10k", dx: -50, dy: 6 },
        { local: "CPOR", libId: "Device:C", value: "1u", dx: -50, dy: 20 },
        { local: "QINV", libId: "Device:Q_NMOS_GSD", value: "2N7002", dx: -66, dy: 10 },
        { local: "RTRIP", libId: "Device:R", value: "10k", dx: -80, dy: 22 },
        { local: "CP", libId: "Device:C", value: "100n", dx: -110, dy: -20 },
        { local: "DP1", libId: "Device:D", value: "BAT54", dx: -98, dy: -20 },
        { local: "DP2", libId: "Device:D", value: "BAT54", dx: -110, dy: -6 },
        { local: "RDET", libId: "Device:R", value: nearestE12(rDet), dx: -88, dy: -6 },
        { local: "CDET", libId: "Device:C", value: "470n", dx: -80, dy: -6 },
        { local: "QWD", libId: "Device:Q_NMOS_GSD", value: "2N7002", dx: -96, dy: 10 },
        { local: "RWD", libId: "Device:R", value: "10k", dx: -96, dy: -2 },
        { local: "DLED", libId: "Device:LED", value: "green RUN", dx: 36, dy: 10 },
        { local: "RLED", libId: "Device:R", value: "1k", dx: 36, dy: 22 },
      ];
      const nets: ModuleNet[] = [
        { local: "U", pin: "8", label: "+3V3" },
        { local: "U", pin: "4", label: "GND" },
        { local: "U", pin: "2", label: "ARM_D", scope: "local" },
        { local: "U", pin: "1", label: "ARM" },
        { local: "U", pin: "6", label: "CLR_N", scope: "local" },
        { local: "U", pin: "7", label: "PRE_N", scope: "local" },
        { local: "U", pin: "5", label: run },
        { local: "U", pin: "3", label: "ESTOP_TRIPPED", scope: "local" },
        { local: "CD", pin: "1", label: "+3V3" },
        { local: "CD", pin: "2", label: "GND" },
        { local: "RD", pin: "1", label: "+3V3" },
        { local: "RD", pin: "2", label: "ARM_D", scope: "local" },
        { local: "RPRE", pin: "1", label: "+3V3" },
        { local: "RPRE", pin: "2", label: "PRE_N", scope: "local" },
        { local: "RCLR", pin: "1", label: "+3V3" },
        { local: "RCLR", pin: "2", label: "CLR_N", scope: "local" },
        { local: "CPOR", pin: "1", label: "CLR_N", scope: "local" },
        { local: "CPOR", pin: "2", label: "GND" },
        { local: "QINV", pin: "1", label: "ESTOP_TRIP", scope: "local" },
        { local: "QINV", pin: "3", label: "CLR_N", scope: "local" },
        { local: "QINV", pin: "2", label: "GND" },
        { local: "RTRIP", pin: "1", label: "ESTOP_TRIP", scope: "local" },
        { local: "RTRIP", pin: "2", label: "GND" },
        { local: "CP", pin: "1", label: "WDT_KICK" },
        { local: "CP", pin: "2", label: "WDT_PUMP", scope: "local" },
        { local: "DP2", pin: "1", label: "WDT_PUMP", scope: "local" },
        { local: "DP2", pin: "2", label: "GND" },
        { local: "DP1", pin: "2", label: "WDT_PUMP", scope: "local" },
        { local: "DP1", pin: "1", label: "WDT_DET", scope: "local" },
        { local: "RDET", pin: "1", label: "WDT_DET", scope: "local" },
        { local: "RDET", pin: "2", label: "GND" },
        { local: "CDET", pin: "1", label: "WDT_DET", scope: "local" },
        { local: "CDET", pin: "2", label: "GND" },
        { local: "QWD", pin: "1", label: "WDT_DET", scope: "local" },
        { local: "QWD", pin: "3", label: "WDT_FAIL", scope: "local" },
        { local: "QWD", pin: "2", label: "GND" },
        { local: "RWD", pin: "1", label: "+3V3" },
        { local: "RWD", pin: "2", label: "WDT_FAIL", scope: "local" },
        { local: "DLED", pin: "2", label: run },
        { local: "DLED", pin: "1", label: "RUN_LED", scope: "local" },
        { local: "RLED", pin: "1", label: "RUN_LED", scope: "local" },
        { local: "RLED", pin: "2", label: "GND" },
      ];
      // Diode OR: every trip source, hardware or software, drives one node.
      for (let i = 0; i < nIn; i++) {
        const local = `DIN${i}`;
        parts.push({ local, libId: "Device:D", value: "BAT54", dx: -96 - i * 12, dy: 34 });
        nets.push({ local, pin: "2", label: `ESTOP${i + 1}` });
        nets.push({ local, pin: "1", label: "ESTOP_TRIP", scope: "local" });
      }
      parts.push({ local: "DWD", libId: "Device:D", value: "BAT54", dx: -96 - nIn * 12, dy: 34 });
      nets.push({ local: "DWD", pin: "2", label: "WDT_FAIL", scope: "local" });
      nets.push({ local: "DWD", pin: "1", label: "ESTOP_TRIP", scope: "local" });
      return { parts, wires: [], nets };
    },
  },

  // #region 4-switch buck-boost
  {
    id: "buckboost_20v",
    name: "Buck-boost rail (a 20V computer supply off a 24V pack)",
    description:
      "LM5175 4-switch buck-boost with external FETs. A plain buck cannot hold 20V from a 24V pack, because the pack sags under motor load until the input sits below the output; this regulates through that crossover. Values follow the datasheet's worked example, so the power stage still needs resizing for the real load current.",
    params: [
      { name: "vout", type: "number", default: 20, unit: "V", doc: "Output voltage" },
      { name: "iout", type: "number", default: 4.5, unit: "A", doc: "Load current (a 90W laptop brick is about 4.5A at 20V)" },
      { name: "vin_net", type: "string", default: "+24V", doc: "Bus input net" },
      { name: "vout_net", type: "string", default: "+20V", doc: "Output net" },
    ],
    build(params) {
      const vout = Math.max(1, Number(p(params, "vout", 20)));
      const voutNet = String(p(params, "vout_net", "+20V"));
      const vinNet = String(p(params, "vin_net", "+24V"));
      // The FB reference is 0.8V, with the low-side resistor fixed at 10k.
      const rhs = (10000 * (vout - 0.8)) / 0.8;
      return {
        parts: [
          { local: "U", libId: "Regulator_Switching:LM5175", value: "LM5175", dx: 0, dy: 0 },
          { local: "QH1", libId: "Transistor_FET:Power_NMOS_60V", value: "QH1", dx: 60, dy: -40 },
          { local: "QL1", libId: "Transistor_FET:Power_NMOS_60V", value: "QL1", dx: 60, dy: -16 },
          { local: "QH2", libId: "Transistor_FET:Power_NMOS_60V", value: "QH2", dx: 100, dy: -40 },
          { local: "QL2", libId: "Transistor_FET:Power_NMOS_60V", value: "QL2", dx: 100, dy: -16 },
          { local: "L", libId: "Device:L", value: "4.7u 10A", dx: 80, dy: -52, footprint: "Inductor_SMD:L_12x12mm_H6mm" },
          { local: "RSNS", libId: "Device:R", value: "8m 2W", dx: 80, dy: 6 },
          { local: "CIN1", libId: "Device:C", value: "22u/50V", dx: -40, dy: -30, footprint: "Capacitor_SMD:C_1210_3225Metric" },
          { local: "CIN2", libId: "Device:C", value: "22u/50V", dx: -32, dy: -30, footprint: "Capacitor_SMD:C_1210_3225Metric" },
          { local: "CO1", libId: "Device:C", value: "47u/50V", dx: 124, dy: 4, footprint: "Capacitor_SMD:C_1210_3225Metric" },
          { local: "CO2", libId: "Device:C", value: "47u/50V", dx: 132, dy: 4, footprint: "Capacitor_SMD:C_1210_3225Metric" },
          { local: "CB1", libId: "Device:C", value: "100n", dx: 44, dy: -52 },
          { local: "CB2", libId: "Device:C", value: "100n", dx: 116, dy: -52 },
          { local: "CVCC", libId: "Device:C", value: "2.2u", dx: 24, dy: 34 },
          { local: "RT", libId: "Device:R", value: "80.6k", dx: -40, dy: 6 },
          { local: "RMODE", libId: "Device:R", value: "93.1k", dx: -40, dy: 18 },
          { local: "CSS", libId: "Device:C", value: "100n", dx: -40, dy: 30 },
          { local: "CSLOPE", libId: "Device:C", value: "100p", dx: -40, dy: 42 },
          { local: "RCOMP", libId: "Device:R", value: "10k", dx: -56, dy: 30 },
          { local: "CCOMP", libId: "Device:C", value: "4700p", dx: -56, dy: 42 },
          { local: "RUV1", libId: "Device:R", value: "59k", dx: -56, dy: -14 },
          { local: "RUV2", libId: "Device:R", value: "249k", dx: -56, dy: -28 },
          { local: "RHS", libId: "Device:R", value: nearestE96(rhs), dx: 148, dy: 22 },
          { local: "RLS", libId: "Device:R", value: "10k", dx: 148, dy: 34 },
        ],
        wires: [
          { a: { local: "RHS", pin: "2" }, b: { local: "RLS", pin: "1" } },
          { a: { local: "RCOMP", pin: "2" }, b: { local: "CCOMP", pin: "1" } },
          { a: { local: "RUV2", pin: "2" }, b: { local: "RUV1", pin: "1" } },
        ],
        nets: [
          { local: "U", pin: "2", label: vinNet },
          { local: "U", pin: "3", label: vinNet },
          { local: "U", pin: "1", label: "BB_UVLO", scope: "local" },
          { local: "U", pin: "4", label: "BB_MODE", scope: "local" },
          { local: "U", pin: "5", label: "GND" },
          { local: "U", pin: "6", label: "BB_RT", scope: "local" },
          { local: "U", pin: "7", label: "BB_SLOPE", scope: "local" },
          { local: "U", pin: "8", label: "BB_SS", scope: "local" },
          { local: "U", pin: "9", label: "BB_COMP", scope: "local" },
          { local: "U", pin: "10", label: "GND" },
          { local: "U", pin: "11", label: "BB_FB", scope: "local" },
          { local: "U", pin: "12", label: voutNet },
          { local: "U", pin: "13", label: "BB_ISNS", scope: "local" },
          { local: "U", pin: "14", label: "BB_ISNS", scope: "local" },
          { local: "U", pin: "15", label: "GND" },
          { local: "U", pin: "16", label: "BB_CS", scope: "local" },
          { local: "U", pin: "17", label: "BB_PGOOD", scope: "local" },
          { local: "U", pin: "18", label: "SW2", scope: "local" },
          { local: "U", pin: "19", label: "HDRV2", scope: "local" },
          { local: "U", pin: "20", label: "BOOT2", scope: "local" },
          { local: "U", pin: "21", label: "LDRV2", scope: "local" },
          { local: "U", pin: "22", label: "GND" },
          { local: "U", pin: "23", label: "BB_VCC", scope: "local" },
          { local: "U", pin: "24", label: "BB_VCC", scope: "local" },
          { local: "U", pin: "25", label: "LDRV1", scope: "local" },
          { local: "U", pin: "26", label: "BOOT1", scope: "local" },
          { local: "U", pin: "27", label: "HDRV1", scope: "local" },
          { local: "U", pin: "28", label: "SW1", scope: "local" },
          { local: "U", pin: "29", label: "GND" },
          { local: "QH1", pin: "3", label: vinNet },
          { local: "QH1", pin: "1", label: "HDRV1", scope: "local" },
          { local: "QH1", pin: "2", label: "SW1", scope: "local" },
          { local: "QL1", pin: "3", label: "SW1", scope: "local" },
          { local: "QL1", pin: "1", label: "LDRV1", scope: "local" },
          { local: "QL1", pin: "2", label: "BB_CS", scope: "local" },
          { local: "QH2", pin: "3", label: voutNet },
          { local: "QH2", pin: "1", label: "HDRV2", scope: "local" },
          { local: "QH2", pin: "2", label: "SW2", scope: "local" },
          { local: "QL2", pin: "3", label: "SW2", scope: "local" },
          { local: "QL2", pin: "1", label: "LDRV2", scope: "local" },
          { local: "QL2", pin: "2", label: "BB_CS", scope: "local" },
          { local: "L", pin: "1", label: "SW1", scope: "local" },
          { local: "L", pin: "2", label: "SW2", scope: "local" },
          { local: "RSNS", pin: "1", label: "BB_CS", scope: "local" },
          { local: "RSNS", pin: "2", label: "GND" },
          { local: "CB1", pin: "1", label: "BOOT1", scope: "local" },
          { local: "CB1", pin: "2", label: "SW1", scope: "local" },
          { local: "CB2", pin: "1", label: "BOOT2", scope: "local" },
          { local: "CB2", pin: "2", label: "SW2", scope: "local" },
          { local: "CIN1", pin: "1", label: vinNet },
          { local: "CIN1", pin: "2", label: "GND" },
          { local: "CIN2", pin: "1", label: vinNet },
          { local: "CIN2", pin: "2", label: "GND" },
          { local: "CO1", pin: "1", label: voutNet },
          { local: "CO1", pin: "2", label: "GND" },
          { local: "CO2", pin: "1", label: voutNet },
          { local: "CO2", pin: "2", label: "GND" },
          { local: "CVCC", pin: "1", label: "BB_VCC", scope: "local" },
          { local: "CVCC", pin: "2", label: "GND" },
          { local: "RT", pin: "1", label: "BB_RT", scope: "local" },
          { local: "RT", pin: "2", label: "GND" },
          { local: "RMODE", pin: "1", label: "BB_MODE", scope: "local" },
          { local: "RMODE", pin: "2", label: "GND" },
          { local: "CSS", pin: "1", label: "BB_SS", scope: "local" },
          { local: "CSS", pin: "2", label: "GND" },
          { local: "CSLOPE", pin: "1", label: "BB_SLOPE", scope: "local" },
          { local: "CSLOPE", pin: "2", label: "GND" },
          { local: "RCOMP", pin: "1", label: "BB_COMP", scope: "local" },
          { local: "CCOMP", pin: "2", label: "GND" },
          { local: "RUV2", pin: "1", label: vinNet },
          { local: "RUV1", pin: "1", label: "BB_UVLO", scope: "local" },
          { local: "RUV1", pin: "2", label: "GND" },
          { local: "RHS", pin: "1", label: voutNet },
          { local: "RHS", pin: "2", label: "BB_FB", scope: "local" },
          { local: "RLS", pin: "2", label: "GND" },
        ],
      };
    },
  },
];


export const MODULES: Record<string, ModuleDef> = Object.fromEntries(modules.map((m) => [m.id, m]));

export function moduleSummaries(): { id: string; name: string; description: string; params: ModuleParam[] }[] {
  return modules.map((m) => ({ id: m.id, name: m.name, description: m.description, params: m.params }));
}
