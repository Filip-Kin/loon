// FRC radio kiosk v2b: the same schematic as v2, placed by hand on a smaller
// board. Every part is named in a row of a block below, in the order the
// current flows through it, so the input caps sit at the IC, the inductor at
// the switch pin and the feedback parts under it. Same three-edge port rule
// as v2 (top = laptop, right = power in, bottom = radio), cells across the
// back, Ethernet pairs pre-routed down the left edge on the back.
//
// Run: LOON_FS_DIR=<loon-projects> bun run scripts/build-radio-kiosk-pcb-v2b.ts Radio_Kiosk_v2b [--place-only]
import type { Point } from "@loon/shared/schematic";
import { padWorld } from "@loon/shared/pcbgen";
import { prepareBoard, placeConnectors, placeCells, placeHoles, preRouteEthernet, addSilk, checkBoard, writeBoard, quickLook, sizeOf, rectOf, hits, type Connector, type Flush, type R, type Silk } from "./radio-kiosk-board";

const W = 84;
const H = 133;
const GAP_X = 1.1;     // between parts in a row: standing chips 3 mm apart, so their references clear
const GAP_Y = 1.8;     // between rows: room for a 0.8 mm reference above each part
const CELLS = { cx: 44, cy: 59 }; // holders x 6..82 on the back; pins come through at y ~39.5 and ~77.5, BT1's locating hole at x 7.5
const LANES = { laneX0: 8.0, midX0: 2.0, topJogY: 13, botJogY: 119 }; // Ethernet lanes: past J6's left peg, past J5's right peg, down the left edge between

