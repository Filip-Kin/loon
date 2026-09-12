// #region Board generation
// Turns a schematic into a first board: every part gets its footprint, every
// pad gets its net from the netlist, parts of one module stay together, and the
// outline wraps the result. It is a starting placement, not a finished layout -
// the point is that the user (or the assistant) drags from something real
// instead of from an empty rectangle.

import type { Schematic, Point } from "./schematic";
import type { Footprint } from "./footprint";
import { buildNetlist, type Netlist, type DefResolver } from "./netlist";
import { emptyBoard, rectOutline, type Board, type PlacedFootprint, type DesignRules, OSHPARK_2LAYER } from "./board";

export interface RatsnestLine {
  net: string;
  a: Point;
  b: Point;
}

const MARGIN = 2.5; // mm between parts
const EDGE = 5; // mm from the outermost part to the board edge

function sizeOf(fp: Footprint): { w: number; h: number } {
  return { w: Math.max(1, fp.bbox.max.x - fp.bbox.min.x), h: Math.max(1, fp.bbox.max.y - fp.bbox.min.y) };
}

export interface GenerateOptions {
  rules?: DesignRules;
  // Footprint per lib id; anything missing is skipped and reported.
  footprints: Record<string, Footprint>;
  // Keep placement of parts that already exist on the board.
  existing?: Board;
}

export interface GenerateResult {
  board: Board;
  placed: number;
  missingFootprints: { ref: string; libId: string }[];
  approximate: string[];
}

export function generateBoard(schem: Schematic, resolve: DefResolver | undefined, opts: GenerateOptions): GenerateResult {
  const nl: Netlist = buildNetlist(schem, resolve);
  const board = emptyBoard(opts.rules ?? OSHPARK_2LAYER);
  const keepByRef = new Map((opts.existing?.footprints ?? []).map((f) => [f.ref, f]));
  if (opts.existing) {
    board.tracks = opts.existing.tracks;
    board.vias = opts.existing.vias;
    board.zones = opts.existing.zones;
  }

  const missing: { ref: string; libId: string }[] = [];
  const approximate: string[] = [];

  // Group by block so a module's parts land next to each other, in the order
  // they sit on the schematic.
  const groups = new Map<string, typeof schem.symbols>();
  for (const s of schem.symbols) {
    if (s.libId.startsWith("power:")) continue;
    const key = s.properties.LoonBlock ?? "_loose";
    const arr = groups.get(key) ?? [];
    arr.push(s);
    groups.set(key, arr);
  }

  let cursorX = EDGE;
  let cursorY = EDGE;
  let rowHeight = 0;
  const maxWidth = 120; // mm; a sane starting board width, the user resizes

  for (const [blockId, members] of groups) {
    members.sort((a, b) => a.at.y - b.at.y || a.at.x - b.at.x);
    let blockX = cursorX;
    let blockY = cursorY;
    let blockRow = 0;
    let blockWidth = 0;

    for (const sym of members) {
      const ref = sym.properties.Reference ?? "?";
      const fpId = sym.properties.Footprint ?? "";
      if (!fpId) {
        missing.push({ ref, libId: "(none set)" });
        continue;
      }
      const fp = opts.footprints[fpId];
      if (!fp) {
        missing.push({ ref, libId: fpId });
        continue;
      }
      if (!fp.fromLibrary && !approximate.includes(fpId)) approximate.push(fpId);

      const padNets: Record<string, string> = {};
      for (const pad of fp.pads) {
        const net = nl.netOfPin[`${ref}:${pad.number}`];
        if (net) padNets[pad.number] = net;
      }
      // Some footprints give one physical pad two numbers - a USB-C receptacle
      // shorts A1 to B12 and so on. A pad stack sharing a position shares a
      // net, otherwise KiCad reports them as two nets touching.
      const byPos = new Map<string, typeof fp.pads>();
      for (const pad of fp.pads) {
        const k = `${pad.at.x.toFixed(3)},${pad.at.y.toFixed(3)}`;
        const arr = byPos.get(k) ?? [];
        arr.push(pad);
        byPos.set(k, arr);
      }
      for (const stack of byPos.values()) {
        if (stack.length < 2) continue;
        const known = stack.map((pd) => padNets[pd.number]).find(Boolean);
        if (known) for (const pd of stack) padNets[pd.number] = known;
      }

      const kept = keepByRef.get(ref);
      if (kept) {
        board.footprints.push({ ...kept, padNets, libId: fpId, blockId: blockId === "_loose" ? undefined : blockId });
        continue;
      }

      const size = sizeOf(fp);
      if (blockX + size.w > maxWidth) {
        blockX = cursorX;
        blockY += blockRow + MARGIN;
        blockRow = 0;
      }
      const place: PlacedFootprint = {
        uuid: crypto.randomUUID(),
        ref,
        value: sym.properties.Value ?? "",
        symbolUuid: sym.uuid,
        libId: fpId,
        at: { x: +(blockX + size.w / 2).toFixed(3), y: +(blockY + size.h / 2).toFixed(3) },
        rotation: 0,
        side: "F",
        padNets,
        blockId: blockId === "_loose" ? undefined : blockId,
      };
      board.footprints.push(place);
      blockX += size.w + MARGIN;
      blockRow = Math.max(blockRow, size.h);
      blockWidth = Math.max(blockWidth, blockX - cursorX);
    }

    // Next block starts below this one.
    cursorY = blockY + blockRow + MARGIN * 2;
    rowHeight = Math.max(rowHeight, cursorY);
    void blockWidth;
  }

  // Outline wraps everything with a margin.
  let maxX = 0;
  let maxY = 0;
  for (const f of board.footprints) {
    const fp = opts.footprints[f.libId];
    const s = fp ? sizeOf(fp) : { w: 5, h: 5 };
    maxX = Math.max(maxX, f.at.x + s.w / 2);
    maxY = Math.max(maxY, f.at.y + s.h / 2);
  }
  board.outline = rectOutline(0, 0, Math.ceil(maxX + EDGE), Math.ceil(maxY + EDGE));

  return { board, placed: board.footprints.length, missingFootprints: missing, approximate };
}

