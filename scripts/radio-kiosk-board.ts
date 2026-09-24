// FRC radio kiosk boards: what every layout of it shares.
//
// The schematic (build-radio-kiosk.ts) is the same for v2 and v2b; the two
// board scripts differ only in how the parts are placed. Everything else is
// here: footprints and netlist, jacks flush with their edge, the four cell
// holders on the back, corner holes, the Ethernet pass-through pre-routed
// along the left edge, silkscreen, checks, pours, the KiCad files and a
// quick-look SVG.
import { library } from "../server/src/services/library";
import { getFootprints } from "../server/src/services/footprints";
import { storage } from "../server/src/services/storage";
import { buildRadioKiosk } from "./build-radio-kiosk";
import { buildNetlist } from "@loon/shared/netlist";
import { generateBoard, ratsnest, runDrc, padWorld } from "@loon/shared/pcbgen";
import { planPours } from "@loon/shared/pour";
import { serializeBoard, serializeProject } from "@loon/shared/kicad-pcb";
import { OSHPARK_2LAYER, rectOutline, type Board, type PlacedFootprint } from "@loon/shared/board";
import type { Footprint } from "@loon/shared/footprint";
import type { Point } from "@loon/shared/schematic";

export const HOLE = "MountingHole:MountingHole_3.2mm_M3";
export type Edge = "N" | "E" | "S" | "W";
export type R = { x1: number; y1: number; x2: number; y2: number };

// #region geometry
export function sizeOf(fp?: Footprint, rotation = 0) {
  if (!fp) return { w: 5, h: 5 };
  const box = fp.courtyard ?? fp.bbox;
  const w = Math.max(1, box.max.x - box.min.x, fp.bbox.max.x - fp.bbox.min.x);
  const h = Math.max(1, box.max.y - box.min.y, fp.bbox.max.y - fp.bbox.min.y);
  const turned = Math.abs((((rotation % 180) + 180) % 180) - 90) < 1;
  return turned ? { w: h, h: w } : { w, h };
}
// KiCad sense: counter-clockwise on screen, y down.
export function rot(p: Point, deg: number): Point {
  const r = (-deg * Math.PI) / 180;
  return { x: p.x * Math.cos(r) - p.y * Math.sin(r), y: p.x * Math.sin(r) + p.y * Math.cos(r) };
}
// Courtyard centre in board coordinates for a placed footprint.
export function centreOf(f: PlacedFootprint, fp?: Footprint): Point {
  const box = fp?.courtyard ?? fp?.bbox;
  if (!box) return f.at;
  const c = { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2 };
  const m = rot(f.side === "B" ? { x: -c.x, y: c.y } : c, f.rotation);
  return { x: f.at.x + m.x, y: f.at.y + m.y };
}
export function rectOf(f: PlacedFootprint, fp?: Footprint): R {
  const c = centreOf(f, fp);
  const s = sizeOf(fp, f.rotation);
  return { x1: c.x - s.w / 2, y1: c.y - s.h / 2, x2: c.x + s.w / 2, y2: c.y + s.h / 2 };
}
// Which way the plug goes in: the courtyard centre sits on the body side of
// the pads, so pads-to-courtyard is "into the board" and its opposite is out.
function outwardOf(fp?: Footprint): Point | undefined {
  if (!fp?.pads.length || !fp.courtyard) return undefined;
  const pc = { x: fp.pads.reduce((s, p) => s + p.at.x, 0) / fp.pads.length, y: fp.pads.reduce((s, p) => s + p.at.y, 0) / fp.pads.length };
  const cc = { x: (fp.courtyard.min.x + fp.courtyard.max.x) / 2, y: (fp.courtyard.min.y + fp.courtyard.max.y) / 2 };
  const v = { x: cc.x - pc.x, y: cc.y - pc.y };
  return Math.hypot(v.x, v.y) > 0.4 ? v : undefined;
}
export function faceRotation(fp: Footprint | undefined, normal: Point): number {
  const v = outwardOf(fp);
  if (!v) return 0;
  let best = 0, bestDot = -Infinity;
  for (const r of [0, 90, 180, 270]) {
    const rv = rot(v, r);
    const dot = (rv.x * normal.x + rv.y * normal.y) / (Math.hypot(rv.x, rv.y) || 1);
    if (dot > bestDot) { bestDot = dot; best = r; }
  }
  return best;
}
export const NORMAL: Record<Edge, Point> = { N: { x: 0, y: -1 }, E: { x: 1, y: 0 }, S: { x: 0, y: 1 }, W: { x: -1, y: 0 } };
// Rotation that turns a footprint's front axis toward an edge. Rotation is
// counter-clockwise on screen (y down), so a +Y front turned to face East is
// 90. Checked against the 3D render.
export const FRONT_ROT: Record<"+x" | "+y", Record<Edge, number>> = {
  "+y": { N: 180, E: 90, S: 0, W: 270 },
  "+x": { N: 90, E: 0, S: 270, W: 180 },
};
export const hits = (taken: R[], r: R) => taken.some((t) => r.x1 < t.x2 && r.x2 > t.x1 && r.y1 < t.y2 && r.y2 > t.y1);

