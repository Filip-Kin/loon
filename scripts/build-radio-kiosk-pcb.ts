// FRC radio kiosk v2, stage four: the board.
//
// 100 x 130 mm, two layers, cells on the back. Ports by purpose on three edges
// (Filip's rule so a volunteer reads the box without a manual):
//   TOP    = laptop side: RJ45 to laptop, laptop DC out, USB-C serial
//   RIGHT  = power in: USB-C PD trigger cable, DC jack
//   BOTTOM = radio: RJ45 to radio
//
// Each circuit is shelf-packed into a block and the block takes the nearest
// free spot to its target. v2b (build-radio-kiosk-pcb-v2b.ts) places the
// same parts by hand on a smaller board.
//
// Run: LOON_FS_DIR=<loon-projects> bun run scripts/build-radio-kiosk-pcb.ts Radio_Kiosk_v2 [--place-only]
import { prepareBoard, placeConnectors, placeCells, placeHoles, preRouteEthernet, addSilk, checkBoard, writeBoard, quickLook, rectOf, sizeOf, hits, type Connector, type Flush, type R, type Silk } from "./radio-kiosk-board";
import type { Point } from "@loon/shared/schematic";

const W = 100;
const H = 130;

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
  // to J5 as two differential pairs on the back along the left edge (x 2-5),
  // with only the battery switch, bulk caps and fan driver beside it. Every
  // switcher is on the right half.
  { name: "usb", refs: [/^J10$/], at: { x: 50, y: 14 } },
  { name: "fan", refs: [/^D32$/, /^Q30$/, /^R10[1456]$/, /^C113$/], at: { x: 16, y: 94 } },
  { name: "mcu", refs: [/^U40$/, /^C13[0-6]$/, /^R11[12]$/, /^SW[12]$/, /^R26$/, /^R100$/, /^U30$/, /^C110$/, /^R103$/], at: { x: 48, y: 35 } },
  { name: "pd", refs: [/^U50$/, /^R12[01]$/, /^C140$/, /^C111$/], at: { x: 88, y: 40 } },
  { name: "in_usb", refs: [/^D1$/, /^R93$/, /^U41$/, /^C115$/, /^U1$/, /^Q1$/, /^C1$/], at: { x: 72, y: 36 } },
  { name: "vin", refs: [/^C9[01]$/, /^R9[01]$/], at: { x: 66, y: 49 } },
  { name: "in_dc", refs: [/^D2$/, /^U2$/, /^Q2$/, /^C2$/, /^R9[45]$/], at: { x: 48, y: 52 } },
  { name: "backup", refs: [/^F1$/, /^Q8$/, /^R8[0-9]$/, /^Q9$/, /^Q1[01]$/, /^U10$/, /^C99$/], at: { x: 17, y: 40 } },
  { name: "bulk", refs: [/^C9[78]$/], at: { x: 16, y: 76 } },
  { name: "port", refs: [/^D22$/, /^C112$/], at: { x: 27, y: 100 } },
  { name: "efuse", refs: [/^U21$/, /^R6[0-3]$/, /^C6[0-2]$/, /^Q13$/], at: { x: 85, y: 55 } },
  { name: "buck5", refs: [/^U5$/, /^C5[0-7]$/, /^R5[01]$/, /^L5$/], at: { x: 83, y: 115 } },
  { name: "boost", refs: [/^U20$/, /^Q20$/, /^L20$/, /^D2[01]$/, /^R2[0-5]$/, /^C2[0-5]$/], at: { x: 44, y: 81 } },
  { name: "buck15", refs: [/^U4$/, /^C4[0-7]$/, /^R4[01]$/, /^L4$/, /^R92$/, /^R9[6-9]$/, /^U4[23]$/, /^C11[678]$/, /^D40$/, /^U7$/, /^Q7$/, /^C7$/], at: { x: 83, y: 88 } },
  { name: "buck12", refs: [/^U3$/, /^C3[0-7]$/, /^R3[01]$/, /^L3$/, /^U6$/, /^Q6$/, /^C6$/], at: { x: 39, y: 112 } },
  { name: "pse", refs: [/^U22$/, /^R7[0-9]$/, /^C7[01]$/, /^D7[01]$/, /^Q22$/], at: { x: 60, y: 113 } },
  { name: "ntc", refs: [/^RT1$/, /^R107$/, /^C114$/], at: { x: 76, y: 102 } },
  { name: "cells", refs: [/^BT[1-4]$/], at: { x: 52, y: 43 }, side: "B" },
];

