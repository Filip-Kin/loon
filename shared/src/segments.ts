// #region Segments (the block diagram)
// What a block diagram is for: seeing that the 24 V input feeds two bucks, that
// the MCU talks to the PoE controller and the LED string, and that the laptop
// port hangs off the 15.6 V rail - without reading a single resistor value.
//
// The previous block view drew one node per part at the part's own position on
// the sheet, which is the schematic with the symbols rubbed out. This groups
// parts into functional segments instead, and lays them out by signal flow
// rather than by where they happen to sit.
//
// Grouping, in order:
//   1. A module instantiation is a segment. Provenance is stamped on the
//      symbols and is the designer's own answer.
//   2. Anything else is grouped around an anchor - an IC, a connector, a
//      module, anything with a real pinout. Passives join the anchor they are
//      nearest in the netlist, so a buck's inductor, its feedback divider and
//      its input caps land on the buck.
//   3. A segment whose every signal goes to one other segment is absorbed into
//      it. That is what a gate driver, a level shifter or a sense amplifier is:
//      part of the thing it serves, not a peer of it.
//
// Power rails are not drawn as links. GND touches everything, and an edge from
// everything to everything is the picture with no information in it - each
// segment lists the rails it sits on instead.

import type { Schematic, SymbolInstance } from "./schematic";
import { buildNetlist, type Netlist, type DefResolver } from "./netlist";
import { MODULES } from "./modules";

export type SegmentKind =
  | "input"        // where power or a signal enters the board
  | "regulator"    // buck, boost, LDO, charger
  | "protection"   // eFuse, ideal diode, TVS, current limit
  | "mcu"
  | "driver"       // FET driver, LED driver, motor driver, level shifter
  | "interface"    // connector, USB, Ethernet, radio
  | "sense"        // current sense, ADC front end, temperature
  | "indicator"    // LEDs, buzzers
  | "other";

export interface SegmentPort {
  net: string;
  isPower: boolean;
  pins: number;
}

export interface Segment {
  id: string;
  kind: SegmentKind;
  // What it is, in two or three words: "LMR33630 buck", "STM32F072 MCU".
  name: string;
  // The part that names the segment.
  anchorRef: string;
  refs: string[];
  memberUuids: string[];
  partCount: number;
  // Nets that leave the segment, power ones flagged.
  ports: SegmentPort[];
  // Supply rails the segment sits on, which are listed rather than drawn.
  rails: string[];
  // Layout, filled by layoutSegments: column is signal-flow depth.
  col: number;
  row: number;
}

export interface SegmentLink {
  from: string;
  to: string;
  // Every signal net the two share, most connected first.
  nets: string[];
}

export interface SegmentGraph {
  segments: Segment[];
  links: SegmentLink[];
  cols: number;
}

// #region classification
// Matched against the part's value, its library id and its reference. First
// match wins, so the order is the specificity order.
const KINDS: { kind: SegmentKind; re: RegExp }[] = [
  { kind: "mcu", re: /\b(stm32|esp32|atmega|rp2040|samd|nrf5|attiny|mcu|pic\d)/i },
  { kind: "regulator", re: /\b(lmr\d|lm2\d{3}|tps6|tps5|mp\d{4}|ap2112|ams1117|lm1117|ld1117|buck|boost|ldo|regulator|lm3478|charger|bq2)/i },
  { kind: "protection", re: /\b(tps26|lm74700|ideal.?diode|efuse|e-?fuse|tvs|smaj|pesd|usblc|fuse|polyfuse|crowbar|ltc4|ucc27)/i },
  { kind: "driver", re: /\b(driver|ahct|lvc\d|74hc|level.?shift|gate|ws2812|tc4\d{3}|drv8|mosfet.?driver)/i },
  { kind: "sense", re: /\b(ina\d|acs7|shunt|sense|ntc|thermist|tmp\d|lm35|adc|lmv3|tlv7|comparator|opamp|op.?amp)/i },
  { kind: "interface", re: /\b(usb|rj45|ethernet|magjack|conn|header|terminal|jack|barrel|xh\d|can|rs485|rs232|uart|swd|jtag|radio|lora|antenna)/i },
  { kind: "indicator", re: /\b(led|buzzer|beeper|display|oled|lcd)/i },
];

