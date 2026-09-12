// #region Logic simulation
// Answers "does the e-stop actually stop the board" without waiting for copper.
// SPICE tells you what the volts do and QEMU tells you what the firmware does;
// this runs the board's logic, which is where a safety chain is right or wrong.
//
// It is a logic-level model, not an analog one: nets are high, low or floating,
// and an RC delays a transition rather than producing a curve. Where that model
// cannot express a part, the part says so instead of pretending.

import type { Schematic } from "./schematic";
import { buildNetlist, type Netlist, type DefResolver } from "./netlist";

export type Level = 0 | 1 | "z";

export interface SimInput {
  // Net or control the user can drive from the UI.
  id: string;
  label: string;
  kind: "estop" | "button" | "kick" | "pin";
  // For a fail-safe e-stop loop: pressed means the loop opens.
  pressed?: boolean;
  // For the MCU heartbeat: whether firmware is still toggling.
  alive?: boolean;
}

export interface SimState {
  t: number; // ms
  levels: Record<string, Level>;
  inputs: SimInput[];
  notes: string[];
}

interface PartModel {
  ref: string;
  libId: string;
  value: string;
  pins: Record<string, string>; // pin number -> net
}

const RAIL_HIGH = /^(\+3V3|\+5V|VCC|VDD|\+3\.3V)$/i;
const RAIL_GND = /^(GND|AGND|PGND|VSS)$/i;

// Values like "10k", "470n", "1u" -> ohms / farads.
function magnitude(raw: string): number {
  const m = (raw || "").trim().match(/^([\d.]+)\s*([a-zA-Z]?)/);
  if (!m) return NaN;
  const mult: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, M: 1e6, "": 1 };
  const suffix = m[2] === "M" ? "M" : m[2].toLowerCase();
  return parseFloat(m[1]) * (mult[suffix] ?? 1);
}

export function buildModels(schem: Schematic, resolve?: DefResolver, netlist?: Netlist): { models: PartModel[]; nl: Netlist } {
  const nl = netlist ?? buildNetlist(schem, resolve);
  const models: PartModel[] = [];
  for (const s of schem.symbols) {
    if (s.libId.startsWith("power:")) continue;
    const ref = s.properties.Reference ?? "?";
    const pins: Record<string, string> = {};
    for (const [key, net] of Object.entries(nl.netOfPin)) {
      const [r, pin] = key.split(":");
      if (r === ref) pins[pin] = net;
    }
    models.push({ ref, libId: s.libId, value: s.properties.Value ?? "", pins });
  }
  return { models, nl };
}

// What the user can press. Derived from the design, so a board with three
// e-stops gets three switches without anyone configuring it.
export function deriveInputs(models: PartModel[]): SimInput[] {
  const inputs: SimInput[] = [];
  for (const m of models) {
    if (m.libId === "Connector:Conn_01x02" && /e-?stop/i.test(m.value)) {
      inputs.push({ id: m.ref, label: `${m.value || "E-stop"} (${m.ref})`, kind: "estop", pressed: false });
    } else if (m.libId === "Switch:SW_Push") {
      inputs.push({ id: m.ref, label: `${m.value || "Button"} (${m.ref})`, kind: "button", pressed: false });
    }
  }
  // The MCU's watchdog kick: the software side of the safety chain.
  inputs.push({ id: "MCU", label: "MCU firmware alive (kicking the watchdog)", kind: "kick", alive: true });
  inputs.push({ id: "ARM", label: "MCU arms the latch (rising edge)", kind: "pin", pressed: false });
  return inputs;
}

// Each pass recomputes every net from scratch: strong drivers first, then
// diode propagation, then weak pulls through resistors. Nothing is remembered
// between passes except what genuinely has memory - flip-flop state, and nets
// held up by a capacitor.
export class LogicSim {
  private held = new Map<string, Level>(); // capacitor-backed nets
  private pending = new Map<string, { level: Level; at: number }>();
  private levels = new Map<string, Level>();
  private flops = new Map<string, { q: Level; lastClk: Level }>();
  private capNets = new Set<string>();
  t = 0;
  notes: string[] = [];

  constructor(private models: PartModel[], public inputs: SimInput[]) {
    for (const m of models) {
      if (m.libId !== "Device:C") continue;
      for (const net of Object.values(m.pins)) {
        if (!RAIL_GND.test(net) && !RAIL_HIGH.test(net)) this.capNets.add(net);
      }
    }
    this.reset();
  }

  reset() {
    this.t = 0;
    this.held.clear();
    this.pending.clear();
    this.levels.clear();
    this.notes = [];
    for (const m of this.models) this.flops.set(m.ref, { q: 0, lastClk: 0 });
    // A capacitor starts discharged, which is what holds the board stopped
    // through power-up.
    for (const net of this.capNets) this.held.set(net, 0);
    this.settle();
  }

  level(net: string): Level {
    if (RAIL_HIGH.test(net)) return 1;
    if (RAIL_GND.test(net)) return 0;
    return this.levels.get(net) ?? "z";
  }

