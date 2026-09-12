// #region ERC
// Electrical rule checks over the netlist. The point is not to be KiCad's ERC;
// it is to catch the handful of mistakes that actually sink a board, and to
// hand them back to the assistant so it fixes its own work before the user
// has to notice.

import type { Schematic, LibSymbol, PinType } from "./schematic";
import { buildNetlist, type Netlist, type DefResolver, type Net } from "./netlist";

export type ErcSeverity = "error" | "warning";

export interface ErcIssue {
  severity: ErcSeverity;
  rule: string;
  message: string;
  refs: string[];
  net?: string;
}

const DRIVER_TYPES: PinType[] = ["output", "power_out", "bidirectional"];
const NEEDS_DRIVER: PinType[] = ["input", "power_in"];

// A pin that legitimately sits alone: a no-connect, or a mechanical pad.
const IGNORED_TYPES: PinType[] = ["no_connect"];

export function runErc(schem: Schematic, resolve?: DefResolver, netlist?: Netlist): ErcIssue[] {
  const nl = netlist ?? buildNetlist(schem, resolve);
  const issues: ErcIssue[] = [];
  const def = (libId: string) => resolve?.(libId) ?? schem.libSymbols[libId];

  // 1. Pins connected to nothing. Spare GPIO on a big part is not a mistake,
  // so those are rolled into one line per part instead of forty warnings that
  // bury the real ones.
  const connected = new Set(Object.keys(nl.netOfPin));
  const singlePinNets = new Set(nl.nets.filter((n) => n.pins.length < 2).map((n) => n.name));
  const spareIo = new Map<string, string[]>();
  for (const inst of schem.symbols) {
    if (inst.libId.startsWith("power:")) continue;
    const d: LibSymbol | undefined = def(inst.libId);
    if (!d) continue;
    const ref = inst.properties.Reference ?? "?";
    const bigPart = d.pins.length > 8;
    for (const p of d.pins) {
      if (IGNORED_TYPES.includes(p.type)) continue;
      const netName = nl.netOfPin[`${ref}:${p.number}`];
      const isAlone = !connected.has(`${ref}:${p.number}`) || (netName !== undefined && singlePinNets.has(netName));
      if (!isAlone) continue;
      if (bigPart && p.type === "bidirectional") {
        const list = spareIo.get(ref) ?? [];
        list.push(p.name);
        spareIo.set(ref, list);
        continue;
      }
      issues.push({
        severity: p.type === "power_in" ? "error" : "warning",
        rule: "unconnected-pin",
        message: `${ref} pin ${p.number} (${p.name}) is not connected to anything`,
        refs: [ref],
        net: netName,
      });
    }
  }
  for (const [ref, names] of spareIo) {
    issues.push({
      severity: "warning",
      rule: "spare-io",
      message: `${ref} has ${names.length} unused IO: ${names.slice(0, 12).join(", ")}${names.length > 12 ? ", ..." : ""}`,
      refs: [ref],
    });
  }

  // 2. Nets that nothing drives.
  for (const net of nl.nets) {
    if (net.isPower || net.pins.length < 2) continue;
    const hasDriver = net.pins.some((p) => DRIVER_TYPES.includes(p.type) || p.type === "passive");
    const wantsDriver = net.pins.some((p) => NEEDS_DRIVER.includes(p.type));
    if (wantsDriver && !hasDriver) {
      issues.push({
        severity: "warning",
        rule: "no-driver",
        message: `Net ${net.name} feeds an input but nothing drives it`,
        refs: net.pins.map((p) => p.ref),
        net: net.name,
      });
    }
  }

  // 3. Two hard drivers fighting on one net. Duplicate pins of one component
  // are not a fight: a USB-C receptacle has two VBUS pins by design.
  for (const net of nl.nets) {
    const outputs = net.pins.filter((p) => p.type === "output" || p.type === "power_out");
    const distinctParts = new Set(outputs.map((o) => o.ref));
    if (outputs.length > 1 && distinctParts.size > 1) {
      issues.push({
        severity: "error",
        rule: "multiple-drivers",
        message: `Net ${net.name} is driven by ${outputs.map((o) => `${o.ref}.${o.pin}`).join(" and ")}`,
        refs: outputs.map((o) => o.ref),
        net: net.name,
      });
    }
  }

  // 4. A label that names nothing: usually a typo against another net name.
  for (const net of nl.nets) {
    if (net.pins.length === 0 && net.labels.length > 0) {
      issues.push({
        severity: "warning",
        rule: "orphan-label",
        message: `Label "${net.labels[0]}" is not attached to any pin`,
        refs: [],
        net: net.name,
      });
    }
  }

  // 4b. An implausibly crowded net. A rail legitimately has many pins; a rail
  // with most of the board on it is a wire that crossed pins on its way across
  // the sheet, which is the single most destructive mistake here.
  const partCount = schem.symbols.filter((s) => !s.libId.startsWith("power:")).length;
  for (const net of nl.nets) {
    const share = partCount > 0 ? net.pins.length / partCount : 0;
    if (net.pins.length > 40 && share > 1.5) {
      issues.push({
        severity: "error",
        rule: "net-swallowed-the-board",
        message: `Net ${net.name} has ${net.pins.length} pins across ${partCount} parts. That is a wire passing over pins rather than a real connection: delete the long wires on this net and join those pins by label instead.`,
        refs: [],
        net: net.name,
      });
    }
  }

  // 5. Duplicate references: two parts answering to the same name.
  const seen = new Map<string, number>();
  for (const inst of schem.symbols) {
    const ref = inst.properties.Reference ?? "?";
    if (ref.startsWith("#")) continue;
    seen.set(ref, (seen.get(ref) ?? 0) + 1);
  }
  for (const [ref, n] of seen) {
    if (n > 1) {
      issues.push({ severity: "error", rule: "duplicate-reference", message: `${n} parts share the reference ${ref}`, refs: [ref] });
    }
  }

  const rank: Record<ErcSeverity, number> = { error: 0, warning: 1 };
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity] || a.rule.localeCompare(b.rule));
}

export function formatErc(issues: ErcIssue[], limit = 25): string {
  if (issues.length === 0) return "ERC clean.";
  const errors = issues.filter((i) => i.severity === "error").length;
  const head = `${errors} error(s), ${issues.length - errors} warning(s).`;
  const lines = issues.slice(0, limit).map((i) => `  [${i.severity}] ${i.rule}: ${i.message}`);
  if (issues.length > limit) lines.push(`  ... and ${issues.length - limit} more`);
  return [head, ...lines].join("\n");
}

export function summarizeNets(nl: Netlist): { total: number; power: number; singlePin: number } {
  return {
    total: nl.nets.length,
    power: nl.nets.filter((n) => n.isPower).length,
    singlePin: nl.nets.filter((n) => n.pins.length === 1).length,
  };
}

export type { Net };
