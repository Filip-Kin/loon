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
  const c = rot({ x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2 }, f.rotation);
  const m = f.side === "B" ? { x: -c.x, y: c.y } : c;
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
  const cc = box ? rot({ x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2 }, rotation) : { x: 0, y: 0 };
  const m = f.side === "B" ? { x: -cc.x, y: cc.y } : cc;
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

// #region Ethernet pairs, hand-routed along the left edge
// Freerouting keeps existing copper, so these four tracks are the pass-through
// as built. The RJ45 pins sit in two staggered rows 1.78 mm apart with 1.52 mm
// pads, so a track cannot pass between them: the pin nearer the board goes
// out below the jack on a row 1.3 mm off the pins; the pin nearer the edge
// goes straight to the edge strip (y 1.6 from the edge, over the jack's peg)
// and along it. Pair 1/2 runs on B.Cu, pair 3/6 on F.Cu, so the two rows on
// a layer never cross and no via is needed. Lanes: 0.3 mm tracks on 0.5 mm
// centres within a pair, the pairs 1 mm apart, between the corner hole and
// the jack. Corners are 45-degree mitres. The shorter track of each pair
// gets trombone bumps on its rows, away from the jack, until matched.
export function preRouteEthernet(p: Prepared, H: number, laneX0 = 8.0) {
  const { board, fpOf } = p;
  const padOf = (ref: string, net: string) => {
    const f = board.footprints.find((x) => x.ref === ref)!;
    const pad = fpOf(f).pads.find((q) => f.padNets[q.number] === net)!;
    return padWorld(f, pad.at);
  };
  const PAIRS: [string, string][] = [["ETH_1", "ETH_2"], ["ETH_3", "ETH_6"]];
  const LAYER = ["B.Cu", "F.Cu"];
  const W_ETH = 0.3, M = 0.8, OFF = 1.3, EDGE_Y = 1.6, PITCH = 0.5, PAIR_GAP = 1.0;
  const len = (pts: Point[]) => pts.slice(1).reduce((s, q, i) => s + Math.hypot(q.x - pts[i].x, q.y - pts[i].y), 0);
  const ys = (ref: string) => { const f = board.footprints.find((x) => x.ref === ref)!; const v = fpOf(f).pads.filter((q) => q.type === "thru_hole").map((q) => padWorld(f, q.at).y); return (Math.min(...v) + Math.max(...v)) / 2; };
  const mid6 = ys("J6"), mid5 = ys("J5");
  // the jack's peg nearest the lanes: the far-pin track hops over it
  const peg = (ref: string) => { const f = board.footprints.find((x) => x.ref === ref)!; const ps = fpOf(f).pads.filter((q) => q.type === "np_thru_hole").map((q) => ({ ...padWorld(f, q.at), r: (q.drill ?? 3) / 2 })); return ps.sort((u, v) => u.x - v.x)[0]; };
  const peg6 = peg("J6"), peg5 = peg("J5");
  type Tr = { n: string; layer: string; laneX: number; pts: Point[]; rowTop: number; rowBot: number; near: boolean; a: Point; q: Point; iTop: number; iBot: number };
  const plan: Tr[] = [];
  PAIRS.forEach((pair, pi) => pair.forEach((n, i) => {
    const laneX = laneX0 + pi * (PITCH + PAIR_GAP) + i * PITCH;
    const a = padOf("J6", n), q = padOf("J5", n);
    const near = a.y > mid6;                     // the pin further from the board edge
    const rowTop = near ? a.y + OFF : a.y - OFF;
    const rowBot = near ? q.y - OFF : q.y + OFF;
    // Near pin: stub to the row, row to the lane. Far pin: out to the edge
    // strip, along it past the peg, back down to the row, row to the lane.
    const hop6 = peg6 ? peg6.x - peg6.r - 0.6 : a.x - M, hop5 = peg5 ? peg5.x - peg5.r - 0.6 : q.x - M;
    const top: Point[] = near
      ? [a, { x: a.x, y: rowTop - M }, { x: a.x - M, y: rowTop }]
      : [a, { x: a.x, y: EDGE_Y + M }, { x: a.x - M, y: EDGE_Y }, { x: hop6 + M, y: EDGE_Y }, { x: hop6, y: EDGE_Y + M }, { x: hop6, y: rowTop - M }, { x: hop6 - M, y: rowTop }];
    const bot: Point[] = near
      ? [{ x: q.x - M, y: rowBot }, { x: q.x, y: rowBot - M }, q]
      : [{ x: hop5 - M, y: rowBot }, { x: hop5, y: rowBot + M }, { x: hop5, y: H - EDGE_Y - M }, { x: hop5 + M, y: H - EDGE_Y }, { x: q.x - M, y: H - EDGE_Y }, { x: q.x, y: H - EDGE_Y - M }, q];
    const pts: Point[] = [...top, { x: laneX + M, y: rowTop }, { x: laneX, y: rowTop + M }, { x: laneX, y: rowBot - M }, { x: laneX + M, y: rowBot }, ...bot];
    plan.push({ n, layer: LAYER[pi], laneX, pts, rowTop, rowBot, near, a, q, iTop: top.length - 1, iBot: top.length + 3 });
  }));
  // Trombones: bumps of depth h, top width w, corners m, each adding about
  // 2h - 4m(2 - sqrt2). The shorter track is the near-pin one; its rows have
  // room away from the jack. Bumps are spread over both rows, the depth is
  // solved once from the measured result.
  const m = 0.4, w = 1.2, hMax = 2.8, step = w + 2 * m + 0.8;
  const x0 = laneX0 + 2 * PITCH + PAIR_GAP + 1.4;   // right of every lane
  const bumps = (short: Tr, top: boolean, nb: number, h: number): Point[] => {
    const y = top ? short.rowTop : short.rowBot, dir = top ? 1 : -1, padX = top ? short.a.x : short.q.x;
    const row: Point[] = [{ x: short.laneX + M, y }];
    for (let i = 0; i < nb; i++) {
      const xa = x0 + i * step, xb = xa + w + 2 * m;
      row.push({ x: xa, y }, { x: xa + m, y: y + dir * m }, { x: xa + m, y: y + dir * (h - m) }, { x: xa + 2 * m, y: y + dir * h }, { x: xb - 2 * m, y: y + dir * h }, { x: xb - m, y: y + dir * (h - m) }, { x: xb - m, y: y + dir * m }, { x: xb, y });
    }
    row.push({ x: padX - M, y });
    return row;
  };
  for (const pair of PAIRS) {
    const [t, u] = pair.map((n) => plan.find((x) => x.n === n)!);
    const short = t.near ? t : u, long = short === t ? u : t;
    const base = short.pts.slice();
    const skew = len(long.pts) - len(base);
    if (skew < 0.15) continue;
    const cap = Math.max(0, Math.floor((Math.min(short.a.x, short.q.x) - M - 0.3 - x0) / step)); // bumps that fit on one row
    const perBump = (h: number) => 2 * h - 4 * m * (2 - Math.SQRT2);
    let nb = Math.max(1, Math.ceil(skew / perBump(hMax)));
    if (nb > 2 * cap) { console.log(`ethernet: ${short.n} needs ${nb} bumps, room for ${2 * cap}`); nb = 2 * cap; }
    const nTop = Math.min(cap, nb), nBot = nb - nTop;
    let h = (skew / nb + 4 * m * (2 - Math.SQRT2)) / 2;
    // the row is two points: (iTop, iTop+1) at J6 and (iBot, iBot+1) at J5
    const build = (hh: number) => { const pts = base.slice(); if (nBot) pts.splice(short.iBot, 2, ...bumps(short, false, nBot, hh)); if (nTop) pts.splice(short.iTop, 2, ...bumps(short, true, nTop, hh).reverse()); return pts; };
    let pts = build(h);
    h += (len(long.pts) - len(pts)) / (2 * nb); // one correction for the mitre geometry
    pts = build(h);
    short.pts = pts;
  }
  for (const t of plan) for (let i = 1; i < t.pts.length; i++) board.tracks.push({ uuid: crypto.randomUUID(), layer: t.layer, width: W_ETH, start: t.pts[i - 1], end: t.pts[i], net: t.n });
  const L = Object.fromEntries(plan.map((t) => [t.n, len(t.pts)]));
  console.log(`ethernet: ${board.tracks.length} segments pre-routed, no vias; ${plan.map((t) => `${t.n} ${L[t.n].toFixed(1)} ${t.layer}`).join(", ")}; skew 1/2 ${Math.abs(L.ETH_1 - L.ETH_2).toFixed(2)}, 3/6 ${Math.abs(L.ETH_3 - L.ETH_6).toFixed(2)}`);
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

export async function writeBoard(p: Prepared, project: string | undefined, placeOnly: boolean) {
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
  await storage.writeFile(project, "board.kicad_pcb", serializeBoard(board, raw));
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