  private inputFor(ref: string): SimInput | undefined {
    return this.inputs.find((i) => i.id === ref);
  }

  // The RC time constant on a net, in ms, from the parts actually attached.
  private delayFor(net: string): number {
    let r = NaN;
    let c = NaN;
    for (const m of this.models) {
      if (!Object.values(m.pins).includes(net)) continue;
      if (m.libId === "Device:R" && isNaN(r)) r = magnitude(m.value);
      if (m.libId === "Device:C" && isNaN(c)) c = magnitude(m.value);
    }
    if (isNaN(r) || isNaN(c)) return 0;
    return Math.max(1, r * c * 1000 * 0.7);
  }

  // One resolution pass. `prev` is what the previous pass concluded, used for
  // feedback loops; capacitor nets read their held value instead.
  private resolvePass(prev: Map<string, Level>): { levels: Map<string, Level>; strongNets: Set<string> } {
    const strong = new Map<string, Level>();
    const weak = new Map<string, Level>();
    const read = (net: string | undefined): Level => {
      if (!net) return "z";
      if (RAIL_HIGH.test(net)) return 1;
      if (RAIL_GND.test(net)) return 0;
      if (this.capNets.has(net)) return this.held.get(net) ?? "z";
      return prev.get(net) ?? "z";
    };
    const drive = (net: string | undefined, level: Level) => {
      if (!net || RAIL_HIGH.test(net) || RAIL_GND.test(net)) return;
      strong.set(net, level);
    };
    const pull = (net: string | undefined, level: Level) => {
      if (!net || RAIL_HIGH.test(net) || RAIL_GND.test(net)) return;
      if (!weak.has(net)) weak.set(net, level);
    };

    const alive = this.inputFor("MCU")?.alive !== false;
    const armPressed = this.inputFor("ARM")?.pressed ?? false;

    // 1. Parts that drive hard.
    for (const m of this.models) {
      const p = m.pins;
      switch (m.libId) {
        case "Switch:SW_Push": {
          if (!this.inputFor(m.ref)?.pressed) break;
          const [a, b] = [p["1"], p["2"]];
          if (a && b) {
            if (RAIL_GND.test(b)) drive(a, 0);
            else if (RAIL_GND.test(a)) drive(b, 0);
            else if (RAIL_HIGH.test(b)) drive(a, 1);
            else if (RAIL_HIGH.test(a)) drive(b, 1);
          }
          break;
        }
        case "Connector:Conn_01x02": {
          const inp = this.inputFor(m.ref);
          if (inp?.kind !== "estop") break;
          // Normally closed: held at ground until pressed or cut.
          if (!inp.pressed) drive(p["1"], 0);
          break;
        }
        case "Device:Q_NMOS_GSD": {
          if (read(p["1"]) === 1) drive(p["3"], RAIL_GND.test(p["2"] ?? "") ? 0 : read(p["2"]));
          break;
        }
        case "Device:Q_NPN_BCE": {
          if (read(p["1"]) === 1) drive(p["2"], 0);
          break;
        }
        case "Logic_Flipflop:SN74LVC1G74": {
          const st = this.flops.get(m.ref)!;
          drive(p["5"], st.q);
          drive(p["3"], st.q === 1 ? 0 : 1);
          break;
        }
        case "Power_Switch:TPS27S100B": {
          const en = read(p["3"]);
          for (const out of ["5", "6", "7"]) drive(p[out], en === 1 ? 1 : 0);
          break;
        }
        case "RF_Module:ESP32-S3-WROOM-1": {
          for (const net of Object.values(p)) {
            if (/^WDT_KICK$/i.test(net)) drive(net, alive ? 1 : 0);
            if (/^ARM$/i.test(net)) drive(net, armPressed ? 1 : 0);
          }
          break;
        }
        default:
          break;
      }
    }

    // The MCU's two control lines exist even when its symbol is not on the
    // sheet, because the user is standing in for the firmware.
    for (const m of this.models) {
      for (const net of Object.values(m.pins)) {
        if (/^WDT_KICK$/i.test(net) && !strong.has(net)) strong.set(net, alive ? 1 : 0);
        if (/^ARM$/i.test(net) && !strong.has(net)) strong.set(net, armPressed ? 1 : 0);
      }
    }

    // 2. Diodes pass a high anode through to the cathode. Repeat so a chain of
    // them settles in one pass.
    for (let i = 0; i < 3; i++) {
      for (const m of this.models) {
        if (m.libId !== "Device:D" && m.libId !== "Device:LED") continue;
        const k = m.pins["1"];
        const anode = m.pins["2"];
        if (!k || !anode) continue;
        const a = strong.get(anode) ?? read(anode);
        if (a === 1) strong.set(k, 1);
      }
    }

    // 3. The charge-pump watchdog: while the MCU kicks, the detector is held
    // up; when it stops, it decays with its own RC.
    for (const m of this.models) {
      for (const net of Object.values(m.pins)) {
        if (!/WDT_DET/i.test(net)) continue;
        if (alive) strong.set(net, 1);
        else if (!strong.has(net)) weak.set(net, 0);
      }
    }

    // 4. Resistors: pass a driven level to a floating neighbour, and pull to a
    // rail. These only decide nets nothing else is driving.
    for (let i = 0; i < 3; i++) {
      for (const m of this.models) {
        if (m.libId !== "Device:R") continue;
        const [a, b] = [m.pins["1"], m.pins["2"]];
        if (!a || !b) continue;
        const la = strong.get(a) ?? (RAIL_HIGH.test(a) ? 1 : RAIL_GND.test(a) ? 0 : weak.get(a) ?? "z");
        const lb = strong.get(b) ?? (RAIL_HIGH.test(b) ? 1 : RAIL_GND.test(b) ? 0 : weak.get(b) ?? "z");
        if (la !== "z" && !strong.has(b)) pull(b, la);
        if (lb !== "z" && !strong.has(a)) pull(a, lb);
      }
    }

    const out = new Map<string, Level>();
    const nets = new Set<string>([...strong.keys(), ...weak.keys(), ...prev.keys()]);
    for (const net of nets) out.set(net, strong.get(net) ?? weak.get(net) ?? "z");
    return { levels: out, strongNets: new Set(strong.keys()) };
  }

