// #region Copper pours
// A 30A channel is not a trace. Ground is not a trace either - on a two layer
// board it is the back of the board, and everything returns through it.
//
// This decides what gets poured and over what area. The copper itself is filled
// by KiCad's own filler, run through pcbnew in the same container that runs DRC:
// a hand-rolled fill is a second opinion about clearance, thermals and islands,
// and the fab only cares about KiCad's.

import type { Board, Zone } from "./board";
import type { Netlist } from "./netlist";
import { localWorld } from "./pcbgen";

export interface PourOptions {
  // A pour can be bounded: ground belongs everywhere on the back of the board,
  // but a 24V rail belongs over the circuits that use it, not under the
  // microcontroller.
  nets: { name: string; layer: string; priority?: number; bounds?: { x1: number; y1: number; x2: number; y2: number } }[];
}

export interface PourResult {
  zones: Zone[];
  notes: string[];
}

export function planPours(board: Board, nl: Netlist, opts: PourOptions): PourResult {
  const zones: Zone[] = [];
  const notes: string[] = [];
  for (const target of opts.nets) {
    const b = target.bounds;
    const poly = b
      ? [
          { x: b.x1, y: b.y1 },
          { x: b.x2, y: b.y1 },
          { x: b.x2, y: b.y2 },
          { x: b.x1, y: b.y2 },
        ]
      : board.outline.map((p) => ({ ...p }));
    if (poly.length < 3) continue;
    zones.push({ uuid: crypto.randomUUID(), net: target.name, layer: target.layer, polygon: poly, priority: target.priority });
    const w = Math.max(...poly.map((p) => p.x)) - Math.min(...poly.map((p) => p.x));
    const h = Math.max(...poly.map((p) => p.y)) - Math.min(...poly.map((p) => p.y));
    notes.push(`${target.name} pour on ${target.layer} over ${(w * h / 100).toFixed(0)} cm2`);
  }
  void nl;
  return { zones, notes };
}

// #region stitching
// A ground pour on two layers is two pours until something joins them, and a
// pour cut into islands by tracks is only as good as the island a pad sits on.
// Stitching vias on a coarse grid fix both: they tie front to back and pull the
// islands into one net.
export function stitchVias(
  board: Board,
  footprints: Record<string, { pads: { number: string; at: { x: number; y: number }; size: { w: number; h: number }; drill?: number }[] }>,
  opts: {
    net: string;
    pitch?: number;
    size?: number;
    drill?: number;
    clearance?: number;
    // Areas another pour owns, and areas a part has declared off limits. A
    // stitching via inside either one is a via connected to nothing.
    avoid?: { x1: number; y1: number; x2: number; y2: number }[];
  },
): { vias: Board["vias"]; note: string } {
  const pitch = opts.pitch ?? 6;
  const size = opts.size ?? 0.8;
  const drill = opts.drill ?? 0.4;
  // Room for the via's own copper, the rule, and a margin: a via that misses by
  // a hundredth of a millimetre is still a DRC error.
  const clear = (opts.clearance ?? board.rules.minClearance) + size / 2 + 0.25;

  const xs = board.outline.map((p) => p.x);
  const ys = board.outline.map((p) => p.y);
  const minX = Math.min(...xs) + 6;
  const maxX = Math.max(...xs) - 6;
  const minY = Math.min(...ys) + 6;
  const maxY = Math.max(...ys) - 6;

  // Everything that is not this net and must be kept away from.
  const blockers: { x: number; y: number; r: number }[] = [];
  for (const f of board.footprints) {
    const fp = footprints[f.libId];
    if (!fp) continue;
    for (const pad of fp.pads) {
      const at = localWorld(f, pad.at);
      // Even a pad on the same net is a place a via should not sit: it would
      // land in the middle of a footprint.
      // A mounting hole has a drill and no copper, and it still has to be
      // avoided - by more than its copper, in fact.
      blockers.push({ x: at.x, y: at.y, r: Math.max(pad.size.w, pad.size.h, pad.drill ?? 0) / 2 + clear });
    }
  }
  const segs = board.tracks.filter((t) => t.net !== opts.net);
  const vias: Board["vias"] = [];
  const near = (x: number, y: number) => {
    for (const b of blockers) if (Math.hypot(b.x - x, b.y - y) < b.r) return true;
    for (const t of segs) {
      const dx = t.end.x - t.start.x;
      const dy = t.end.y - t.start.y;
      const len2 = dx * dx + dy * dy || 1;
      let u = ((x - t.start.x) * dx + (y - t.start.y) * dy) / len2;
      u = Math.max(0, Math.min(1, u));
      const px = t.start.x + u * dx;
      const py = t.start.y + u * dy;
      if (Math.hypot(px - x, py - y) < t.width / 2 + clear) return true;
    }
    for (const v of board.vias) if (Math.hypot(v.at.x - x, v.at.y - y) < v.size / 2 + clear) return true;
    return false;
  };

  const avoid = opts.avoid ?? [];
  const blocked = (x: number, y: number) =>
    avoid.some((a) => x > a.x1 - clear && x < a.x2 + clear && y > a.y1 - clear && y < a.y2 + clear);
  const tryVia = (x: number, y: number) => {
    if (x < minX || x > maxX || y < minY || y > maxY) return false;
    if (blocked(x, y) || near(x, y)) return false;
    const via = { uuid: crypto.randomUUID(), at: { x: +x.toFixed(2), y: +y.toFixed(2) }, size, drill, net: opts.net };
    vias.push(via);
    board.vias.push(via);
    return true;
  };

  // A via beside every ground pad. This is the return path for the decoupling
  // capacitor next to it, and it pulls the pad's island into the plane.
  for (const f of board.footprints) {
    const fp = footprints[f.libId];
    if (!fp) continue;
    for (const pad of fp.pads) {
      if (f.padNets[pad.number] !== opts.net) continue;
      const rad = (-f.rotation * Math.PI) / 180;
      const at = {
        x: f.at.x + pad.at.x * Math.cos(rad) - pad.at.y * Math.sin(rad),
        y: f.at.y + pad.at.x * Math.sin(rad) + pad.at.y * Math.cos(rad),
      };
      if (pad.drill) continue; // a through hole pad is already on both layers
      const reach = Math.max(pad.size.w, pad.size.h) / 2 + size / 2 + clear;
      if ([
        { x: at.x + reach, y: at.y },
        { x: at.x - reach, y: at.y },
        { x: at.x, y: at.y + reach },
        { x: at.x, y: at.y - reach },
      ].some((c) => tryVia(c.x, c.y))) continue;
    }
  }

  for (let y = minY; y <= maxY; y += pitch) {
    for (let x = minX; x <= maxX; x += pitch) {
      tryVia(x, y);
    }
  }
  return { vias, note: `${vias.length} ${opts.net} stitching vias on a ${pitch}mm grid` };
}
