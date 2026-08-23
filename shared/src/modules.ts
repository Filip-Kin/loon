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
];

export const MODULES: Record<string, ModuleDef> = Object.fromEntries(modules.map((m) => [m.id, m]));

export function moduleSummaries(): { id: string; name: string; description: string; params: ModuleParam[] }[] {
  return modules.map((m) => ({ id: m.id, name: m.name, description: m.description, params: m.params }));
}