// #region layout
// A block is rows of parts, laid left to right from its top-left corner.
// "REF@90" turns a part. Rows are top to bottom; each is as tall as its
// tallest part and parts sit on the row's centreline. Chip passives stand.
// The Ethernet lanes run under x 29-31 the whole height: only quiet parts
// go there (the PSE's resistors, the title), never a switcher.
type Block = { name: string; at: [x: number, y: number]; rows: string[][]; gap?: number };
const BLOCKS: Block[] = [
  // Band A, y 10-38: under the laptop-side jacks, power-in jacks at the right.
  // Serial USB-C (J12 at the top edge) with its ESD and series resistors,
  // plus the 5 V LDO U51 that has no better home.
  { name: "usb", at: [44, 10.6], rows: [["U52", "R122", "R123", "C141", "C142", "C143", "U51"]] },
  // Laptop rail, laid right to left: VIN caps at the right end by the VIN
  // via, then U4 -> L4 -> C45..C47 -> R96 shunt -> U43 (INA180A2) -> U42
  // (LMV321 CC loop) -> Q7/U7 (ideal diode) at the left, next to J3's run.
  // The lanes pass under x 29-31: U4 and L4 stay left of them (the switch
  // node between the two never crosses the pairs), the output caps sit to
  // their right, the VIN caps at the right end by the VIN via.
  { name: "buck15", at: [5.5, 16.6], rows: [
    ["C40", "U4", "L4", "_5.3", "C45", "C46", "C47"],
    ["R96", "_0.5", "U43", "U42", "R97", "R98", "R99", "R40", "R41", "R92", "C44"],
    ["Q7@180", "_0.5", "U7", "C7", "D40", "C116", "C117", "C118", "C43", "C42", "C41"],
  ] },
  // MCU with its decoupling beside it and the 3.3 V LDO (U30).
  { name: "mcu", at: [49, 15], gap: 1.0, rows: [
    ["U40", "C130", "C131", "C132"],
    ["C133", "C134", "C135", "C136", "U30"],
    ["C110", "R103", "R26", "R100", "R111", "R112"],
  ] },
  // Band B, y 41-76: between the two pin rows. Power in on the right, the
  // battery switch and bulk on the quiet left, the eFuse between.
  // Pack switch: Q8 (P-FET) with the comparator U10, its gate parts and the
  // 12 R test load R85/R88 under Q11.
  { name: "backup", at: [5.5, 41.5], rows: [
    ["Q8", "Q11", "U10", "Q9", "Q10", "F1"],
    ["R85", "R88", "R80", "R81", "R82", "R83"],
    ["R84", "R86", "R87", "R89", "C99"],
  ] },
  { name: "bulk", at: [5.5, 62], rows: [["C97", "C98"]] },
  // Passive 12 V path: eFuse U21 and the port P-FET Q13.
  { name: "efuse", at: [44, 42], rows: [["U21", "Q13"], ["C62", "C61", "C60"], ["R60", "R61", "R62", "R63"]] },
  // VIN sense divider under the eFuse, next to the bulk caps.
  { name: "vin", at: [35, 63], rows: [["C90@0", "C91@0", "R90", "R91"]] },
  // DC in: J2 -> D2 TVS -> Q2/U2 ideal diode -> VIN. Q2 is turned so its
  // drain pins face the VIN vias at the edge.
  { name: "in_dc", at: [61, 41.5], rows: [["D2", "Q2@180"], ["U2", "C2", "R94", "R95"]] },
  // USB-C PD in: J1 -> D1 TVS -> Q1/U1 ideal diode -> R93 shunt -> U41 (INA180) -> VIN.
  { name: "in_usb", at: [61, 54.6], rows: [["C1", "D1", "Q1@180"], ["U1", "R93", "U41", "C115"]] },
  // CH224A PD sink (CC lines run up to J1 as signals).
  { name: "pd", at: [61, 67.6], rows: [["U50", "C140", "R120", "R121", "C111"]] },
  // Band C, y 80-130: the radio side. PSE by the radio jack (its resistor
  // row lies over the lanes; the LTC4279 is linear, not a switcher), the
  // 54 V boost at the right, the 12 V and 5 V bucks right of the lanes,
  // fan driver, port TVS and NTC on the left.
  { name: "pse", at: [16, 80], rows: [
    ["U22@90", "Q22", "D70", "D71"],
    ["C70", "C71", "R72", "R70", "R71", "R73", "R74", "R75", "R76", "R77", "R78", "R79"],
  ] },
  { name: "fan", at: [5.5, 96], rows: [["D32", "Q30", "C113", "R101"], ["R104", "R105", "R106"]] },
  { name: "port", at: [5.5, 106.5], rows: [["D22", "C112"]] },
  { name: "ntc", at: [25, 106.5], rows: [["RT1", "R107", "C114"]] },
  // 54 V boost: compensation and feedback on top, the controller and switch,
  // the output cap with the shunt, the inductor with the diode.
  { name: "boost", at: [62, 80], rows: [
    ["C20", "C21", "R21", "R22", "R23", "R24"],
    ["C22", "C23", "C24", "R25", "D21@90"],
    ["U20", "Q20"],
    ["C25", "R20@90"],
    ["L20", "D20@90"],
  ] },
  // 12 V buck: input caps at the right end by the VIN via, the output diode
  // at the right end of row two by the +12V via.
  { name: "buck12", at: [33, 96.5], rows: [
    ["L3", "U3", "C34", "C30"],
    ["C35", "C36", "C37", "U6", "Q6"],
    ["C31", "C32", "C33", "R30", "R31", "C6"],
  ] },
  // 5 V buck, input caps at the right end.
  { name: "buck5", at: [34, 117], rows: [
    ["L5", "U5", "C54", "C50"],
    ["C55", "C56", "C57", "C51", "C52", "C53", "R50", "R51"],
  ] },
];

