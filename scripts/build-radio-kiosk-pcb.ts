// FRC radio kiosk v2, stage four: the board.
//
// 90 x 120 mm, two layers, cells on the back. Ports by purpose on three edges
// (Filip's rule so a volunteer reads the box without a manual):
//   TOP    = laptop side: RJ45 to laptop, laptop DC out, USB-C serial
//   RIGHT  = power in: USB-C PD trigger cable, DC jack
//   BOTTOM = radio: RJ45 to radio
//
// loon's autoPlace lays each circuit out as a cluster; this script then moves
// those clusters into a floorplan and pins the connectors to their edges.
//
// Run: bun run scripts/build-radio-kiosk-pcb.ts <project> [--place-only]
import { library } from "../server/src/services/library";
import { getFootprints } from "../server/src/services/footprints";
import { storage } from "../server/src/services/storage";
import { buildRadioKiosk } from "./build-radio-kiosk";
import { buildNetlist } from "@loon/shared/netlist";
import { generateBoard, ratsnest, runDrc, padWorld } from "@loon/shared/pcbgen";
import { autoroute } from "@loon/shared/autoroute";
import { planPours } from "@loon/shared/pour";
import { serializeBoard, serializeProject } from "@loon/shared/kicad-pcb";
import { OSHPARK_2LAYER, rectOutline, type Board, type PlacedFootprint } from "@loon/shared/board";
import type { Footprint } from "@loon/shared/footprint";
import type { Point } from "@loon/shared/schematic";

const W = 100;
const H = 130;
const SX = 1, SY = 1; // targets are in board mm
const sc = (p: Point): Point => ({ x: Math.round(p.x * SX), y: Math.round(p.y * SY) });
const HOLE = "MountingHole:MountingHole_3.2mm_M3";

// #region floorplan
// Each group is a circuit from the schematic script, named by its refs. The
// target is where its centre goes. Connectors get an edge and a rotation of
// their own below.
type Group = { name: string; refs: RegExp[]; at: Point; side?: "F" | "B" };
const GROUPS: Group[] = [
  // Targets, not positions: the placer takes the nearest free spot. The four
  // cell holders lie across the back (y 21-65), so their pins come through on
  // two rows, y ~24 and y ~62; the front bands are above, between and below.
  // The left side is the quiet side: the Ethernet pass-through runs from J6
  // to J5 down a lane at x 24-30, with only the battery switch, bulk caps and
  // fan driver beside it. Every switcher is on the right half.
  { name: "usb", refs: [/^J10$/], at: { x: 50, y: 14 } },
  { name: "fan", refs: [/^D32$/, /^Q30$/, /^R10[1456]$/, /^C113$/], at: { x: 13, y: 91 } },
  { name: "mcu", refs: [/^U40$/, /^C13[0-6]$/, /^R11[12]$/, /^SW[12]$/, /^R26$/, /^R100$/, /^U30$/, /^C110$/, /^R103$/], at: { x: 48, y: 35 } },
  { name: "pd", refs: [/^U50$/, /^R12[01]$/, /^C140$/, /^C111$/], at: { x: 88, y: 40 } },
  { name: "in_usb", refs: [/^D1$/, /^R93$/, /^U41$/, /^C115$/, /^U1$/, /^Q1$/, /^C1$/], at: { x: 72, y: 36 } },
  { name: "vin", refs: [/^C9[01]$/, /^R9[01]$/], at: { x: 66, y: 49 } },
  { name: "in_dc", refs: [/^D2$/, /^U2$/, /^Q2$/, /^C2$/, /^R9[45]$/], at: { x: 48, y: 52 } },
  { name: "backup", refs: [/^F1$/, /^Q8$/, /^R8[0-9]$/, /^Q9$/, /^Q1[01]$/, /^U10$/, /^C99$/], at: { x: 13, y: 40 } },
  { name: "bulk", refs: [/^C9[78]$/], at: { x: 13, y: 76 } },
  { name: "port", refs: [/^D22$/, /^C112$/], at: { x: 13, y: 108 } },
  { name: "efuse", refs: [/^U21$/, /^R6[0-3]$/, /^C6[0-2]$/, /^Q13$/], at: { x: 85, y: 55 } },
  { name: "buck5", refs: [/^U5$/, /^C5[0-7]$/, /^R5[01]$/, /^L5$/], at: { x: 84, y: 112 } },
  { name: "boost", refs: [/^U20$/, /^Q20$/, /^L20$/, /^D2[01]$/, /^R2[0-5]$/, /^C2[0-5]$/], at: { x: 46, y: 81 } },
  { name: "buck15", refs: [/^U4$/, /^C4[0-7]$/, /^R4[01]$/, /^L4$/, /^R92$/, /^R9[6-9]$/, /^U4[23]$/, /^C11[678]$/, /^D40$/, /^U7$/, /^Q7$/, /^C7$/], at: { x: 72, y: 81 } },
  { name: "buck12", refs: [/^U3$/, /^C3[0-7]$/, /^R3[01]$/, /^L3$/, /^U6$/, /^Q6$/, /^C6$/], at: { x: 40, y: 112 } },
  { name: "pse", refs: [/^U22$/, /^R7[0-9]$/, /^C7[01]$/, /^D7[01]$/, /^Q22$/], at: { x: 62, y: 111 } },
  { name: "ntc", refs: [/^RT1$/, /^R107$/, /^C114$/], at: { x: 90, y: 80 } },
  { name: "cells", refs: [/^BT[1-4]$/], at: { x: 52, y: 43 }, side: "B" },
];