// A rail that feeds the board, as opposed to one the board makes. Deliberately
// not "+12V": a fan connector sits on +12V and is not an input.
const FEED_NET = /^(VIN|VBUS|V_?IN|DC_IN|PACK|BAT)/i;

function classify(inst: SymbolInstance, netNames: string[]): SegmentKind {
  const ref = inst.properties.Reference ?? "";
  // Where the board is fed is checked first: a barrel jack and a USB-C
  // receptacle are both connectors, and both are the input when power is on
  // them. Otherwise "usb" would win and the diagram would have no source.
  if (/^(J|P|BT|TB)\d/.test(ref) && netNames.some((n) => FEED_NET.test(n))) return "input";
  const hay = `${inst.properties.Value ?? ""} ${inst.libId} ${ref} ${inst.properties.Description ?? ""}`;
  for (const k of KINDS) if (k.re.test(hay)) return k.kind;
  if (/^(J|P|BT|TB)\d/.test(ref)) return "interface";
  return "other";
}

// Two or three words, not a part number soup.
const KIND_WORD: Record<SegmentKind, string> = {
  input: "input", regulator: "regulator", protection: "protection", mcu: "MCU",
  driver: "driver", interface: "interface", sense: "sense", indicator: "indicator", other: "",
};

function nameOf(inst: SymbolInstance, kind: SegmentKind, moduleId?: string): string {
  if (moduleId) return MODULES[moduleId]?.name ?? moduleId.replace(/_/g, " ");
  const value = (inst.properties.Value ?? "").trim();
  // A Value is often a whole order line - "Laptop out 15.6V, PJ-002BH 5.5x2.5
  // (v1 jack)". The part before the first comma or bracket is the name; the
  // rest belongs on the part, not on a block diagram.
  const short = value.split(/[,(]/)[0].trim();
  const part = short || inst.libId.split(":")[1] || inst.properties.Reference || "part";
  // "LMR33630 12V" already says what it is; do not append "regulator" twice.
  const word = KIND_WORD[kind];
  if (!word || new RegExp(word, "i").test(part)) return part;
  return `${part} ${word}`;
}

// #region grouping
export function buildSegmentGraph(schem: Schematic, resolve?: DefResolver, netlist?: Netlist): SegmentGraph {
  const nl = netlist ?? buildNetlist(schem, resolve);
  const defOf = (libId: string) => resolve?.(libId) ?? schem.libSymbols[libId];
  const byRef = new Map<string, SymbolInstance>();
  for (const s of schem.symbols) {
    const ref = s.properties.Reference;
    if (ref) byRef.set(ref, s);
  }
  const netsOfRef = new Map<string, string[]>();
  for (const net of nl.nets) {
    for (const p of net.pins) {
      const arr = netsOfRef.get(p.ref) ?? [];
      if (!arr.includes(net.name)) arr.push(net.name);
      netsOfRef.set(p.ref, arr);
    }
  }

  // A power symbol is a rail marker, not a part.
  const isRailSymbol = (s: SymbolInstance) => s.libId.startsWith("power:") || (s.properties.Reference ?? "").startsWith("#PWR");
  const parts = schem.symbols.filter((s) => !isRailSymbol(s) && s.properties.Reference);

  // Seed: a declared module instance is a segment, whole.
  const ownerOf = new Map<string, string>(); // ref -> segment id
  const seeds = new Map<string, { anchor: SymbolInstance; moduleId?: string; refs: string[] }>();
  const byBlock = new Map<string, SymbolInstance[]>();
  for (const s of parts) {
    const id = s.properties.LoonBlock;
    if (!id) continue;
    byBlock.set(id, [...(byBlock.get(id) ?? []), s]);
  }
  for (const [id, members] of byBlock) {
    const anchor = members.slice().sort((a, b) => (defOf(b.libId)?.pins.length ?? 0) - (defOf(a.libId)?.pins.length ?? 0))[0];
    seeds.set(id, { anchor, moduleId: members[0].properties.LoonModule, refs: [] });
    for (const m of members) ownerOf.set(m.properties.Reference!, id);
  }

  // Anchors: anything with a real pinout, plus every connector. A two-pin part
  // is never an anchor - it is what hangs off one.
  const anchors: SymbolInstance[] = [];
  for (const s of parts) {
    if (ownerOf.has(s.properties.Reference!)) continue;
    const pins = defOf(s.libId)?.pins.length ?? 0;
    const ref = s.properties.Reference!;
    if (pins >= 4 || /^(U|J|P|RJ|M|SW|BT|TB)\d/.test(ref)) {
      anchors.push(s);
      const id = `seg:${ref}`;
      seeds.set(id, { anchor: s, refs: [] });
      ownerOf.set(ref, id);
    }
  }

  // #region satellites
  // Every remaining part joins the anchor it is fewest signal hops from. Power
  // nets are not hops: GND would put the whole board one hop from everything.
  const neighbours = new Map<string, Set<string>>();
  for (const net of nl.nets) {
    if (net.isPower) continue;
    // A net on half the board is a bus, not a local connection.
    if (net.pins.length > 8) continue;
    const refs = [...new Set(net.pins.map((p) => p.ref))];
    for (const a of refs) {
      const set = neighbours.get(a) ?? new Set<string>();
      for (const b of refs) if (b !== a) set.add(b);
      neighbours.set(a, set);
    }
  }

  const queue: string[] = [];
  for (const ref of ownerOf.keys()) queue.push(ref);
  for (let i = 0; i < queue.length; i++) {
    const ref = queue[i];
    const owner = ownerOf.get(ref)!;
    for (const n of neighbours.get(ref) ?? []) {
      if (ownerOf.has(n)) continue;
      if (!byRef.has(n)) continue;
      ownerOf.set(n, owner);
      queue.push(n);
    }
  }

  // Anything the netlist never reached (a lone mounting hole, a test point)
  // goes to the nearest anchor on the sheet, because that is the only signal
  // left about where it belongs.
  for (const s of parts) {
    const ref = s.properties.Reference!;
    if (ownerOf.has(ref)) continue;
    let best: string | null = null;
    let bestD = Infinity;
    for (const [id, seed] of seeds) {
      const d = Math.hypot(seed.anchor.at.x - s.at.x, seed.anchor.at.y - s.at.y);
      if (d < bestD) { bestD = d; best = id; }
    }
    if (best) ownerOf.set(ref, best);
  }

  for (const [ref, id] of ownerOf) {
    const seed = seeds.get(id);
    if (seed) seed.refs.push(ref);
  }

  // #region build
  let segments: Segment[] = [];
  for (const [id, seed] of seeds) {
    if (seed.refs.length === 0) continue;
    const kind = classify(seed.anchor, netsOfRef.get(seed.anchor.properties.Reference!) ?? []);
    segments.push({
      id,
      kind,
      name: nameOf(seed.anchor, kind, seed.moduleId),
      anchorRef: seed.anchor.properties.Reference!,
      refs: seed.refs,
      memberUuids: seed.refs.map((r) => byRef.get(r)?.uuid).filter(Boolean) as string[],
      partCount: seed.refs.length,
      ports: [],
      rails: [],
      col: 0,
      row: 0,
    });
  }

  fillPorts(segments, nl, ownerOf);
  segments = absorbPrivate(segments, nl, ownerOf);
  segments = mergeChained(segments, nl, ownerOf);
  fillPorts(segments, nl, ownerOf);

  const links = linkSegments(segments, nl, ownerOf);
  const cols = layoutSegments(segments, links);
  return { segments, links, cols };
}

function fillPorts(segments: Segment[], nl: Netlist, ownerOf: Map<string, string>) {
  const byId = new Map(segments.map((s) => [s.id, s]));
  for (const s of segments) { s.ports = []; s.rails = []; }
  for (const net of nl.nets) {
    const counts = new Map<string, number>();
    for (const p of net.pins) {
      const id = ownerOf.get(p.ref);
      if (!id) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const [id, pins] of counts) {
      const seg = byId.get(id);
      if (!seg) continue;
      if (net.isPower) {
        if (!seg.rails.includes(net.name)) seg.rails.push(net.name);
        continue;
      }
      // A net that stays inside one segment is internal detail: strip it.
      if (counts.size < 2) continue;
      seg.ports.push({ net: net.name, isPower: false, pins });
    }
  }
  for (const s of segments) {
    s.rails.sort();
    s.ports.sort((a, b) => b.pins - a.pins || a.net.localeCompare(b.net));
  }
}

// A segment whose every signal goes to exactly one other segment is part of
// that segment. A gate driver, a shunt amplifier or a level shifter is not a
// peer of the thing it drives.
function absorbPrivate(segments: Segment[], nl: Netlist, ownerOf: Map<string, string>): Segment[] {
  const byId = new Map(segments.map((s) => [s.id, s]));
  const partnersOf = new Map<string, Set<string>>();
  for (const net of nl.nets) {
    if (net.isPower) continue;
    const ids = new Set<string>();
    for (const p of net.pins) { const id = ownerOf.get(p.ref); if (id) ids.add(id); }
    if (ids.size < 2) continue;
    for (const a of ids) {
      const set = partnersOf.get(a) ?? new Set<string>();
      for (const b of ids) if (b !== a) set.add(b);
      partnersOf.set(a, set);
    }
  }
  const absorbedInto = new Map<string, string>();
  const resolveTarget = (id: string): string => {
    let cur = id;
    const seen = new Set<string>();
    while (absorbedInto.has(cur) && !seen.has(cur)) { seen.add(cur); cur = absorbedInto.get(cur)!; }
    return cur;
  };
  // Smallest first: a two-part helper is absorbed before it can absorb.
  for (const s of [...segments].sort((a, b) => a.partCount - b.partCount)) {
    if (s.kind === "mcu" || s.kind === "input" || s.kind === "interface") continue;
    const partners = partnersOf.get(s.id);
    if (!partners || partners.size !== 1) continue;
    const target = resolveTarget([...partners][0]);
    if (target === s.id) continue;
    const into = byId.get(target);
    if (!into || into.partCount + s.partCount > 40) continue;
    into.refs.push(...s.refs);
    into.memberUuids.push(...s.memberUuids);
    into.partCount += s.partCount;
    for (const r of s.refs) ownerOf.set(r, target);
    absorbedInto.set(s.id, target);
  }
  return segments.filter((s) => !absorbedInto.has(s.id));
}

// Four cells in series, or four identical channels next to each other, are one
// thing on a block diagram. Segments with the same name that are wired to each
// other collapse into one, counted.
function mergeChained(segments: Segment[], nl: Netlist, ownerOf: Map<string, string>): Segment[] {
  const linked = new Set<string>();
  for (const net of nl.nets) {
    if (net.isPower) continue;
    const ids = [...new Set(net.pins.map((p) => ownerOf.get(p.ref)).filter((x): x is string => !!x))];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) linked.add([ids[i], ids[j]].sort().join("|"));
  }
  // Connected components over {same name} and {wired to each other}, so a
  // chain of four merges whole rather than leaving the far end behind.
  const parent = new Map<string, string>(segments.map((s) => [s.id, s.id]));
  const find = (a: string): string => { while (parent.get(a) !== a) a = parent.get(a)!; return a; };
  const byName = new Map<string, Segment[]>();
  for (const s of segments) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
  for (const group of byName.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (!linked.has([group[i].id, group[j].id].sort().join("|"))) continue;
        const ra = find(group[i].id), rb = find(group[j].id);
        if (ra !== rb) parent.set(ra, rb);
      }
    }
  }
  const heads = new Map<string, Segment>();
  const counts = new Map<string, number>();
  const gone = new Set<string>();
  for (const s of segments) {
    const root = find(s.id);
    const head = heads.get(root);
    if (!head) { heads.set(root, s); counts.set(root, 1); continue; }
    head.refs.push(...s.refs);
    head.memberUuids.push(...s.memberUuids);
    head.partCount += s.partCount;
    for (const r of s.refs) ownerOf.set(r, head.id);
    gone.add(s.id);
    counts.set(root, counts.get(root)! + 1);
  }
  for (const [root, n] of counts) if (n > 1) heads.get(root)!.name = `${heads.get(root)!.name} x${n}`;
  return segments.filter((s) => !gone.has(s.id));
}

