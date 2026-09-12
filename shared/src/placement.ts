// #region Placement
// A grid of footprints is not a layout. A power distribution board has a shape
// dictated by how it is wired into a robot: lugs at one end, screw terminals
// along the outside edges where wire can reach them, each channel's breaker and
// switch inline behind its own terminal, converters in the middle, and the
// logic kept away from the switching nodes.
//
// Placement is derived from each part's role and from the netlist, so a channel
// stays together because it is actually connected, not because of its name.

import type { Point } from "./schematic";
import type { Footprint } from "./footprint";
import type { Board, PlacedFootprint } from "./board";
import type { Netlist } from "./netlist";

export type Role =
  | "lug"
  | "terminal"
  | "fuse"
  | "switch"
  | "converter"
  | "mcu"
  | "rf"
  | "logic"
  | "usb"
  | "passive"
  | "other";

const EDGE = 9; // mm from the board edge to a part's centre line
const GAP = 3; // mm between neighbours
// KiCad checks courtyards, which stand off from the pads. Placing to the pad
// bounding box alone produces a board full of courtyard overlaps.
const COURTYARD = 1.2; // mm of extra room around every part

export function roleOf(f: PlacedFootprint, fp?: Footprint): Role {
  const v = `${f.value} ${f.libId}`.toLowerCase();
  const ref = f.ref.toUpperCase();
  if (/lug|awg|stud|busbar/.test(v) && /6awg|4awg|lug/.test(v)) return "lug";
  if (ref.startsWith("F") || /fuse|ato|breaker/.test(v)) return "fuse";
  if (/tps27s|high.?side|power_switch/.test(v)) return "switch";
  if (/usb/.test(v)) return "usb";
  if (/esp32|rp2040|stm32|atmega/.test(v)) return "mcu";
  if (/nrf24|rfm|lora|radio|antenna/.test(v)) return "rf";
  if (/regulator|tps54|lm5175|ap2112|ldo|buck/.test(v)) return "converter";
  if (/logic_|74lvc|flipflop|latch/.test(v)) return "logic";
  if (ref.startsWith("J") || /conn_|terminal|screw|receptacle|rj45/.test(v)) return "terminal";
  if (/^[RCLDQY]/.test(ref)) return "passive";
  void fp;
  return "other";
}

function sizeOf(fp?: Footprint, rotation = 0): { w: number; h: number } {
  if (!fp) return { w: 5, h: 5 };
  // The courtyard is what DRC checks; fall back to the pads when a footprint
  // does not declare one.
  const box = fp.courtyard ?? fp.bbox;
  const w = Math.max(2, box.max.x - box.min.x);
  const h = Math.max(2, box.max.y - box.min.y);
  // A part turned on its side is as tall as it is wide. Measuring it unrotated
  // is how a row ends up overlapping the row below it.
  const turned = Math.abs(((rotation % 180) + 180) % 180 - 90) < 1;
  return turned ? { w: h, h: w } : { w, h };
}

// Parts that share a net, ranked by how much they share. Used to keep a
// channel's breaker with its terminal and a decoupling cap with its chip.
function neighbours(ref: string, nl: Netlist): Map<string, number> {
  const out = new Map<string, number>();
  for (const net of nl.nets) {
    if (!net.pins.some((p) => p.ref === ref)) continue;
    // A rail touches everything, so it says nothing about who belongs together.
    if (net.isPower || net.pins.length > 12) continue;
    for (const p of net.pins) {
      if (p.ref === ref) continue;
      out.set(p.ref, (out.get(p.ref) ?? 0) + 1);
    }
  }
  return out;
}

export interface PlacementResult {
  board: Board;
  notes: string[];
}