// Connectors: centre, rotation, and which edge they face. Rotation is applied
// after the group move so the jack opening points off the board.
const CONNECTORS: { ref: string; at: Point; face: "N" | "E" | "S" | "W"; rotation?: number }[] = [
  { ref: "J9", at: { x: 68, y: 5 }, face: "N", rotation: 90 }, // SWD, pins along the edge
  { ref: "J11", at: { x: 82, y: 5 }, face: "N", rotation: 90 }, // UART, pins along the edge
  { ref: "J8", at: { x: 13, y: 100 }, face: "W", rotation: 0 }, // fan (internal), left column
  // Side-emitting LEDs at the wall, beside the ports they describe. Their
  // rotation is a guess until the lens direction is checked in KiCad's 3D view.
  { ref: "D30", at: { x: 98, y: 48 }, face: "E", rotation: 90 }, // power LED between J2 and J1
  { ref: "D31", at: { x: 30, y: 128 }, face: "S", rotation: 0 }, // radio LED beside J5
];

// Jacks sit with their front face at the board edge, opening outward. Each
// land pattern says which of its axes is the front (from its outline: the RJ45
// body runs to +Y, the barrel jack to +X, the USB-C receptacles to +Y).
const FLUSH: { ref?: string; libMatch?: RegExp; edge: "N" | "E" | "S" | "W"; along: number; front: "+x" | "+y"; overhang: number }[] = [
  { ref: "J6", edge: "N", along: 16, front: "+y", overhang: 0.8 }, // laptop RJ45
  { ref: "J3", edge: "N", along: 32, front: "+x", overhang: 0 }, // laptop DC out
  { libMatch: /USB_C_Receptacle_HRO|USB_C_Receptacle_GCT/, edge: "N", along: 50, front: "+y", overhang: 0.8 }, // serial USB-C
  { ref: "J1", edge: "E", along: 28, front: "+y", overhang: 0.8 }, // USB-C PD in
  { ref: "J2", edge: "E", along: 68, front: "+x", overhang: 0 }, // DC in
  { ref: "J5", edge: "S", along: 16, front: "+y", overhang: 0.8 }, // radio RJ45
];
// Rotation that turns a footprint's front axis toward an edge (loon's rotation sense).
const FRONT_ROT: Record<"+x" | "+y", Record<"N" | "E" | "S" | "W", number>> = {
  "+y": { N: 180, E: 270, S: 0, W: 90 },
  "+x": { N: 270, E: 0, S: 90, W: 180 },
};