const CONNECTORS: Connector[] = [
  { ref: "J9", at: { x: 68, y: 5 }, face: "N", rotation: 90 }, // SWD, pins along the edge
  { ref: "J11", at: { x: 80, y: 5 }, face: "N", rotation: 90 }, // UART, pins along the edge
  { ref: "J8", at: { x: 16, y: 102 }, face: "W", rotation: 0 }, // fan (internal), left column
  { ref: "J13", at: { x: 16, y: 109 }, face: "W", rotation: 0 }, // lid LED cable
  // Side-emitting LEDs at the wall, beside the ports they describe. Their
  // rotation is a guess until the lens direction is checked in KiCad's 3D view.
  { ref: "D30", at: { x: 99, y: 48 }, face: "E", rotation: 90 }, // power LED at the wall between J1 and J2
  { ref: "D31", at: { x: 26, y: 129 }, face: "S", rotation: 0 }, // radio LED at the wall beside J5
];
const FLUSH: Flush[] = [
  { ref: "J6", edge: "N", along: 16, front: "+y", overhang: 0.8 }, // laptop RJ45
  { ref: "J3", edge: "N", along: 32, front: "+x", overhang: 0 }, // laptop DC out
  { libMatch: /USB_C_Receptacle_HRO|USB_C_Receptacle_GCT/, edge: "N", along: 50, front: "+y", overhang: 0.8 }, // serial USB-C
  { ref: "J1", edge: "E", along: 28, front: "+y", overhang: 0.8 }, // USB-C PD in
  { ref: "J2", edge: "E", along: 68, front: "+x", overhang: 0 }, // DC in
  { ref: "J5", edge: "S", along: 16, front: "+y", overhang: 0.8 }, // radio RJ45
];
const SILK: Silk[] = [
  ["FRC RADIO KIOSK v2", 78, 11, 1.6], ["Filip Kin  2026", 78, 14, 1.2], ["filipkin.com", 78, 16.6, 1.0],
  ["LAPTOP", 16, 19, 1.0], ["LAPTOP 15.6V", 33, 13.5, 1.0], ["SERIAL", 50, 11, 1.0], ["SWD", 68, 9, 0.9], ["UART", 80, 9, 0.9],
  ["USB-C PD IN", 97, 40, 1.0, 90], ["DC IN 14-26V", 98.2, 58, 1.0, 90], ["RADIO", 26.5, 121, 1.0, 90], ["FAN", 16, 96, 0.9], ["LID LED", 16, 113, 0.9],
];

// #region build
const project = process.argv.slice(2).find((a) => !a.startsWith("--"));
const placeOnly = process.argv.includes("--place-only");
const p = await prepareBoard();
const { board, fpOf } = p;

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

const connectorRefs = placeConnectors(p, W, H, CONNECTORS, FLUSH);
const cellPads = placeCells(p, 52, 43);
const holes = placeHoles(p, W, H);