// #region prepare
export async function prepareBoard() {
  const schem = buildRadioKiosk();
  const defs = (libId: string) => library.get(libId)?.def ?? schem.libSymbols[libId];
  const nl = buildNetlist(schem, defs);
  const specs = new Map<string, number>();
  for (const s of schem.symbols) {
    const fp = s.properties.Footprint;
    if (fp) specs.set(fp, defs(s.libId)?.pins.length ?? 2);
  }
  const footprints = await getFootprints([...[...specs].map(([libId, padCount]) => ({ libId, padCount })), { libId: HOLE, padCount: 0 }]);
  const approx = Object.values(footprints).filter((f) => !f.fromLibrary).map((f) => f.libId);
  console.log(`footprints: ${Object.keys(footprints).length}, generated (not from KiCad): ${approx.join(", ") || "none"}`);
  const gen = generateBoard(schem, defs, { rules: OSHPARK_2LAYER, footprints });
  const board: Board = gen.board;
  console.log(`autoPlace: ${gen.placed} placed, missing ${gen.missingFootprints.map((m) => m.ref).join(",") || "none"}`);
  const fpOf = (f: PlacedFootprint) => footprints[f.libId];
  return { schem, nl, footprints, board, fpOf };
}
export type Prepared = Awaited<ReturnType<typeof prepareBoard>>;

export const placeAtCentre = (fpOf: Prepared["fpOf"], f: PlacedFootprint, centre: Point, rotation: number) => {
  const fp = fpOf(f);
  f.rotation = rotation;
  const box = fp?.courtyard ?? fp?.bbox;
  const cc = box ? { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2 } : { x: 0, y: 0 };
  const m = rot(f.side === "B" ? { x: -cc.x, y: cc.y } : cc, rotation);
  f.at = { x: +(centre.x - m.x).toFixed(2), y: +(centre.y - m.y).toFixed(2) };
};

// #region fixed parts: connectors, cells, holes
export type Connector = { ref: string; at: Point; face: Edge; rotation?: number };
// Jacks sit with their front face at the board edge, opening outward. Each
// land pattern says which of its axes is the front (from its outline: the RJ45
// body runs to +Y, the barrel jack to +X, the USB-C receptacles to +Y).
export type Flush = { ref?: string; libMatch?: RegExp; edge: Edge; along: number; front: "+x" | "+y"; overhang: number };

