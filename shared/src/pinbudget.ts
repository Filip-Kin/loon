// #region Pin budget
// Works out which MCU pins a design has already spent and what is left. This
// is what turns "do I have enough channels for current monitoring?" into an
// answer with numbers in it.
//
// A pin counts as used when a wire endpoint, a junction or a label sits on its
// world position - the same coincidence rule the wiring tool uses.

import type { Schematic, Point } from "./schematic";
import { pinWorld } from "./geometry";
import { mcuProfileFor, type McuPin } from "./mcu";

const TOL = 0.6; // mm; pins live on a 2.54 grid so this is generous but safe

function near(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) <= TOL && Math.abs(a.y - b.y) <= TOL;
}

export interface UsedPin {
  pin: McuPin;
  pinNumber: string;
  net?: string;
}

export interface McuBudget {
  ref: string;
  libId: string;
  name: string;
  usedPins: UsedPin[];
  freeGpio: number[];
  freeAdc1: number[];
  freeAdc2: number[];
  // Strapping pins that the design has wired to something.
  strappingInUse: { gpio: number; caution: string }[];
  rules: string[];
}

export function pinBudget(schem: Schematic): McuBudget[] {
  const out: McuBudget[] = [];
  for (const inst of schem.symbols) {
    const profile = mcuProfileFor(inst.libId);
    if (!profile) continue;
    const def = schem.libSymbols[inst.libId];
    if (!def) continue;

    const anchors: { at: Point; net?: string }[] = [];
    for (const w of schem.wires) {
      if (w.pts.length) {
        anchors.push({ at: w.pts[0] });
        anchors.push({ at: w.pts[w.pts.length - 1] });
      }
    }
    for (const j of schem.junctions) anchors.push({ at: j.at });
    for (const l of schem.labels) anchors.push({ at: l.at, net: l.text });

    const used: UsedPin[] = [];
    for (const mp of profile.pins) {
      const sp = def.pins.find((p) => p.number === mp.number);
      if (!sp) continue;
      const world = pinWorld(sp, { at: inst.at, rotation: inst.rotation, mirror: inst.mirror });
      const hit = anchors.find((a) => near(a.at, world));
      if (hit) used.push({ pin: mp, pinNumber: mp.number, net: hit.net });
    }

    const usedGpio = new Set(used.map((u) => u.pin.gpio).filter((g): g is number => g !== undefined));
    const free = profile.pins.filter((p) => p.gpio !== undefined && !usedGpio.has(p.gpio) && !p.reserved);

    out.push({
      ref: inst.properties.Reference ?? "?",
      libId: inst.libId,
      name: profile.name,
      usedPins: used,
      freeGpio: free.map((p) => p.gpio!).sort((a, b) => a - b),
      freeAdc1: free.filter((p) => p.adc?.unit === 1).map((p) => p.gpio!).sort((a, b) => a - b),
      freeAdc2: free.filter((p) => p.adc?.unit === 2).map((p) => p.gpio!).sort((a, b) => a - b),
      strappingInUse: used
        .filter((u) => u.pin.strapping && u.pin.gpio !== undefined)
        .map((u) => ({ gpio: u.pin.gpio!, caution: u.pin.strapping! })),
      rules: profile.rules,
    });
  }
  return out;
}

export function formatBudget(b: McuBudget): string {
  const lines = [
    `${b.ref} (${b.name}): ${b.usedPins.length} pins wired, ${b.freeGpio.length} GPIO free.`,
    `  free GPIO: ${b.freeGpio.join(", ") || "none"}`,
    `  free ADC1 channels (Wi-Fi safe): ${b.freeAdc1.length ? b.freeAdc1.map((g) => `GPIO${g}`).join(", ") : "none"}`,
    `  free ADC2 channels (unusable with Wi-Fi on): ${b.freeAdc2.length ? b.freeAdc2.map((g) => `GPIO${g}`).join(", ") : "none"}`,
  ];
  for (const s of b.strappingInUse) lines.push(`  caution: GPIO${s.gpio} is a strapping pin (${s.caution})`);
  for (const r of b.rules) lines.push(`  rule: ${r}`);
  return lines.join("\n");
}