function linkSegments(segments: Segment[], nl: Netlist, ownerOf: Map<string, string>): SegmentLink[] {
  const ids = new Set(segments.map((s) => s.id));
  const acc = new Map<string, SegmentLink>();
  for (const net of nl.nets) {
    if (net.isPower) continue;
    const touching = [...new Set(net.pins.map((p) => ownerOf.get(p.ref)).filter((x): x is string => !!x && ids.has(x)))];
    if (touching.length < 2) continue;
    // A net on more than a handful of segments is a bus; drawing it as a full
    // mesh is what made the old view a hairball. One edge per adjacent pair.
    for (let i = 0; i < touching.length; i++) {
      for (let j = i + 1; j < touching.length; j++) {
        const [a, b] = [touching[i], touching[j]].sort();
        const key = `${a}|${b}`;
        const link = acc.get(key) ?? { from: a, to: b, nets: [] };
        if (!link.nets.includes(net.name)) link.nets.push(net.name);
        acc.set(key, link);
      }
    }
  }
  return [...acc.values()].sort((a, b) => b.nets.length - a.nets.length);
}

// #region layout
// Columns are signal-flow depth from where the board is fed, so the diagram
// reads left to right the way the current does.
function layoutSegments(segments: Segment[], links: SegmentLink[]): number {
  const adj = new Map<string, string[]>();
  for (const l of links) {
    adj.set(l.from, [...(adj.get(l.from) ?? []), l.to]);
    adj.set(l.to, [...(adj.get(l.to) ?? []), l.from]);
  }
  const byId = new Map(segments.map((s) => [s.id, s]));
  const depth = new Map<string, number>();
  const sources = segments.filter((s) => s.kind === "input");
  const start = sources.length
    ? sources
    // No named input: start from whatever the most things are wired to, which
    // on a board with no power connector is the MCU.
    : segments.slice().sort((a, b) => (adj.get(b.id)?.length ?? 0) - (adj.get(a.id)?.length ?? 0)).slice(0, 1);
  const queue = start.map((s) => s.id);
  for (const id of queue) depth.set(id, 0);
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    const d = depth.get(cur)!;
    for (const n of adj.get(cur) ?? []) {
      if (depth.has(n)) continue;
      depth.set(n, d + 1);
      queue.push(n);
    }
  }
  // Anything the links never reached goes in a column of its own on the right.
  let maxDepth = 0;
  for (const d of depth.values()) maxDepth = Math.max(maxDepth, d);
  for (const s of segments) if (!depth.has(s.id)) depth.set(s.id, maxDepth + 1);

  const rows = new Map<number, number>();
  const ORDER: SegmentKind[] = ["input", "protection", "regulator", "mcu", "driver", "sense", "interface", "indicator", "other"];
  for (const s of [...segments].sort((a, b) => (depth.get(a.id)! - depth.get(b.id)!) || (ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind)) || a.name.localeCompare(b.name))) {
    const col = depth.get(s.id)!;
    const row = rows.get(col) ?? 0;
    s.col = col;
    s.row = row;
    rows.set(col, row + 1);
    void byId;
  }
  let cols = 0;
  for (const s of segments) cols = Math.max(cols, s.col + 1);
  return cols;
}