// The power-in jacks sit at the top of the right edge, above the cell
// holders: their pins would otherwise come through into a holder's base.
// The UART header stands beside the MCU; the buttons use the left strip.
const CONNECTORS: Connector[] = [
  { ref: "J9", at: { x: 59.5, y: 5 }, face: "N", rotation: 90 }, // SWD, pins along the edge
  { ref: "J11", at: { x: 70.8, y: 5 }, face: "N", rotation: 90 }, // UART, top edge beside SWD
  { ref: "SW1", at: { x: 4.0, y: 9.5 }, face: "W", rotation: 0 },  // RESET, top-left corner
  { ref: "SW2", at: { x: 4.0, y: 13.5 }, face: "W", rotation: 0 }, // BOOT0
  { ref: "J8", at: { x: 9.5, y: 83 }, face: "W", rotation: 0 },  // fan (internal), left column
  { ref: "J13", at: { x: 10.5, y: 90 }, face: "W", rotation: 0 }, // lid LED cable
  // WS2812B-4020: the lens is on the side opposite the pads (datasheet), so
  // the pad edge faces into the board.
  { ref: "D30", at: { x: 83, y: 21.5 }, face: "E", rotation: 270 }, // power LED at the wall between J1 and J2
  { ref: "D31", at: { x: 31.5, y: H - 1 }, face: "S", rotation: 180 }, // radio LED at the wall beside J5, past the Ethernet hop
];
// J3's rear pin is 2.3 mm left of its centre and 3.8 mm wide: the jack sits
// at 36 so that pin clears the lanes.
const FLUSH: Flush[] = [
  { ref: "J6", edge: "N", along: 19.7, front: "+y", overhang: 0.8 },  // laptop RJ45
  { ref: "J3", edge: "N", along: 35, front: "+x", overhang: 0 },      // laptop DC out
  { libMatch: /USB_C_Receptacle_HRO|USB_C_Receptacle_GCT/, edge: "N", along: 48.5, front: "+y", overhang: 0.8 }, // serial USB-C
  { ref: "J1", edge: "E", along: 13.2, front: "+y", overhang: 0.8 },  // USB-C PD in
  { ref: "J2", edge: "E", along: 28, front: "+x", overhang: 0 },      // DC in
  { ref: "J5", edge: "S", along: 20, front: "+y", overhang: 0.8 },    // radio RJ45
];
const SILK: Silk[] = [
  ["FRC RADIO KIOSK v2b", 15.5, 110.4, 0.95], ["Filip Kin  2026", 15.5, 112.4, 0.95], ["filipkin.com", 15.5, 114.2, 0.9],
  ["LAPTOP", 19.7, 15.2, 1.0], ["15.6V", 35, 15.2, 1.0], ["SERIAL", 48.5, 9.0, 0.9], ["SWD", 59.5, 8.2, 0.8], ["UART", 70.8, 8.2, 0.8],
  ["PD IN", 73.6, 13, 1.0, 90], ["DC IN", 66.8, 30, 1.0, 90], ["RADIO", 20, 116.0, 1.0], ["FAN", 14.6, 83, 0.9, 90], ["LID", 10.5, 93.7, 0.9],
  ["RESET", 8.6, 9.5, 0.8], ["BOOT", 8.4, 13.5, 0.8],
];

// #region build
const project = process.argv.slice(2).find((a) => !a.startsWith("--"));
const placeOnly = process.argv.includes("--place-only");
const p = await prepareBoard();
const { board, fpOf } = p;

const connectorRefs = placeConnectors(p, W, H, CONNECTORS, FLUSH);
const cellPads = placeCells(p, CELLS.cx, CELLS.cy, 1);
const holes = placeHoles(p, W, H);

// Keep-out for the hand check: connectors, holes, cell pins, the Ethernet lane.
const taken: { r: R; what: string }[] = [];
for (const ref of connectorRefs) { const f = board.footprints.find((x) => x.ref === ref); if (f) taken.push({ r: rectOf(f, fpOf(f)), what: ref }); }
for (const h of holes) taken.push({ r: { x1: h.at.x - 3.5, y1: h.at.y - 3.5, x2: h.at.x + 3.5, y2: h.at.y + 3.5 }, what: h.ref });
for (const q of cellPads) taken.push({ r: { x1: q.x - 2.2, y1: q.y - 2.2, x2: q.x + 2.2, y2: q.y + 2.2 }, what: "cell pin" });
// the front-side jogs and vias beside each jack
taken.push({ r: { x1: 7, y1: 8, x2: 12, y2: 13.5 }, what: "ethernet jog" });
taken.push({ r: { x1: 7, y1: H - 17.5, x2: 30, y2: H - 8 }, what: "ethernet jog" });