export function placeConnectors(p: Prepared, W: number, H: number, connectors: Connector[], flush: Flush[]): Set<string> {
  const { board, fpOf } = p;
  const connectorRefs = new Set<string>(connectors.map((c) => c.ref));
  for (const c of connectors) {
    const f = board.footprints.find((x) => x.ref === c.ref);
    if (!f) { console.log(`no connector ${c.ref}`); continue; }
    placeAtCentre(fpOf, f, c.at, c.rotation ?? faceRotation(fpOf(f), NORMAL[c.face]));
  }
  for (const c of flush) {
    const f = c.ref ? board.footprints.find((x) => x.ref === c.ref) : board.footprints.find((x) => c.libMatch!.test(x.libId) && !connectorRefs.has(x.ref));
    if (!f) { console.log(`no flush part for ${c.ref ?? c.libMatch}`); continue; }
    const box = fpOf(f).bbox;
    const d = c.front === "+y" ? box.max.y : box.max.x; // front face distance from the origin
    f.rotation = FRONT_ROT[c.front][c.edge];
    const o = c.overhang;
    if (c.edge === "N") f.at = { x: c.along, y: +(d - o).toFixed(2) };
    if (c.edge === "S") f.at = { x: c.along, y: +(H - d + o).toFixed(2) };
    if (c.edge === "E") f.at = { x: +(W - d + o).toFixed(2), y: c.along };
    if (c.edge === "W") f.at = { x: +(d - o).toFixed(2), y: c.along };
    connectorRefs.add(f.ref);
  }
  return connectorRefs;
}

// Cells: 1 x 4 on the back, long axis along Y, the + of one beside the - of
// the next so the series links are short. (Which end is + is checked on the
// real part.) Returns where their pins come through.
export function placeCells(p: Prepared, cx: number, cy: number, gap = 2): Point[] {
  const { board, fpOf } = p;
  const cells = board.footprints.filter((f) => /^BT[1-4]$/.test(f.ref));
  const s0 = sizeOf(fpOf(cells[0]), 0);
  const long = Math.max(s0.w, s0.h), short = Math.min(s0.w, s0.h);
  const r = s0.w >= s0.h ? 90 : 0;
  const spots = [0, 1, 2, 3].map((i) => ({ x: cx + (i - 1.5) * (short + gap), y: cy }));
  cells.forEach((f, i) => { f.side = "B"; placeAtCentre(fpOf, f, spots[i], (r + (i % 2 ? 180 : 0)) % 360); });
  const pads: Point[] = [];
  for (const f of cells) for (const pad of fpOf(f).pads) if (pad.type === "thru_hole" || pad.type === "np_thru_hole") pads.push(padWorld(f, pad.at));
  console.log(`cells: ${long.toFixed(1)} x ${short.toFixed(1)} mm each, 1 x 4 at (${cx}, ${cy}) on B, ${(4 * short + 3 * gap).toFixed(1)} mm across; pads at ${pads.map((q) => `(${q.x.toFixed(0)},${q.y.toFixed(0)})`).join(" ")}`);
  return pads;
}

export function placeHoles(p: Prepared, W: number, H: number, inset = 4): PlacedFootprint[] {
  p.board.outline = rectOutline(0, 0, W, H);
  const holes = p.board.footprints.filter((f) => /^H\d+$/.test(f.ref));
  const corners = [{ x: inset, y: inset }, { x: W - inset, y: inset }, { x: inset, y: H - inset }, { x: W - inset, y: H - inset }];
  holes.forEach((h, i) => { if (corners[i]) h.at = corners[i]; });
  return holes;
}

