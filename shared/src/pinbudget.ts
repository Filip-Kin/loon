// #region Pin budget
// Works out which MCU pins a design has already spent and what is left. This
// is what turns "do I have enough channels for current monitoring?" into an
// answer with numbers in it.
//
// A pin counts as used when the netlist puts it on a net with something else on
// it, so this agrees with the schematic's real connectivity rather than with
// whatever happens to sit near the pin.

import type { Schematic } from "./schematic";
import { buildNetlist, type Netlist, type DefResolver } from "./netlist";
import { mcuProfileFor, type McuPin } from "./mcu";

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

export function pinBudget(schem: Schematic, resolve?: DefResolver, netlist?: Netlist): McuBudget[] {
  const out: McuBudget[] = [];
  const nl = netlist ?? buildNetlist(schem, resolve);
  // A net with a single pin is a stub, not a connection.
  const shared = new Set(nl.nets.filter((n) => n.pins.length > 1 || n.isPower).map((n) => n.name));
  for (const inst of schem.symbols) {
    const profile = mcuProfileFor(inst.libId);
    if (!profile) continue;
    const ref = inst.properties.Reference ?? "?";

    const used: UsedPin[] = [];
    for (const mp of profile.pins) {
      const net = nl.netOfPin[`${ref}:${mp.number}`];
      if (net && shared.has(net)) used.push({ pin: mp, pinNumber: mp.number, net });
    }

    const usedGpio = new Set(used.map((u) => u.pin.gpio).filter((g): g is number => g !== undefined));
    const free = profile.pins.filter((p) => p.gpio !== undefined && !usedGpio.has(p.gpio) && !p.reserved);

    out.push({
      ref,
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