for (const ref of connectorRefs) { const f = board.footprints.find((x) => x.ref === ref)!; const r = rectOf(f, fpOf(f)); console.log(`  ${ref.padEnd(4)} rot ${String(f.rotation).padStart(3)}  x ${r.x1.toFixed(1)}-${r.x2.toFixed(1)}  y ${r.y1.toFixed(1)}-${r.y2.toFixed(1)}`); }
if (process.env.PLACE_DEBUG) for (const ref of process.env.PLACE_DEBUG.split(",")) { const f = board.footprints.find((x) => x.ref === ref)!; const fp = fpOf(f); console.log(`  ${ref}: courtyard ${JSON.stringify(fp.courtyard)} bbox ${JSON.stringify(fp.bbox)}`); }
const placed = new Set<string>(connectorRefs);
for (const b of BLOCKS) {
  let y = b.at[1];
  let bw = 0;
  for (const row of b.rows) {
    const parts = row.map((tok) => {
      if (tok.startsWith("_")) return { spacer: Number(tok.slice(1)) } as const;
      const [ref, r] = tok.split("@");
      const f = board.footprints.find((x) => x.ref === ref);
      if (!f) { console.log(`${b.name}: no part ${ref}`); return null; }
      // Chip parts stand side by side in a row (pads along the row), the
      // way passives line up on a board; anything else lies as drawn.
      const chip = /R_(0603|0805|1206|1210)|C_(0603|0805|1206|1210)|Fuse_1206/.test(f.libId);
      f.rotation = r ? +r : chip ? 90 : 0;
      return { f, sz: sizeOf(fpOf(f), f.rotation) };
    }).filter((x): x is NonNullable<typeof x> => !!x);
    const rowH = Math.max(...parts.map((q) => ("spacer" in q ? 0 : q.sz.h)));
    let x = b.at[0];
    for (const part of parts) {
      if ("spacer" in part) { x += part.spacer; continue; }
      const { f, sz } = part;
      const fp = fpOf(f);
      const box = fp?.courtyard ?? fp?.bbox;
      // courtyard centre -> footprint origin, for this rotation
      const c = box ? { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2 } : { x: 0, y: 0 };
      const rad = (f.rotation * Math.PI) / 180;
      const cr = { x: c.x * Math.cos(rad) - c.y * Math.sin(rad), y: c.x * Math.sin(rad) + c.y * Math.cos(rad) };
      const centre = { x: x + sz.w / 2, y: y + rowH / 2 };
      f.at = { x: +(centre.x - cr.x).toFixed(2), y: +(centre.y - cr.y).toFixed(2) };
      placed.add(f.ref);
      x += sz.w + (b.gap ?? GAP_X);
    }
    bw = Math.max(bw, x - (b.gap ?? GAP_X) - b.at[0]);
    y += rowH + GAP_Y;
  }
  const r: R = { x1: b.at[0], y1: b.at[1], x2: b.at[0] + bw, y2: y - GAP_Y };
  const clash = taken.filter((t) => hits([t.r], r)).map((t) => t.what);
  const edge = r.x1 < 2 || r.y1 < 2 || r.x2 > W - 2 || r.y2 > H - 2 ? " OFF EDGE" : "";
  console.log(`${b.name.padEnd(7)} ${bw.toFixed(1).padStart(5)} x ${(r.y2 - r.y1).toFixed(1).padStart(5)}  x ${r.x1}-${r.x2.toFixed(1)}  y ${r.y1}-${r.y2.toFixed(1)}${clash.length ? "  HITS " + clash.join(",") : ""}${edge}`);
  taken.push({ r, what: b.name });
}
const left = board.footprints.filter((f) => !placed.has(f.ref) && !/^H\d+$|^BT\d$/.test(f.ref)).map((f) => f.ref);
if (left.length) console.log("NOT IN LAYOUT:", left.join(" "));