// #region ratsnest
function rotate(p: Point, deg: number): Point {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

export function padWorld(f: PlacedFootprint, padAt: Point): Point {
  const r = rotate(padAt, f.rotation);
  const mirrored = f.side === "B" ? { x: -r.x, y: r.y } : r;
  return { x: f.at.x + mirrored.x, y: f.at.y + mirrored.y };
}

// Minimum spanning tree per net: the shortest set of lines that shows what
// still has to be routed.
export function ratsnest(board: Board, footprints: Record<string, Footprint>): RatsnestLine[] {
  const byNet = new Map<string, Point[]>();
  for (const f of board.footprints) {
    const fp = footprints[f.libId];
    if (!fp) continue;
    for (const pad of fp.pads) {
      const net = f.padNets[pad.number];
      if (!net) continue;
      const arr = byNet.get(net) ?? [];
      arr.push(padWorld(f, pad.at));
      byNet.set(net, arr);
    }
  }

  const out: RatsnestLine[] = [];
  for (const [net, pts] of byNet) {
    if (pts.length < 2) continue;
    const inTree = [pts[0]];
    const rest = pts.slice(1);
    while (rest.length) {
      let best = { i: 0, j: 0, d: Infinity };
      for (let i = 0; i < inTree.length; i++) {
        for (let j = 0; j < rest.length; j++) {
          const d = Math.hypot(inTree[i].x - rest[j].x, inTree[i].y - rest[j].y);
          if (d < best.d) best = { i, j, d };
        }
      }
      out.push({ net, a: inTree[best.i], b: rest[best.j] });
      inTree.push(rest[best.j]);
      rest.splice(best.j, 1);
    }
  }
  return out;
}

// #region DRC
export interface DrcIssue {
  severity: "error" | "warning";
  rule: string;
  message: string;
  at?: Point;
}

function segDistance(a1: Point, a2: Point, b1: Point, b2: Point): number {
  const d = (p: Point, q1: Point, q2: Point) => {
    const vx = q2.x - q1.x;
    const vy = q2.y - q1.y;
    const len2 = vx * vx + vy * vy;
    if (len2 === 0) return Math.hypot(p.x - q1.x, p.y - q1.y);
    let t = ((p.x - q1.x) * vx + (p.y - q1.y) * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (q1.x + t * vx), p.y - (q1.y + t * vy));
  };
  return Math.min(d(a1, b1, b2), d(a2, b1, b2), d(b1, a1, a2), d(b2, a1, a2));
}

export function runDrc(board: Board, footprints: Record<string, Footprint>, ratsLeft: number): DrcIssue[] {
  const issues: DrcIssue[] = [];
  const r = board.rules;

  for (const t of board.tracks) {
    if (t.width < r.minTrackWidth - 1e-6) {
      issues.push({
        severity: "error",
        rule: "track-width",
        message: `Track on ${t.net} is ${t.width.toFixed(3)}mm, below ${r.name}'s ${r.minTrackWidth}mm minimum`,
        at: t.start,
      });
    }
  }

  for (const v of board.vias) {
    if (v.drill < r.minDrill - 1e-6) {
      issues.push({ severity: "error", rule: "drill", message: `Via drill ${v.drill}mm is below the ${r.minDrill}mm minimum`, at: v.at });
    }
    if ((v.size - v.drill) / 2 < r.minAnnularRing - 1e-6) {
      issues.push({ severity: "error", rule: "annular-ring", message: `Via annular ring is below ${r.minAnnularRing}mm`, at: v.at });
    }
  }

  // Track-to-track clearance between different nets on the same layer.
  for (let i = 0; i < board.tracks.length; i++) {
    for (let j = i + 1; j < board.tracks.length; j++) {
      const a = board.tracks[i];
      const b = board.tracks[j];
      if (a.layer !== b.layer || a.net === b.net) continue;
      const gap = segDistance(a.start, a.end, b.start, b.end) - (a.width + b.width) / 2;
      if (gap < r.minClearance - 1e-6) {
        issues.push({
          severity: "error",
          rule: "clearance",
          message: `${a.net} and ${b.net} are ${Math.max(0, gap).toFixed(3)}mm apart, under the ${r.minClearance}mm minimum`,
          at: a.start,
        });
      }
    }
  }

  // Footprints overlapping each other.
  for (let i = 0; i < board.footprints.length; i++) {
    for (let j = i + 1; j < board.footprints.length; j++) {
      const fa = board.footprints[i];
      const fb = board.footprints[j];
      const a = footprints[fa.libId];
      const b = footprints[fb.libId];
      if (!a || !b || fa.side !== fb.side) continue;
      const ax = Math.abs(fa.at.x - fb.at.x);
      const ay = Math.abs(fa.at.y - fb.at.y);
      const wa = (a.bbox.max.x - a.bbox.min.x) / 2 + (b.bbox.max.x - b.bbox.min.x) / 2;
      const ha = (a.bbox.max.y - a.bbox.min.y) / 2 + (b.bbox.max.y - b.bbox.min.y) / 2;
      if (ax < wa - 0.05 && ay < ha - 0.05) {
        issues.push({ severity: "error", rule: "overlap", message: `${fa.ref} and ${fb.ref} overlap`, at: fa.at });
      }
    }
  }

  const drillReported = new Set<string>();
  for (const f of board.footprints) {
    const fp = footprints[f.libId];
    if (!fp) continue;
    for (const pad of fp.pads) {
      if (pad.drill === undefined || pad.drill <= 0) continue;
      if (pad.drill < r.minDrill - 1e-6 && !drillReported.has(f.libId)) {
        drillReported.add(f.libId);
        issues.push({
          severity: "error",
          rule: "footprint-drill",
          message: `${f.ref} (${f.libId}) has ${pad.drill}mm holes, under ${r.name}'s ${r.minDrill}mm minimum. Enlarge or delete those vias before ordering.`,
          at: f.at,
        });
      }
    }
  }

  for (const [id, fp] of Object.entries(footprints)) {
    if (!fp.fromLibrary && board.footprints.some((f) => f.libId === id)) {
      issues.push({
        severity: "warning",
        rule: "generated-footprint",
        message: `${id} is a generated land pattern, not KiCad's. Check it against the datasheet before ordering.`,
      });
    }
  }

  if (ratsLeft > 0) {
    issues.push({ severity: "warning", rule: "unrouted", message: `${ratsLeft} connections are still unrouted` });
  }

  return issues;
}