  // Iterate a few passes so combinational feedback settles, then apply the RC
  // delays for capacitor-backed nets.
  // Clock the flip-flops on settled levels. Split out so the pass that follows
  // can propagate a new output in the same step it changed.
  private clockFlops(next: Map<string, Level>) {
    for (const m of this.models) {
      if (m.libId !== "Logic_Flipflop:SN74LVC1G74") continue;
      const st = this.flops.get(m.ref)!;
      const rd = (pin: string): Level => {
        const net = m.pins[pin];
        if (!net) return "z";
        if (RAIL_HIGH.test(net)) return 1;
        if (RAIL_GND.test(net)) return 0;
        if (this.capNets.has(net)) return this.held.get(net) ?? "z";
        return next.get(net) ?? "z";
      };
      const clr = rd("6");
      const pre = rd("7");
      const clk = rd("1");
      const d = rd("2");
      if (clr === 0) st.q = 0;
      else if (pre === 0) st.q = 1;
      else if (clk === 1 && st.lastClk !== 1) st.q = d === 1 ? 1 : 0;
      st.lastClk = clk;
    }
  }

  // Capacitor-backed nets: a transistor discharging one is fast, a resistor
  // charging one is not, so only the weak path waits for the RC.
  private applyCapacitors(next: Map<string, Level>, strongNets: Set<string>) {
    for (const [net, target] of next) {
      if (!this.capNets.has(net)) continue;
      const current = this.held.get(net) ?? "z";
      if (target === current) {
        this.pending.delete(net);
        continue;
      }
      // A transistor discharging a capacitor is fast; a resistor charging one
      // is not. Only the weak path waits for the RC.
      if (strongNets.has(net)) {
        this.held.set(net, target);
        this.pending.delete(net);
        continue;
      }
      const p = this.pending.get(net);
      if (!p || p.level !== target) this.pending.set(net, { level: target, at: this.t + this.delayFor(net) });
    }

  }

  private settle() {
    let prev = new Map(this.levels);
    let next = prev;
    let strongNets = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const pass = this.resolvePass(prev);
      next = pass.levels;
      strongNets = pass.strongNets;
      let same = true;
      for (const [k, v] of next) if (prev.get(k) !== v) { same = false; break; }
      prev = next;
      if (same) break;
    }

    this.applyCapacitors(next, strongNets);
    this.clockFlops(next);
    for (let i = 0; i < 6; i++) {
      const pass = this.resolvePass(prev);
      next = pass.levels;
      strongNets = pass.strongNets;
      let same = true;
      for (const [k, v] of next) if (prev.get(k) !== v) { same = false; break; }
      prev = next;
      if (same) break;
    }

    for (const net of this.capNets) {
      const h = this.held.get(net);
      if (h !== undefined) next.set(net, h);
    }
    this.levels = next;
  }

  step(ms = 1) {
    // Settle first so a control the user just changed schedules its RC now,
    // rather than a step later: otherwise every input looks one step slow.
    this.settle();
    this.t += ms;
    for (const [net, p] of [...this.pending]) {
      if (this.t >= p.at) {
        this.held.set(net, p.level);
        this.pending.delete(net);
      }
    }
    this.settle();
  }

  snapshot(watch: string[]): SimState {
    const levels: Record<string, Level> = {};
    for (const w of watch) levels[w] = this.level(w);
    return { t: this.t, levels, inputs: this.inputs, notes: this.notes };
  }
}

// Nets worth watching on a power distribution board with an e-stop chain.
export function suggestedWatches(nl: Netlist): string[] {
  const want = [/ESTOP_RUN/i, /ESTOP_TRIP/i, /CLR_N/i, /WDT_DET/i, /WDT_FAIL/i, /^ESTOP\d+$/i, /_EN$/i, /_OUT$/i];
  return nl.nets
    .map((n) => n.name)
    .filter((name) => want.some((w) => w.test(name)))
    .slice(0, 14);
}