// #region hand routes: the power spine
// Freerouting failed the wide nets, so the rails are laid here on the back
// (2 mm, 2 oz) with via drops at each block; it only has to make the last
// few millimetres on the front. Corridors avoid the holder pins (y 39.5 /
// 77.5, holes at x 7.5 / 45.4 / 43 / 82), the Ethernet lanes (x 29-31.3,
// back) and each other; where two rails must cross, one takes the front.
{
  const fpByRef = (ref: string) => board.footprints.find((x) => x.ref === ref)!;
  const padAt = (ref: string, num: string): Point => { const f = fpByRef(ref); const pad = fpOf(f).pads.find((q) => q.number === num)!; return padWorld(f, pad.at); };
  // Right-angle corners in a run become 45-degree mitres (M = 0.8, or less
  // where the legs are short); the pads at the ends stay put.
  const mitre = (pts: Point[], M = 0.8): Point[] => {
    const out: Point[] = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1], b = pts[i], c = pts[i + 1];
      const l1 = Math.hypot(b.x - a.x, b.y - a.y), l2 = Math.hypot(c.x - b.x, c.y - b.y);
      const m = Math.min(M, l1 / 2, l2 / 2);
      const turn = Math.abs((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) < 1e-6; // a real corner
      if (!turn || m < 0.1) { out.push(b); continue; }
      out.push({ x: b.x - ((b.x - a.x) / l1) * m, y: b.y - ((b.y - a.y) / l1) * m }, { x: b.x + ((c.x - b.x) / l2) * m, y: b.y + ((c.y - b.y) / l2) * m });
    }
    out.push(pts[pts.length - 1]);
    return out;
  };
  const seg = (layer: string, width: number, net: string, raw: Point[]) => { const pts = mitre(raw); for (let i = 1; i < pts.length; i++) board.tracks.push({ uuid: crypto.randomUUID(), layer, width, start: pts[i - 1], end: pts[i], net }); };
  const via = (net: string, x: number, y: number, size = 1.0, drill = 0.5) => board.vias.push({ uuid: crypto.randomUUID(), at: { x, y }, size, drill, net });
  const B = (net: string, pts: Point[], w = 2.0) => seg("B.Cu", w, net, pts);
  const F = (net: string, pts: Point[], w = 1.5) => seg("F.Cu", w, net, pts);

  // VIN: the ideal-diode outputs at the right edge feed a bus along y 37
  // (above the upper pin row) to the laptop buck, and a column at x 57.4
  // down to the 12 V and 5 V bucks; a spur to the sense divider.
  const q2 = padAt("Q2", "3"), q1 = padAt("Q1", "3");
  F("VIN", [q2, { x: 80.8, y: q2.y }]); via("VIN", 80.8, q2.y);
  F("VIN", [q1, { x: 80.8, y: q1.y }]); via("VIN", 80.8, q1.y);
  const c41 = padAt("C41", "1");                                       // laptop buck input cap, bottom pad
  B("VIN", [{ x: 80.8, y: q1.y }, { x: 80.8, y: 37 }, { x: 42.5, y: 37 }, { x: 42.5, y: 38.9 }]); via("VIN", 42.5, 38.9); // clear of the holder's locating hole at x 45.4
  F("VIN", [{ x: 42.5, y: 38.9 }, c41]);
  B("VIN", [{ x: 57.4, y: 37 }, { x: 57.4, y: 114.9 }]);
  via("VIN", 57.4, 95.7); via("VIN", 57.4, 114.9);
  const c30 = padAt("C30", "1"), c50 = padAt("C50", "1");
  F("VIN", [{ x: 57.4, y: 95.7 }, { x: 60.5, y: 95.7 }, { x: 60.5, y: c30.y }, c30]);
  F("VIN", [{ x: 57.4, y: 114.9 }, { x: 61, y: 114.9 }, { x: 61, y: c50.y }, c50], 1.2);
  B("VIN", [{ x: 37, y: 37 }, { x: 37, y: 61.7 }]); via("VIN", 37, 61.7);   // sense divider

  // VIN_USB: the receptacle's VBUS pads are tiny, so a 1.5 mm bar collects
  // them, drops to the back past the DC jack's pins and comes up at the
  // edge to run down the front (the VIN bus is in the way on the back).
  const vb1 = padAt("J1", "A4B9"), vb2 = padAt("J1", "B4A9");
  // the signal pads' tips are at x 76.6: the bar sits at 75.3
  F("VIN_USB", [vb1, { x: 75.3, y: vb1.y }], 0.6); F("VIN_USB", [vb2, { x: 75.3, y: vb2.y }], 0.6);
  F("VIN_USB", [{ x: 75.3, y: Math.min(vb1.y, vb2.y) }, { x: 75.3, y: 20 }]);
  via("VIN_USB", 75.3, 18); via("VIN_USB", 75.3, 20);
  B("VIN_USB", [{ x: 75.3, y: 18 }, { x: 75.3, y: 20 }, { x: 82.5, y: 27.2 }, { x: 82.5, y: 34.6 }]);
  via("VIN_USB", 82.5, 34.6);
  const d1 = padAt("D1", "1");
  F("VIN_USB", [{ x: 82.5, y: 34.6 }, { x: 82.5, y: 53.5 }, { x: d1.x, y: 53.5 }, d1]);

  // VIN_DC: the DC jack's rear pin straight down the front to its TVS.
  const j2 = padAt("J2", "1"), d2 = padAt("D2", "1");
  F("VIN_DC", [j2, { x: j2.x, y: 39.7 }, { x: d2.x, y: 39.7 }, d2]);

  // +12V: the 12 V buck's output feeds the boost, the eFuse, the bulk caps,
  // the pack switch and the fan. A column on the back at x 59.9 beside the
  // VIN column, and a bus along y 74.6 to the left that hops to the front
  // over the VIN column and over the Ethernet lanes.
  B("+12V", [{ x: 59.9, y: 40.9 }, { x: 59.9, y: 124.1 }, { x: 62.6, y: 126.8 }, { x: 63.5, y: 126.8 }]);
  via("+12V", 59.9, 40.9); via("+12V", 59.9, 86); via("+12V", 59.9, 107); via("+12V", 63.5, 126.8);
  F("+12V", [{ x: 59.9, y: 86 }, padAt("C22", "1")], 1.2);
  const l20 = padAt("L20", "1");
  F("+12V", [{ x: 63.5, y: 126.8 }, { x: 63.5, y: l20.y }], 1.2);   // straight up into the inductor's pad
  via("+12V", 59.9, 74.6); F("+12V", [{ x: 59.9, y: 74.6 }, { x: 55, y: 74.6 }], 2.0); via("+12V", 55, 74.6);
  B("+12V", [{ x: 55, y: 74.6 }, { x: 9, y: 74.6 }]);
  const c98 = padAt("C98", "1"), c97 = padAt("C97", "1");
  via("+12V", 26, 74.6); F("+12V", [{ x: 26, y: 74.6 }, { x: 26, y: 70.5 }, { x: c98.x, y: 70.5 }, c98], 2.0);
  via("+12V", 12, 74.6);
  F("+12V", [{ x: 12, y: 74.6 }, { x: 12, y: 70.5 }, { x: c97.x, y: 70.5 }, c97], 2.0);
  B("+12V", [{ x: 12, y: 74.6 }, { x: 12, y: 49.4 }]); via("+12V", 12, 49.4);
  const j8 = padAt("J8", "1");
  B("+12V", [{ x: 9, y: 74.6 }, { x: 9, y: 80 }, { x: j8.x, y: 80 + (9 - j8.x) }, j8], 1.0);

  // LAPTOP_OUT: the output FET (turned so its drain pins face east) to the
  // laptop jack: through the 1.6 mm gap beside it, down to the back for the
  // climb past the buck's rows, back up in the strip between the jacks and
  // the buck. Keeps it off the Ethernet lanes at the left edge.
  const q7 = padAt("Q7", "3"), j3 = padAt("J3", "1");
  F("LAPTOP_OUT", [q7, { x: 13.7, y: q7.y }, { x: 13.7, y: 31.3 }], 1.0); via("LAPTOP_OUT", 13.7, 31.3);
  B("LAPTOP_OUT", [{ x: 13.7, y: 31.3 }, { x: 13.7, y: 15.5 }], 1.2); via("LAPTOP_OUT", 13.7, 15.5);
  F("LAPTOP_OUT", [{ x: 13.7, y: 15.5 }, { x: 13.7, y: 16 }, { x: j3.x, y: 16 }, j3], 1.2);

  // PORT_P / PORT_N escape from the radio jack: pins 4/5 and 7/8 joined by
  // short diagonals, pin 5 out under the jack and up the left strip, pin 8
  // straight up. Both end at the port TVS; Freerouting takes it from there.
  const p4 = padAt("J5", "4"), p5 = padAt("J5", "5"), p7 = padAt("J5", "7"), p8 = padAt("J5", "8");
  seg("B.Cu", 0.5, "PORT_P", [p4, p5]); seg("B.Cu", 0.5, "PORT_N", [p8, p7]);
  const d22p = padAt("D22", "1"), d22n = padAt("D22", "2");
  // pin 5 out under the jack (west of the Ethernet strips) and up the left
  // strip at x 6.7 straight into the TVS; pin 8 west along the pin row,
  // under pair 3/6's row, and up at x 8.0
  F("PORT_P", [p5, { x: p5.x, y: H - 2 }, { x: 6.7, y: H - 2 }, { x: 6.7, y: d22p.y }, d22p], 0.8);
  F("PORT_N", [p8, { x: 8.0, y: p8.y }, { x: 8.0, y: 112 }, { x: d22n.x, y: 112 }, d22n], 0.8);
  console.log(`hand routes: ${board.tracks.length} segments, ${board.vias.length} vias`);
}

preRouteEthernet(p, H, LANES);
addSilk(board, SILK);
const { rats } = checkBoard(p, W, H);
// Wall LEDs, labelled jacks and the holders print no reference: the label says what they are.
await writeBoard(p, project, placeOnly, ["D30", "D31", "J1", "J2", "J3", "J5", "J6", "J8", "J12", "J13", "SW1", "SW2", "BT1", "BT2", "BT3", "BT4"]);
await quickLook(p, W, H, rats, "/home/filip/tmp/radio-kiosk-v2b-pcb.svg");