// #region helpers
function sizeOf(fp?: Footprint, rotation = 0) {
  if (!fp) return { w: 5, h: 5 };
  const box = fp.courtyard ?? fp.bbox;
  const w = Math.max(1, box.max.x - box.min.x, fp.bbox.max.x - fp.bbox.min.x);
  const h = Math.max(1, box.max.y - box.min.y, fp.bbox.max.y - fp.bbox.min.y);
  const turned = Math.abs((((rotation % 180) + 180) % 180) - 90) < 1;
  return turned ? { w: h, h: w } : { w, h };
}
function rot(p: Point, deg: number): Point {
  const r = (deg * Math.PI) / 180;
  return { x: p.x * Math.cos(r) - p.y * Math.sin(r), y: p.x * Math.sin(r) + p.y * Math.cos(r) };
}
// Courtyard centre in board coordinates for a placed footprint.
function centreOf(f: PlacedFootprint, fp?: Footprint): Point {
  const box = fp?.courtyard ?? fp?.bbox;
  if (!box) return f.at;
  const c = rot({ x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2 }, f.rotation);
  const m = f.side === "B" ? { x: -c.x, y: c.y } : c;
  return { x: f.at.x + m.x, y: f.at.y + m.y };
}
function rectOf(f: PlacedFootprint, fp?: Footprint) {
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
function faceRotation(fp: Footprint | undefined, normal: Point): number {
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
const NORMAL = { N: { x: 0, y: -1 }, E: { x: 1, y: 0 }, S: { x: 0, y: 1 }, W: { x: -1, y: 0 } };

// #region build
const project = process.argv.slice(2).find((a) => !a.startsWith("--"));
const placeOnly = process.argv.includes("--place-only");
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

// Module parts carry a blockId; the USB-C block joins the usb group.
const groupOf = new Map<string, Group>();
const usbBlock = board.footprints.find((f) => /USB_C_Receptacle/.test(f.libId))?.blockId;
const ldoBlock = board.footprints.find((f) => /AP2112K|SOT-23-5/.test(f.libId) && /AP2112/i.test(f.value))?.blockId;
for (const f of board.footprints) {
  const g = GROUPS.find((g) => g.refs.some((r) => r.test(f.ref)));
  if (g) groupOf.set(f.ref, g);
  else if (f.blockId && f.blockId === usbBlock) groupOf.set(f.ref, GROUPS.find((g) => g.name === "usb")!);
  else if (f.blockId && f.blockId === ldoBlock) groupOf.set(f.ref, GROUPS.find((g) => g.name === "buck5")!);
}
const unassigned = board.footprints.filter((f) => !groupOf.has(f.ref) && !/^H\d+$/.test(f.ref)).map((f) => `${f.ref}(${f.blockId ?? "-"})`);
if (unassigned.length) console.log("unassigned:", unassigned.join(" "));

// #region fixed parts first: connectors, cells, holes
const connectorRefs = new Set<string>([...CONNECTORS.map((c) => c.ref)]);
const placeAtCentre = (f: PlacedFootprint, centre: Point, rotation: number) => {
  const fp = fpOf(f);
  f.rotation = rotation;
  const box = fp?.courtyard ?? fp?.bbox;
  const cc = box ? rot({ x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2 }, rotation) : { x: 0, y: 0 };
  const m = f.side === "B" ? { x: -cc.x, y: cc.y } : cc;
  f.at = { x: +(centre.x - m.x).toFixed(2), y: +(centre.y - m.y).toFixed(2) };
};
for (const c of CONNECTORS) {
  const f = board.footprints.find((x) => x.ref === c.ref);
  if (!f) { console.log(`no connector ${c.ref}`); continue; }
  placeAtCentre(f, sc(c.at), c.rotation ?? faceRotation(fpOf(f), NORMAL[c.face]));
}
for (const c of FLUSH) {
  const f = c.ref ? board.footprints.find((x) => x.ref === c.ref) : board.footprints.find((x) => c.libMatch!.test(x.libId) && !connectorRefs.has(x.ref));
  if (!f) { console.log(`no flush part for ${c.ref ?? c.libMatch}`); continue; }
  const fp = fpOf(f);
  const box = fp.bbox;
  const d = c.front === "+y" ? box.max.y : box.max.x; // front face distance from the origin
  f.rotation = FRONT_ROT[c.front][c.edge];
  const o = c.overhang;
  if (c.edge === "N") f.at = { x: c.along, y: +(d - o).toFixed(2) };
  if (c.edge === "S") f.at = { x: c.along, y: +(H - d + o).toFixed(2) };
  if (c.edge === "E") f.at = { x: +(W - d + o).toFixed(2), y: c.along };
  if (c.edge === "W") f.at = { x: +(d - o).toFixed(2), y: c.along };
  connectorRefs.add(f.ref);
}
// Cells: 2 x 2 on the back, long axis along Y, between the top and bottom
// connectors' pins.
const cellPads: Point[] = [];
{
  const cells = board.footprints.filter((f) => /^BT[1-4]$/.test(f.ref));
  const s0 = sizeOf(fpOf(cells[0]), 0);
  const long = Math.max(s0.w, s0.h), short = Math.min(s0.w, s0.h);
  const r = s0.w >= s0.h ? 90 : 0; // long axis along Y
  const cx = 52, cy = 43, gap = 2;
  const spots = [0, 1, 2, 3].map((i) => ({ x: cx + (i - 1.5) * (short + gap), y: cy }));
  // Alternate the orientation so + of one cell sits beside - of the next and
  // the series links are short. (Which end is + is checked on the real part.)
  cells.forEach((f, i) => { f.side = "B"; placeAtCentre(f, spots[i], (r + (i % 2 ? 180 : 0)) % 360); });
  for (const f of cells) for (const pad of fpOf(f).pads) if (pad.type === "thru_hole" || pad.type === "np_thru_hole") cellPads.push(padWorld(f, pad.at));
  console.log(`cells: ${long.toFixed(1)} x ${short.toFixed(1)} mm each, 1 x 4 at (${cx}, ${cy}) on B; pads come through at ${cellPads.map((p) => `(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(" ")}`);
}
board.outline = rectOutline(0, 0, W, H);
const holes = board.footprints.filter((f) => /^H\d+$/.test(f.ref));
const corners = [{ x: 4, y: 4 }, { x: W - 4, y: 4 }, { x: 4, y: H - 4 }, { x: W - 4, y: H - 4 }];
holes.forEach((h, i) => { if (corners[i]) h.at = corners[i]; });

// #region pack and place groups
// Each group is shelf-packed into a block (biggest parts first, rows no wider
// than its budget). The block then takes the nearest free spot to its target:
// free of other blocks, connectors, holes, the cell pads, and the board edge.
type R = { x1: number; y1: number; x2: number; y2: number };
const taken: R[] = [];
const EDGE = 2;
for (const ref of connectorRefs) { const f = board.footprints.find((x) => x.ref === ref); if (f) taken.push(rectOf(f, fpOf(f))); }
for (const h of holes) taken.push({ x1: h.at.x - 3.5, y1: h.at.y - 3.5, x2: h.at.x + 3.5, y2: h.at.y + 3.5 });
for (const p of cellPads) taken.push({ x1: p.x - 2, y1: p.y - 2, x2: p.x + 2, y2: p.y + 2 });
// Ethernet pass-through lane, J6 to J5: nothing else goes here.
taken.push({ x1: 24, y1: 18, x2: 30, y2: 112 });
const hits = (r: R) => taken.some((t) => r.x1 < t.x2 && r.x2 > t.x1 && r.y1 < t.y2 && r.y2 > t.y1);
const GAP = 0.6;
const WIDTH: Record<string, number> = { mcu: 28, usb: 14, in_usb: 18, in_dc: 20, pd: 12, vin: 14, buck12: 18, bulk: 14, buck15: 22, buck5: 16, ntc: 8, fan: 12, backup: 20, boost: 30, efuse: 20, pse: 24, port: 8 };
for (const g of GROUPS) {
  if (g.name === "cells") continue;
  const members = board.footprints.filter((f) => groupOf.get(f.ref) === g && !connectorRefs.has(f.ref) && !/USB_C_Receptacle/.test(f.libId));
  if (!members.length) continue;
  members.sort((a, b) => { const sa = sizeOf(fpOf(a)), sb = sizeOf(fpOf(b)); return sb.w * sb.h - sa.w * sa.h; });
  const budget = WIDTH[g.name] ?? 24;
  let x = 0, y = 0, rowH = 0, maxX = 0;
  const pos = new Map<string, { x: number; y: number }>();
  for (const f of members) {
    f.rotation = 0;
    const sz = sizeOf(fpOf(f));
    if (x > 0 && x + sz.w > budget) { x = 0; y += rowH + GAP; rowH = 0; }
    pos.set(f.ref, { x: x + sz.w / 2, y: y + sz.h / 2 });
    x += sz.w + GAP; rowH = Math.max(rowH, sz.h); maxX = Math.max(maxX, x - GAP);
  }
  const bw = maxX, bh = y + rowH;
  // nearest legal centre to the target, on a 1 mm grid
  let best: Point | undefined;
  for (let rad = 0; rad <= 70 && !best; rad += 1) {
    const cands: Point[] = [];
    const t = sc(g.at);
    for (let dx = -rad; dx <= rad; dx++) for (const dy of rad === 0 ? [0] : [-rad, rad]) cands.push({ x: t.x + dx, y: t.y + dy });
    for (let dy = -rad + 1; dy <= rad - 1; dy++) for (const dx of [-rad, rad]) cands.push({ x: t.x + dx, y: t.y + dy });
    cands.sort((a, b) => Math.hypot(a.x - t.x, a.y - t.y) - Math.hypot(b.x - t.x, b.y - t.y));
    for (const c of cands) {
      const r: R = { x1: c.x - bw / 2 - 0.5, y1: c.y - bh / 2 - 0.5, x2: c.x + bw / 2 + 0.5, y2: c.y + bh / 2 + 0.5 };
      if (r.x1 < EDGE || r.y1 < EDGE || r.x2 > W - EDGE || r.y2 > H - EDGE) continue;
      if (hits(r)) continue;
      best = c; taken.push(r); break;
    }
  }
  if (!best) { console.log(`NO ROOM for ${g.name} (${bw.toFixed(0)} x ${bh.toFixed(0)})`); best = sc(g.at); }
  if (process.env.PLACE_DEBUG === g.name) {
    const t = sc(g.at);
    const r: R = { x1: t.x - bw / 2 - 0.5, y1: t.y - bh / 2 - 0.5, x2: t.x + bw / 2 + 0.5, y2: t.y + bh / 2 + 0.5 };
    console.log(`debug ${g.name} wants ${JSON.stringify(r)}; blockers:`, taken.filter((q) => r.x1 < q.x2 && r.x2 > q.x1 && r.y1 < q.y2 && r.y2 > q.y1).map((q) => JSON.stringify(q)).join(" "));
  }
  for (const f of members) {
    const p = pos.get(f.ref)!;
    const fp = fpOf(f);
    const box = fp?.courtyard ?? fp?.bbox;
    const cc = box ? { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2 } : { x: 0, y: 0 };
    f.at = { x: +(best.x - bw / 2 + p.x - cc.x).toFixed(2), y: +(best.y - bh / 2 + p.y - cc.y).toFixed(2) };
  }
  const t = sc(g.at);
  const moved = Math.hypot(best.x - t.x, best.y - t.y);
  console.log(`${g.name.padEnd(8)} ${members.length.toString().padStart(3)} parts  ${bw.toFixed(0).padStart(2)} x ${bh.toFixed(0).padStart(2)} mm  at (${best.x}, ${best.y})${moved > 0.5 ? `  moved ${moved.toFixed(0)} mm from (${t.x}, ${t.y})` : ""}`);
}

// #region checks
const rats = ratsnest(board, footprints);
const drc = runDrc(board, footprints, rats.length);
const overlaps = drc.filter((d) => d.rule === "overlap");
const outside = board.footprints.filter((f) => { const r = rectOf(f, fpOf(f)); return r.x1 < -1.5 || r.y1 < -1.5 || r.x2 > W + 1.5 || r.y2 > H + 1.5; });
console.log(`ratsnest ${rats.length}, overlaps ${overlaps.length}, off-board ${outside.map((f) => f.ref).join(",") || "none"}`);
for (const o of overlaps.slice(0, 30)) console.log("  overlap:", o.message);

// #region copper
if (!placeOnly) {
  const power = (n: string) => /^(\+|GND$|VIN|PORT_P|PORT_N|PACK|LAPTOP_OUT|\+15V6|FAN_N)/.test(n);
  // loon's grid router is kept out of the file: it fans tracks into pads and
  // leaves every power net alone, so the result is noise a KiCad user has to
  // delete first. Placement, nets and pour outlines are the deliverable.
  void autoroute; void power;
  board.tracks = [];
  board.vias = [];
  const pours = planPours(board, nl, {
    nets: [
      { name: "GND", layer: "B.Cu", priority: 0 },
      { name: "GND", layer: "F.Cu", priority: 0 },
      { name: "+12V", layer: "F.Cu", priority: 2, bounds: { x1: 4, y1: 30, x2: 60, y2: 100 } },
      { name: "VIN", layer: "F.Cu", priority: 2, bounds: { x1: 60, y1: 20, x2: 88, y2: 70 } },
    ],
  });
  board.zones = pours.zones;
  console.log(pours.notes.join("; "));
}

// #region write
if (project) {
  // Reference designators sit just above the part's outline, not on it, so
  // they stay readable with the part fitted. Set on the land pattern, so every
  // instance of a footprint gets the same offset (KiCad rotates it with the part).
  const raw: Record<string, any> = {};
  for (const [id, fp] of Object.entries(footprints)) {
    if (!fp.raw) continue;
    const r = structuredClone(fp.raw) as any;
    // easyeda2kicad writes the KiCad 5 "module" form; a KiCad 9 board wants
    // "footprint" and has no use for tedit.
    if (r.items?.[0]?.value === "module") r.items[0] = { kind: "atom", value: "footprint" };
    r.items = (r.items ?? []).filter((it: any) => !(it.kind === "list" && it.items?.[0]?.value === "tedit"));
    r.items = r.items.filter((it: any) => !(it.kind === "list" && it.items?.[0]?.value === "property" && !it.items.some((x: any) => x.kind === "list" && x.items?.[0]?.value === "at")));
    for (const it of r.items) {
      if (it.kind !== "list" || !/^fp_(line|circle|arc|rect|poly)$/.test(it.items?.[0]?.value ?? "")) continue;
      if (it.items[0].value === "fp_arc") {
        const ai = it.items.findIndex((x: any) => x.kind === "list" && x.items?.[0]?.value === "angle");
        if (ai >= 0) {
          const g = (n: string) => it.items.find((x: any) => x.kind === "list" && x.items?.[0]?.value === n);
          const c = g("start"), e = g("end");
          const cx = +c.items[1].value, cy = +c.items[2].value, ex = +e.items[1].value, ey = +e.items[2].value;
          const ang = (+it.items[ai].items[1].value * Math.PI) / 180;
          const rotp = (t: number) => ({ x: cx + (ex - cx) * Math.cos(t) - (ey - cy) * Math.sin(t), y: cy + (ex - cx) * Math.sin(t) + (ey - cy) * Math.cos(t) });
          const m = rotp(ang / 2), p2 = rotp(ang);
          const pt = (n: string, q: { x: number; y: number }) => ({ kind: "list", items: [{ kind: "atom", value: n }, { kind: "atom", value: q.x.toFixed(3) }, { kind: "atom", value: q.y.toFixed(3) }] });
          it.items = it.items.filter((x: any) => !(x.kind === "list" && ["start", "end", "angle"].includes(x.items?.[0]?.value)));
          it.items.splice(1, 0, pt("start", { x: ex, y: ey }), pt("mid", m), pt("end", p2));
        }
      }
      const wi = it.items.findIndex((x: any) => x.kind === "list" && x.items?.[0]?.value === "width");
      if (wi >= 0) {
        const w = it.items[wi].items[1];
        it.items[wi] = { kind: "list", items: [{ kind: "atom", value: "stroke" }, { kind: "list", items: [{ kind: "atom", value: "width" }, w] }, { kind: "list", items: [{ kind: "atom", value: "type" }, { kind: "atom", value: "solid" }] }] };
      }
    }
    const yAbove = +(fp.bbox.min.y - 0.9).toFixed(2);
    const atNode = { kind: "list", items: [{ kind: "atom", value: "at" }, { kind: "atom", value: "0" }, { kind: "atom", value: String(yAbove) }] };
    for (const it of r.items ?? []) {
      if (it.kind !== "list") continue;
      const head = it.items?.[0]?.value;
      const isRef = (head === "fp_text" && it.items?.[1]?.value === "reference") || (head === "property" && it.items?.[1]?.value === "Reference");
      if (!isRef) continue;
      const i = it.items.findIndex((x: any) => x.kind === "list" && x.items?.[0]?.value === "at");
      if (i >= 0) it.items[i] = atNode; else it.items.push(atNode);
    }
    raw[id] = r;
  }
  await storage.writeFile(project, "board.loon.json", JSON.stringify(board, null, 2));
  await storage.writeFile(project, "board.kicad_pcb", serializeBoard(board, raw));
  await storage.writeFile(project, "board.kicad_pro", serializeProject(board, "board"));
  console.log(`wrote ${project}/board.*`);
}

// #region quick look: an SVG of the placement (courtyards, pads, refs, ratsnest)
{
  const S = 8;
  const o: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${(W + 10) * S}" height="${(H + 10) * S}" viewBox="-5 -5 ${W + 10} ${H + 10}" font-family="sans-serif">`,
    `<rect x="-5" y="-5" width="${W + 10}" height="${H + 10}" fill="#222"/>`, `<rect x="0" y="0" width="${W}" height="${H}" fill="#1c4a1c" stroke="#ff0" stroke-width="0.3"/>`];
  for (const f of board.footprints) {
    const fp = fpOf(f);
    const r = rectOf(f, fp);
    const col = f.side === "B" ? "#4aa3ff" : "#ffcc66";
    o.push(`<rect x="${r.x1}" y="${r.y1}" width="${r.x2 - r.x1}" height="${r.y2 - r.y1}" fill="none" stroke="${col}" stroke-width="0.15" stroke-dasharray="${f.side === "B" ? "0.6 0.4" : "none"}"/>`);
    for (const pad of fp?.pads ?? []) {
      const p = padWorld(f, pad.at);
      const sz = pad.type === "smd" ? Math.min(pad.size.w, pad.size.h) / 2 : (pad.drill ?? 1) / 2 + 0.4;
      o.push(`<circle cx="${p.x}" cy="${p.y}" r="${Math.max(0.25, sz)}" fill="${pad.type === "smd" ? (f.side === "B" ? "#3a7fd0" : "#e8b04a") : "#ccc"}"/>`);
    }
    const c = centreOf(f, fp);
    o.push(`<text x="${c.x}" y="${c.y + 0.5}" font-size="1.4" fill="#fff" text-anchor="middle">${f.ref}</text>`);
  }
  for (const t of board.tracks) o.push(`<line x1="${t.start.x}" y1="${t.start.y}" x2="${t.end.x}" y2="${t.end.y}" stroke="${t.layer === "F.Cu" ? "#ff5555" : "#5588ff"}" stroke-width="${t.width}" stroke-linecap="round" opacity="0.8"/>`);
  for (const v of board.vias) o.push(`<circle cx="${v.at.x}" cy="${v.at.y}" r="${v.size / 2}" fill="#ddd"/>`);
  for (const l of rats) o.push(`<line x1="${l.a.x}" y1="${l.a.y}" x2="${l.b.x}" y2="${l.b.y}" stroke="#fff" stroke-width="0.08" opacity="0.5"/>`);
  o.push("</svg>");
  await Bun.write("/home/filip/tmp/radio-kiosk-v2-pcb.svg", o.join("\n"));
  console.log("svg -> /home/filip/tmp/radio-kiosk-v2-pcb.svg");
}