export function autoPlace(board: Board, footprints: Record<string, Footprint>, nl: Netlist): PlacementResult {
  const notes: string[] = [];
  const byRef = new Map(board.footprints.map((f) => [f.ref, f]));
  const fpOf = (f: PlacedFootprint) => footprints[f.libId];
  const roles = new Map<string, Role>();
  for (const f of board.footprints) roles.set(f.ref, roleOf(f, fpOf(f)));

  const of = (role: Role) => board.footprints.filter((f) => roles.get(f.ref) === role);
  const lugs = of("lug");
  const fuses = of("fuse");
  const switches = of("switch");
  const converters = of("converter");
  const terminals = of("terminal").filter((t) => !lugs.includes(t));

  // A channel is a terminal with the breaker and switch that feed it. Grouping
  // by connectivity rather than by reference number keeps a renamed channel
  // together.
  interface Channel { terminal: PlacedFootprint; fuse?: PlacedFootprint; sw?: PlacedFootprint }
  const channels: Channel[] = [];
  const usedFuse = new Set<string>();
  const usedSw = new Set<string>();
  for (const t of terminals) {
    // A terminal is not wired to its breaker directly - the current goes
    // breaker, switch, terminal - so following one hop finds nothing. Walk two.
    const near = neighbours(t.ref, nl);
    const pick = (cands: PlacedFootprint[], used: Set<string>, from: Map<string, number>) =>
      cands
        .filter((c) => !used.has(c.ref) && (from.get(c.ref) ?? 0) > 0)
        .sort((a, b) => (from.get(b.ref) ?? 0) - (from.get(a.ref) ?? 0))[0];

    const sw = pick(switches, usedSw, near);
    if (sw) usedSw.add(sw.ref);
    const swNear = sw ? neighbours(sw.ref, nl) : new Map<string, number>();
    // The breaker is next to the switch on a switched channel, and next to the
    // terminal itself on an always-on one.
    const fuse = pick(fuses, usedFuse, swNear) ?? pick(fuses, usedFuse, near);
    if (fuse) usedFuse.add(fuse.ref);
    channels.push({ terminal: t, fuse, sw });
  }

  // The board should come out wider than it is tall, so the screw terminals run
  // along the long sides where a loom can reach them. Width is whichever is
  // larger: the room the channels need, or the room everything else needs laid
  // out about twice as wide as it is deep.
  const perEdge = Math.max(1, Math.ceil(channels.length / 2));
  const termPitch = Math.max(
    12,
    ...channels.map((c) => sizeOf(fpOf(c.terminal)).w + GAP * 2),
  );
  const lugWidth = lugs.length ? Math.max(...lugs.map((l) => sizeOf(fpOf(l)).w)) + EDGE * 2 : 0;
  let loose = 0;
  for (const f of board.footprints) {
    const sz = sizeOf(fpOf(f));
    loose += (sz.w + GAP) * (sz.h + GAP);
  }
  const byArea = Math.sqrt(loose * 2.2 * 4); // area x packing factor, at 4:1
  const width = Math.max(120, lugWidth + perEdge * termPitch + EDGE * 2, byArea);
  const height = Math.max(70, 60 + converters.length * 6);

  // A part's courtyard is not centred on its origin - a screw terminal's body
  // sits to one side - so placing the origin at a target leaves the courtyard
  // somewhere else, which is how a row ends up on top of the row above it.
  // Every placement below positions the courtyard's centre.
  const centreOffset = (fp: Footprint | undefined, rotation: number): Point => {
    const box = fp?.courtyard ?? fp?.bbox;
    if (!box) return { x: 0, y: 0 };
    const cx = (box.min.x + box.max.x) / 2;
    const cy = (box.min.y + box.max.y) / 2;
    const rad = (-rotation * Math.PI) / 180;
    return { x: cx * Math.cos(rad) - cy * Math.sin(rad), y: cx * Math.sin(rad) + cy * Math.cos(rad) };
  };

  const placed = new Set<string>();
  // Parts whose position is the point of the layout: a terminal belongs on the
  // edge, so the overlap pass moves everything else around it instead.
  const pinned = new Set<string>();
  const place = (f: PlacedFootprint | undefined, at: Point, rotation = 0, fix = false) => {
    if (!f) return;
    const off = centreOffset(fpOf(f), rotation);
    f.at = { x: +(at.x - off.x).toFixed(2), y: +(at.y - off.y).toFixed(2) };
    f.rotation = rotation;
    placed.add(f.ref);
    if (fix) pinned.add(f.ref);
  };

  // Lugs at one end, on the centre line, where heavy cable comes in.
  lugs.forEach((l, i) => {
    const h = sizeOf(fpOf(l)).h;
    place(l, { x: EDGE + sizeOf(fpOf(l)).w / 2, y: height / 2 + (i - (lugs.length - 1) / 2) * (h + GAP) }, 0, true);
  });

  // Parts placed against the bottom edge keep their distance from it, because
  // the board grows taller once everything else lands.
  const fromBottom = new Map<string, number>();

  // Channels line the top and bottom edges: terminal outermost so wire lands on
  // the outside, then its breaker, then its switch, marching inward.
  const startX = EDGE + lugWidth + termPitch / 2;
  channels.forEach((c, i) => {
    // Alternate sides rather than filling one edge then the other, so channel
    // n and channel n+1 sit opposite each other instead of a board apart.
    const top = i % 2 === 0;
    const idx = Math.floor(i / 2);
    const x = startX + idx * termPitch;
    const termH = sizeOf(fpOf(c.terminal)).h;
    const fuseH = c.fuse ? sizeOf(fpOf(c.fuse), 90).h : 0;
    const swH = c.sw ? sizeOf(fpOf(c.sw)).h : 0;
    if (top) {
      let y = EDGE + termH / 2;
      place(c.terminal, { x, y }, 0, true);
      y += termH / 2 + GAP + fuseH / 2;
      place(c.fuse, { x, y }, 90, true);
      y += fuseH / 2 + GAP + swH / 2;
      place(c.sw, { x, y }, 0, true);
    } else {
      let d = EDGE + termH / 2;
      place(c.terminal, { x, y: height - d }, 180, true);
      fromBottom.set(c.terminal.ref, d);
      d += termH / 2 + GAP + fuseH / 2;
      if (c.fuse) { place(c.fuse, { x, y: height - d }, 90, true); fromBottom.set(c.fuse.ref, d); }
      d += fuseH / 2 + GAP + swH / 2;
      if (c.sw) { place(c.sw, { x, y: height - d }, 180, true); fromBottom.set(c.sw.ref, d); }
    }
  });

  // Everything that is not on an edge flows through the middle in groups: a
  // converter or a chip followed immediately by its own passives, laid out row
  // by row. Nudging overlapping parts apart pairwise oscillates on a board this
  // size; flowing them into rows cannot overlap at all.
  // Start below whatever the top channel row actually occupies, and to the
  // right of the lug column, so the flow cannot run into a pinned part. The
  // board grows downward if the flow needs the room, and the bottom row is
  // re-seated against the final edge afterwards.
  let topUsed = EDGE;
  for (const f of board.footprints) {
    if (!pinned.has(f.ref) || fromBottom.has(f.ref)) continue;
    if (lugs.includes(f)) continue;
    topUsed = Math.max(topUsed, f.at.y + sizeOf(fpOf(f), f.rotation).h / 2);
  }
  const flowLeft = EDGE + lugWidth + GAP * 2;
  const midTop = topUsed + GAP * 3;
  const taken = new Set<string>(placed);
  const groups: PlacedFootprint[][] = [];
  const groupFor = (head: PlacedFootprint) => {
    const group = [head];
    taken.add(head.ref);
    for (const [ref] of [...neighbours(head.ref, nl)].sort((a, b) => b[1] - a[1])) {
      const part = byRef.get(ref);
      if (!part || taken.has(ref) || roles.get(ref) !== "passive") continue;
      group.push(part);
      taken.add(ref);
      if (group.length > 18) break;
    }
    return group;
  };
  for (const role of ["converter", "mcu", "rf", "logic", "usb"] as Role[]) {
    for (const head of of(role)) {
      if (taken.has(head.ref)) continue;
      groups.push(groupFor(head));
    }
  }
  for (const f of board.footprints) {
    if (taken.has(f.ref)) continue;
    groups.push(groupFor(f));
  }

  let cx = flowLeft;
  let cy = midTop;
  let rowH = 0;
  const lineWidth = width - EDGE;
  for (const group of groups) {
    // Keep a group on one row where it fits, so a chip and its decoupling stay
    // together instead of being split across the board.
    const groupW = group.reduce((sum, f) => sum + sizeOf(fpOf(f)).w + GAP, 0);
    if (cx > flowLeft && cx + Math.min(groupW, lineWidth / 2) > lineWidth) {
      cx = flowLeft;
      cy += rowH + GAP * 2;
      rowH = 0;
    }
    for (const f of group) {
      const sz = sizeOf(fpOf(f));
      if (cx + sz.w > lineWidth) {
        cx = flowLeft;
        cy += rowH + GAP * 2;
        rowH = 0;
      }
      place(f, { x: cx + sz.w / 2, y: cy + sz.h / 2 });
      cx += sz.w + GAP + COURTYARD;
      rowH = Math.max(rowH, sz.h + COURTYARD);
    }
    cx += GAP * 2;
  }

  // Size the board from everything except the bottom row, which follows the
  // edge rather than setting it, then seat that row against the real edge.
  const heightOf = (f: PlacedFootprint) => sizeOf(fpOf(f), f.rotation).h;
  let maxY = height;
  for (const f of board.footprints) {
    if (fromBottom.has(f.ref)) continue;
    maxY = Math.max(maxY, f.at.y + heightOf(f) / 2);
  }
  let finalH = Math.ceil(maxY + EDGE) + 2;
  for (const [ref, d] of fromBottom) {
    const f = byRef.get(ref);
    if (!f) continue;
    // Same correction as when it was first placed: d is where the courtyard's
    // centre belongs, not where the part's origin goes.
    const off = centreOffset(fpOf(f), f.rotation);
    f.at = { x: f.at.x, y: +(finalH - d - off.y).toFixed(2) };
  }

  // Now nothing moves again, guarantee no two parts overlap. Anything still
  // colliding goes to a spare area below the board: a part you have to drag is
  // better than two parts on top of each other, and the DRC stays clean.
  // The courtyard is not centred on the part's origin - a connector's sits off
  // to one side - so rotate its actual corners and take the bounding box.
  const rectOf = (f: PlacedFootprint) => {
    const fp = fpOf(f);
    const box = fp?.courtyard ?? fp?.bbox;
    if (!box) {
      const sz = sizeOf(fp, f.rotation);
      return { x1: f.at.x - sz.w / 2, y1: f.at.y - sz.h / 2, x2: f.at.x + sz.w / 2, y2: f.at.y + sz.h / 2 };
    }
    // KiCad rotates a footprint counter-clockwise, and PCB space is Y-down, so
    // the angle is negated to land the courtyard on the side KiCad puts it.
    const rad = (-f.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const xs: number[] = [];
    const ys: number[] = [];
    for (const c of [
      { x: box.min.x, y: box.min.y },
      { x: box.max.x, y: box.min.y },
      { x: box.max.x, y: box.max.y },
      { x: box.min.x, y: box.max.y },
    ]) {
      xs.push(f.at.x + c.x * cos - c.y * sin);
      ys.push(f.at.y + c.x * sin + c.y * cos);
    }
    const pad = 0.15; // a hair, so touching courtyards do not count as overlapping
    return { x1: Math.min(...xs) - pad, y1: Math.min(...ys) - pad, x2: Math.max(...xs) + pad, y2: Math.max(...ys) + pad };
  };
  const hits = (a: ReturnType<typeof rectOf>, b: ReturnType<typeof rectOf>) =>
    a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
  const accepted: ReturnType<typeof rectOf>[] = [];
  let spareX = EDGE;
  let spareY = finalH + GAP * 3;
  let spareRow = 0;
  let displaced = 0;
  const displacedRefs: string[] = [];
  // Edge parts are the layout; they get first claim, and the rest move.
  const order = [...board.footprints].sort((a, b) => Number(pinned.has(b.ref)) - Number(pinned.has(a.ref)));
  for (const f of order) {
    let r = rectOf(f);
    if (accepted.some((a) => hits(a, r))) {
      const sz = sizeOf(fpOf(f), f.rotation);
      if (spareX + sz.w > width - EDGE) {
        spareX = EDGE;
        spareY += spareRow + GAP * 2;
        spareRow = 0;
      }
      f.at = { x: +(spareX + sz.w / 2).toFixed(2), y: +(spareY + sz.h / 2).toFixed(2) };
      spareX += sz.w + GAP + COURTYARD;
      spareRow = Math.max(spareRow, sz.h + COURTYARD);
      r = rectOf(f);
      displaced++;
      displacedRefs.push(f.ref);
    }
    accepted.push(r);
  }
  if (displaced) notes.push(`${displaced} parts moved to a spare area below the board so nothing overlaps (${displacedRefs.slice(0, 8).join(", ")}${displacedRefs.length > 8 ? ", ..." : ""})`);

  let maxX = 0;
  for (const f of board.footprints) {
    const sz = sizeOf(fpOf(f), f.rotation);
    maxX = Math.max(maxX, f.at.x + sz.w / 2);
    finalH = Math.max(finalH, Math.ceil(f.at.y + sz.h / 2 + EDGE));
  }
  board.outline = [
    { x: 0, y: 0 },
    { x: Math.ceil(Math.max(width, maxX + EDGE)) + 2, y: 0 },
    { x: Math.ceil(Math.max(width, maxX + EDGE)) + 2, y: finalH },
    { x: 0, y: finalH },
  ];

  notes.push(`${channels.length} channels along the edges, ${lugs.length} lug(s) at the input end, ${converters.length} converter(s) in the middle`);
  return { board, notes };
}