// #region Ethernet pairs, hand-routed down the left edge on the back
// Freerouting keeps existing copper, so these four tracks are the pass-through
// as built. The RJ45 pins sit in two staggered rows 1.78 mm apart with 1.52 mm
// pads, so a track cannot pass between them: the pin nearer the board leaves
// on a row 1.3 mm off the pins, running west to its lane; the pin nearer the
// edge goes out to the edge strip, over the jack's left peg and back to its
// own row. Pair 1/2 is on B.Cu throughout; pair 3/6 makes its jog at each
// jack on F.Cu and drops through vias past pair 1/2's rows. At the radio
// jack pin 3 goes the other way round, over the right peg and across the top
// of the jack, so the PoE pins 7/8 can leave west along the pin row and 4/5
// under the jack. Lanes past the pegs at x 8-10, then 45-degree runs to the
// left edge (x 2-4.3) for the length of the board. 0.3 mm on 0.5 mm centres,
// pairs 1 mm apart, 45-degree mitres. The near track of each pair is shorter
// and gets trombone bumps on its rows.
export function preRouteEthernet(p: Prepared, H: number, o: { laneX0: number; midX0: number; topJogY: number; botJogY: number }) {
  const { board, fpOf } = p;
  const padOf = (ref: string, net: string) => {
    const f = board.footprints.find((x) => x.ref === ref)!;
    const pad = fpOf(f).pads.find((q) => f.padNets[q.number] === net)!;
    return padWorld(f, pad.at);
  };
  const pegs = (ref: string) => { const f = board.footprints.find((x) => x.ref === ref)!; return fpOf(f).pads.filter((q) => q.type === "np_thru_hole").map((q) => ({ ...padWorld(f, q.at), r: (q.drill ?? 3) / 2 })).sort((u, v) => u.x - v.x); };
  const W_ETH = 0.3, M = 0.8, OFF = 1.3, EDGE_Y = 1.8, PITCH = 0.5, PAIR_GAP = 1.0;
  const len = (pts: Point[]) => pts.slice(1).reduce((s, q, i) => s + Math.hypot(q.x - pts[i].x, q.y - pts[i].y), 0);
  const NETS = ["ETH_1", "ETH_2", "ETH_3", "ETH_6"];         // lane order, west to east: far, near, far, near
  const off = (k: number) => k * PITCH + (k >= 2 ? PAIR_GAP : 0);
  const [peg6L] = pegs("J6"), [peg5L, peg5R] = pegs("J5");
  const hop6 = peg6L.x - peg6L.r - 0.6, hop5L = peg5L.x - peg5L.r - 0.6, hop5R = peg5R.x + peg5R.r + 0.85;
  const near6 = (n: string) => padOf("J6", n).y > 7.8, near5 = (n: string) => padOf("J5", n).y < H - 7.8;
  const nearRow6 = Math.max(...NETS.filter(near6).map((n) => padOf("J6", n).y)) + OFF;
  const nearRow5 = Math.min(...NETS.filter(near5).map((n) => padOf("J5", n).y)) - OFF;
  type Seg = { layer: string; pts: Point[] };
  type Row = { y: number; xPad: number; xLane: number; dir: 1 | -1; xMin?: number };
  type Tr = { n: string; k: number; segs: Seg[]; vias: Point[]; near: boolean; rows: Row[] };
  const plan: Tr[] = NETS.map((n, k) => {
    const a = padOf("J6", n), q = padOf("J5", n);
    const near = near6(n);
    const segs: Seg[] = [], vias: Point[] = [], rows: Row[] = [];
    const lx = o.laneX0 + off(k), mx = o.midX0 + off(k);
    let laneTop: Point, laneBot: Point;
    // --- laptop jack, top: rows run west ---
    if (k < 2) {
      if (near) {
        const y = a.y + OFF;
        segs.push({ layer: "B.Cu", pts: [a, { x: a.x, y: y - M }, { x: a.x - M, y }, { x: lx + M, y }, { x: lx, y: y + M }] });
        rows.push({ y, xPad: a.x, xLane: lx, dir: 1 }); laneTop = { x: lx, y: y + M };
      } else {
        const y = a.y - OFF;
        segs.push({ layer: "B.Cu", pts: [a, { x: a.x, y: EDGE_Y + M }, { x: a.x - M, y: EDGE_Y }, { x: hop6 + M, y: EDGE_Y }, { x: hop6, y: EDGE_Y + M }, { x: hop6, y: y - M }, { x: hop6 - M, y }, { x: lx + M, y }, { x: lx, y: y + M }] });
        laneTop = { x: lx, y: y + M };
      }
    } else if (near) {
      const y = a.y + OFF, v = { x: lx, y: nearRow6 + 1.0 };
      segs.push({ layer: "F.Cu", pts: [a, { x: a.x, y: y - M }, { x: a.x - M, y }, { x: lx + M, y }, { x: lx, y: y + M }, v] });
      rows.push({ y, xPad: a.x, xLane: lx, dir: 1 }); vias.push(v); laneTop = v;
    } else {
      const y = a.y - OFF, v = { x: lx - 0.4, y: nearRow6 + 2.4 };
      segs.push({ layer: "F.Cu", pts: [a, { x: a.x, y: EDGE_Y + M }, { x: a.x - M, y: EDGE_Y }, { x: hop6 + M, y: EDGE_Y }, { x: hop6, y: EDGE_Y + M }, { x: hop6, y: y - M }, { x: hop6 - M, y }, { x: lx - 0.4 + M, y }, { x: lx - 0.4, y: y + M }, v] });
      vias.push(v); laneTop = { x: lx, y: v.y + 0.4 };
      segs.push({ layer: "B.Cu", pts: [v, laneTop] });
    }
    // --- radio jack, bottom: rows run west; pin 1 round the left peg, pin 3 round the right peg and over the top ---
    const nb = near5(n);
    if (k < 2) {
      if (nb) {
        const y = q.y - OFF;
        segs.push({ layer: "B.Cu", pts: [q, { x: q.x, y: y + M }, { x: q.x - M, y }, { x: lx + M, y }, { x: lx, y: y - M }] });
        rows.push({ y, xPad: q.x, xLane: lx, dir: -1, xMin: 11.5 }); laneBot = { x: lx, y: y - M };
      } else {
        const y = q.y + OFF, sy = H - EDGE_Y;
        segs.push({ layer: "B.Cu", pts: [q, { x: q.x, y: sy - M }, { x: q.x - M, y: sy }, { x: hop5L + M, y: sy }, { x: hop5L, y: sy - M }, { x: hop5L, y: y + M }, { x: hop5L - M, y }, { x: lx + M, y }, { x: lx, y: y - M }] });
        laneBot = { x: lx, y: y - M };
      }
    } else if (nb) {
      const y = q.y - OFF, v = { x: lx, y: nearRow5 - 1.0 };
      segs.push({ layer: "F.Cu", pts: [q, { x: q.x, y: y + M }, { x: q.x - M, y }, { x: lx + M, y }, { x: lx, y: y - M }, v] });
      rows.push({ y, xPad: q.x, xLane: lx, dir: -1, xMin: 11.5 }); vias.push(v); laneBot = v;
    } else {
      // the far pin of pair 3/6: down to the edge strip, EAST, up over the
      // right peg, west across the top of the jack, down to a via beside the lane
      const top = nearRow5 - 6.0, sy = H - EDGE_Y, v = { x: lx - 0.4, y: nearRow5 - 3.4 };
      segs.push({ layer: "F.Cu", pts: [q, { x: q.x, y: sy - M }, { x: q.x + M, y: sy }, { x: hop5R - M, y: sy }, { x: hop5R, y: sy - M }, { x: hop5R, y: top + M }, { x: hop5R - M, y: top }, { x: lx - 0.4 + M, y: top }, { x: lx - 0.4, y: top + M }, v] });
      vias.push(v); laneBot = { x: lx, y: v.y - 0.4 };
      segs.push({ layer: "B.Cu", pts: [v, laneBot] });
    }
    // --- the lane: down past the jog, 45 degrees to the edge, the edge, 45 degrees back, up to the bottom jack.
    // Each track starts its run PITCH later than the one inside it, so the parallel diagonals stay 0.7 apart.
    const jt = o.topJogY + off(k), jb = o.botJogY - off(k), d = lx - mx;
    segs.push({ layer: "B.Cu", pts: [laneTop, { x: lx, y: jt }, { x: mx, y: jt + d }, { x: mx, y: jb - d }, { x: lx, y: jb }, laneBot] });
    return { n, k, segs, vias, near, rows };
  });
  // Trombones on the near track of each pair: bumps of depth h, top width w,
  // corners m, each adding about 2h - 4m(2 - sqrt2), on its rows between the
  // pad and the lane, away from the jack. Depth solved once from the result.
  const m = 0.4, w = 1.2, hMax = 4.5, step = w + 2 * m + 0.8;
  const total = (t: Tr) => t.segs.reduce((s, g) => s + len(g.pts), 0);
  const span = (r: Row) => Math.max(0, (r.xPad - M - 0.6) - Math.max(r.xLane + M + 0.6, r.xMin ?? 0));
  const bumps = (r: Row, nb: number, h: number): Point[] => {
    // from the pad side westward; bumps go away from the jack (dir 1: down, -1: up)
    const x0 = r.xPad - M - 0.6, y = r.y, out: Point[] = [];
    for (let i = 0; i < nb; i++) {
      const xa = x0 - i * step, xb = xa - (w + 2 * m);
      out.push({ x: xa, y }, { x: xa - m, y: y + r.dir * m }, { x: xa - m, y: y + r.dir * (h - m) }, { x: xa - 2 * m, y: y + r.dir * h }, { x: xb + 2 * m, y: y + r.dir * h }, { x: xb + m, y: y + r.dir * (h - m) }, { x: xb + m, y: y + r.dir * m }, { x: xb, y });
    }
    return out;
  };
  for (const pi of [0, 1]) {
    const [t, u] = [plan[2 * pi], plan[2 * pi + 1]];
    const short = t.near ? t : u, long = short === t ? u : t;
    const skew = total(long) - total(short);
    if (skew < 0.15) continue;
    const caps = short.rows.map((r) => Math.floor(span(r) / step));
    const perBump = (h: number) => 2 * h - 4 * m * (2 - Math.SQRT2);
    let nb = Math.max(1, Math.ceil(skew / perBump(hMax)));
    const room = caps.reduce((a, b) => a + b, 0);
    // the innermost lane (x 4.3 at the edge) can also meander east, 2.2 mm
    // deep, along the edge run: nothing sits on the back between it and the
    // fan header's pins at x 7.3
    const laneRoom = short.k === 3 ? 20 : 0, laneH = 2.2;
    if (nb > room) nb = room + Math.ceil((skew - room * perBump(hMax)) / perBump(laneH));   // the rest as shallower lane bumps
    if (nb > room + laneRoom) { console.log(`ethernet: ${short.n} needs ${nb} bumps, room for ${room + laneRoom}`); nb = room + laneRoom; }
    if (!nb) continue;
    const base = short.segs.map((g) => ({ layer: g.layer, pts: g.pts.slice() }));
    const vbumps = (x: number, y0: number, n: number, h: number): Point[] => {
      // down the lane from y0, bumps toward +x
      const out: Point[] = [];
      for (let i = 0; i < n; i++) {
        const ya = y0 + i * step, yb = ya + (w + 2 * m);
        out.push({ x, y: ya }, { x: x + m, y: ya + m }, { x: x + h - m, y: ya + m }, { x: x + h, y: ya + 2 * m }, { x: x + h, y: yb - 2 * m }, { x: x + h - m, y: yb - m }, { x: x + m, y: yb - m }, { x, y: yb });
      }
      return out;
    };
    const build = (hh: number) => {
      short.segs = base.map((g) => ({ layer: g.layer, pts: g.pts.slice() }));
      let left = nb;
      short.rows.forEach((row, ri) => {
        const n = Math.min(caps[ri], left); left -= n;
        if (!n) return;
        for (const g of short.segs) {
          const i = g.pts.findIndex((pt, j) => j + 1 < g.pts.length && Math.abs(pt.y - row.y) < 1e-6 && Math.abs(g.pts[j + 1].y - row.y) < 1e-6);
          if (i < 0) continue;
          g.pts.splice(i + 1, 0, ...bumps(row, n, hh));
          break;
        }
      });
      if (left > 0 && laneRoom) {
        // the edge run is the lane segment's 3rd..4th points (mx, jt+d) -> (mx, jb-d)
        const g = short.segs[short.segs.length - 1];
        const y0 = Math.max(g.pts[2].y + 6, 45); // below the first holder's locating hole at (7.5, 40)
        g.pts.splice(3, 0, ...vbumps(g.pts[2].x, y0, left, Math.min(hh, laneH)));
      }
    };
    let h = Math.min(hMax, (skew / nb + 4 * m * (2 - Math.SQRT2)) / 2);
    build(h);
    for (let it = 0; it < 3; it++) { h = Math.min(hMax, h + (total(long) - total(short)) / (2 * nb)); build(h); }
  }
  for (const t of plan) {
    for (const g of t.segs) for (let i = 1; i < g.pts.length; i++) board.tracks.push({ uuid: crypto.randomUUID(), layer: g.layer, width: W_ETH, start: g.pts[i - 1], end: g.pts[i], net: t.n });
    for (const v of t.vias) board.vias.push({ uuid: crypto.randomUUID(), at: v, size: 0.6, drill: 0.3, net: t.n });
  }
  const L = Object.fromEntries(plan.map((t) => [t.n, total(t)]));
  console.log(`ethernet: ${board.tracks.length} segments, ${board.vias.length} vias pre-routed; ${plan.map((t) => `${t.n} ${L[t.n].toFixed(1)}`).join(", ")}; skew 1/2 ${Math.abs(L.ETH_1 - L.ETH_2).toFixed(2)}, 3/6 ${Math.abs(L.ETH_3 - L.ETH_6).toFixed(2)}`);
}