// #region pack and place groups
// Each group is shelf-packed into a block (biggest parts first, rows no wider
// than its budget). The block then takes the nearest free spot to its target:
// free of other blocks, connectors, holes, the cell pads, and the board edge.
const taken: R[] = [];
const EDGE = 2;
for (const ref of connectorRefs) { const f = board.footprints.find((x) => x.ref === ref); if (f) taken.push(rectOf(f, fpOf(f))); }
for (const h of holes) taken.push({ x1: h.at.x - 3.5, y1: h.at.y - 3.5, x2: h.at.x + 3.5, y2: h.at.y + 3.5 });
for (const q of cellPads) taken.push({ x1: q.x - 2, y1: q.y - 2, x2: q.x + 2, y2: q.y + 2 });
// Ethernet pass-through lane, J6 to J5, along the left edge on the back:
// nothing else goes here on either side.
taken.push({ x1: 1.5, y1: 20, x2: 7, y2: 110 });
const GAP = 0.8;
const WIDTH: Record<string, number> = { mcu: 28, usb: 14, in_usb: 18, in_dc: 20, pd: 12, vin: 14, buck12: 18, bulk: 14, buck15: 30, buck5: 20, ntc: 8, fan: 12, backup: 20, boost: 30, efuse: 20, pse: 20, port: 8 };
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
  const t = g.at;
  for (let rad = 0; rad <= 70 && !best; rad += 1) {
    const cands: Point[] = [];
    for (let dx = -rad; dx <= rad; dx++) for (const dy of rad === 0 ? [0] : [-rad, rad]) cands.push({ x: t.x + dx, y: t.y + dy });
    for (let dy = -rad + 1; dy <= rad - 1; dy++) for (const dx of [-rad, rad]) cands.push({ x: t.x + dx, y: t.y + dy });
    cands.sort((a, b) => Math.hypot(a.x - t.x, a.y - t.y) - Math.hypot(b.x - t.x, b.y - t.y));
    for (const c of cands) {
      const r: R = { x1: c.x - bw / 2 - 0.5, y1: c.y - bh / 2 - 0.5, x2: c.x + bw / 2 + 0.5, y2: c.y + bh / 2 + 0.5 };
      if (r.x1 < EDGE || r.y1 < EDGE || r.x2 > W - EDGE || r.y2 > H - EDGE) continue;
      if (hits(taken, r)) continue;
      best = c; taken.push(r); break;
    }
  }
  if (!best) { console.log(`NO ROOM for ${g.name} (${bw.toFixed(0)} x ${bh.toFixed(0)})`); best = t; }
  if (process.env.PLACE_DEBUG === g.name) {
    const r: R = { x1: t.x - bw / 2 - 0.5, y1: t.y - bh / 2 - 0.5, x2: t.x + bw / 2 + 0.5, y2: t.y + bh / 2 + 0.5 };
    console.log(`debug ${g.name} wants ${JSON.stringify(r)}; blockers:`, taken.filter((q) => r.x1 < q.x2 && r.x2 > q.x1 && r.y1 < q.y2 && r.y2 > q.y1).map((q) => JSON.stringify(q)).join(" "));
  }
  for (const f of members) {
    const q = pos.get(f.ref)!;
    const fp = fpOf(f);
    const box = fp?.courtyard ?? fp?.bbox;
    const cc = box ? { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2 } : { x: 0, y: 0 };
    f.at = { x: +(best.x - bw / 2 + q.x - cc.x).toFixed(2), y: +(best.y - bh / 2 + q.y - cc.y).toFixed(2) };
  }
  const moved = Math.hypot(best.x - t.x, best.y - t.y);
  console.log(`${g.name.padEnd(8)} ${members.length.toString().padStart(3)} parts  ${bw.toFixed(0).padStart(2)} x ${bh.toFixed(0).padStart(2)} mm  at (${best.x}, ${best.y})${moved > 0.5 ? `  moved ${moved.toFixed(0)} mm from (${t.x}, ${t.y})` : ""}`);
}

preRouteEthernet(p, H, 2.0); // v2: lanes at the left edge (its jacks sit at x 16)
addSilk(board, SILK);
const { rats } = checkBoard(p, W, H);
await writeBoard(p, project, placeOnly);
await quickLook(p, W, H, rats, "/home/filip/tmp/radio-kiosk-v2-pcb.svg");