// #region silkscreen
export type Silk = [text: string, x: number, y: number, size?: number, rotation?: number];
export function addSilk(board: Board, texts: Silk[]) {
  for (const [text, x, y, size = 1.2, rotation = 0] of texts) board.texts.push({ at: { x, y }, text, layer: "F.SilkS", size, thickness: 0.15, rotation });
}

// #region checks, pours, write, quick look
export function checkBoard(p: Prepared, W: number, H: number) {
  const { board, footprints, fpOf } = p;
  const rats = ratsnest(board, footprints);
  const drc = runDrc(board, footprints, rats.length);
  const overlaps = drc.filter((d) => d.rule === "overlap");
  const outside = board.footprints.filter((f) => { const r = rectOf(f, fpOf(f)); return r.x1 < -1.5 || r.y1 < -1.5 || r.x2 > W + 1.5 || r.y2 > H + 1.5; });
  console.log(`ratsnest ${rats.length}, overlaps ${overlaps.length}, off-board ${outside.map((f) => f.ref).join(",") || "none"}`);
  for (const o of overlaps.slice(0, 30)) console.log("  overlap:", o.message);
  return { rats, overlaps, outside };
}

export async function writeBoard(p: Prepared, project: string | undefined, placeOnly: boolean, hideRefs: string[] = []) {
  const { board, footprints, nl } = p;
  if (!placeOnly) {
    // loon's grid router is kept out of the file: it fans tracks into pads and
    // leaves every power net alone. Placement, the pre-routed pairs, nets and
    // pour outlines are the deliverable; Freerouting does the rest.
    const pours = planPours(board, nl, {
      nets: [
        // Ground on both sides. Rails go as tracks (net classes): a bounded
        // rail pour breaks into islands between the parts.
        { name: "GND", layer: "B.Cu", priority: 0 },
        { name: "GND", layer: "F.Cu", priority: 0 },
      ],
    });
    board.zones = pours.zones;
    console.log(pours.notes.join("; "));
  }
  if (!project) return;
  // The parser already normalised each land pattern to KiCad 9 and moved the
  // reference above the outline; the raw tree goes into the board as is.
  const raw: Record<string, unknown> = {};
  for (const [id, fp] of Object.entries(footprints)) if (fp.raw) raw[id] = fp.raw;
  await storage.writeFile(project, "board.loon.json", JSON.stringify(board, null, 2));
  const boxes = Object.fromEntries(Object.entries(footprints).map(([id, fp]) => [id, fp.bbox]));
  await storage.writeFile(project, "board.kicad_pcb", serializeBoard(board, raw, boxes, new Set(hideRefs)));
  await storage.writeFile(project, "board.kicad_pro", serializeProject(board, "board"));
  console.log(`wrote ${project}/board.*`);
}

// An SVG of the placement: courtyards, pads, refs, pre-routes, ratsnest.
export async function quickLook(p: Prepared, W: number, H: number, rats: ReturnType<typeof ratsnest>, path: string) {
  const { board, fpOf } = p;
  const S = 8;
  const o: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${(W + 10) * S}" height="${(H + 10) * S}" viewBox="-5 -5 ${W + 10} ${H + 10}" font-family="sans-serif">`,
    `<rect x="-5" y="-5" width="${W + 10}" height="${H + 10}" fill="#222"/>`, `<rect x="0" y="0" width="${W}" height="${H}" fill="#1c4a1c" stroke="#ff0" stroke-width="0.3"/>`];
  for (const f of board.footprints) {
    const fp = fpOf(f);
    const r = rectOf(f, fp);
    const col = f.side === "B" ? "#4aa3ff" : "#ffcc66";
    o.push(`<rect x="${r.x1}" y="${r.y1}" width="${r.x2 - r.x1}" height="${r.y2 - r.y1}" fill="none" stroke="${col}" stroke-width="0.15" stroke-dasharray="${f.side === "B" ? "0.6 0.4" : "none"}"/>`);
    for (const pad of fp?.pads ?? []) {
      const q = padWorld(f, pad.at);
      const sz = pad.type === "smd" ? Math.min(pad.size.w, pad.size.h) / 2 : (pad.drill ?? 1) / 2 + 0.4;
      o.push(`<circle cx="${q.x}" cy="${q.y}" r="${Math.max(0.25, sz)}" fill="${pad.type === "smd" ? (f.side === "B" ? "#3a7fd0" : "#e8b04a") : "#ccc"}"/>`);
    }
    const c = centreOf(f, fp);
    o.push(`<text x="${c.x}" y="${c.y + 0.5}" font-size="1.4" fill="#fff" text-anchor="middle">${f.ref}</text>`);
  }
  for (const t of board.tracks) o.push(`<line x1="${t.start.x}" y1="${t.start.y}" x2="${t.end.x}" y2="${t.end.y}" stroke="${t.layer === "F.Cu" ? "#ff5555" : "#5588ff"}" stroke-width="${t.width}" stroke-linecap="round" opacity="0.8"/>`);
  for (const v of board.vias) o.push(`<circle cx="${v.at.x}" cy="${v.at.y}" r="${v.size / 2}" fill="#ddd"/>`);
  for (const l of rats) o.push(`<line x1="${l.a.x}" y1="${l.a.y}" x2="${l.b.x}" y2="${l.b.y}" stroke="#fff" stroke-width="0.08" opacity="0.5"/>`);
  for (const t of board.texts) o.push(`<text x="${t.at.x}" y="${t.at.y}" font-size="${t.size}" fill="#eee" text-anchor="middle" transform="rotate(${-t.rotation} ${t.at.x} ${t.at.y})">${t.text}</text>`);
  o.push("</svg>");
  await Bun.write(path, o.join("\n"));
  console.log(`svg -> ${path}`);
}
