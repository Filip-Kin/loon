// FRC radio kiosk v2b: the same schematic as v2, placed by hand on a smaller
// board. Every part is named in a row of a block below, in the order the
// current flows through it, so the input caps sit at the IC, the inductor at
// the switch pin and the feedback parts under it. Same three-edge port rule
// as v2 (top = laptop, right = power in, bottom = radio), cells across the
// back, Ethernet pairs pre-routed down the left edge on the back.
//
// Run: LOON_FS_DIR=<loon-projects> bun run scripts/build-radio-kiosk-pcb-v2b.ts Radio_Kiosk_v2b [--place-only]
import { prepareBoard, placeConnectors, placeCells, placeHoles, preRouteEthernet, addSilk, checkBoard, writeBoard, quickLook, sizeOf, rectOf, hits, type Connector, type Flush, type R, type Silk } from "./radio-kiosk-board";

const W = 84;
const H = 132;
const GAP_X = 1.1;     // between parts in a row: standing chips 3 mm apart, so their references clear
const GAP_Y = 1.8;     // between rows: room for a 0.8 mm reference above each part
const CELLS = { cx: 44, cy: 58 }; // holders x 6..82 on the back; pins come through at y ~39 and ~77, BT1's locating hole at x 7

// #region layout
// A block is rows of parts, laid left to right from its top-left corner.
// "REF@90" turns a part. Rows are top to bottom; each is as tall as its
// tallest part and parts sit on the row's centreline. Chip passives stand.
type Block = { name: string; at: [x: number, y: number]; rows: string[][]; gap?: number };
const BLOCKS: Block[] = [
  // Band A, y 10-37: under the laptop-side jacks, power-in jacks at the right.
  // Serial USB-C (J12 at the top edge) with its ESD and series resistors.
  { name: "usb", at: [42.5, 10.6], gap: 1.6, rows: [["U52", "R122", "R123", "C141", "C142", "C143"]] },
  // Laptop rail: VIN -> C40 C44 -> U4 -> L4 -> C45..C47 -> R96 shunt -> U43 (INA180A2)
  // -> U42 (LMV321 CC loop) -> Q7/U7 (ideal diode) -> J3. Feedback under the IC.
  { name: "buck15", at: [5.5, 16.5], rows: [
    ["C40", "C44", "U4", "L4", "C45", "C46", "C47"],
    ["R96", "U43", "U42", "R97", "R98", "R99", "R40", "R41", "R92"],
    ["Q7", "U7", "C7", "D40", "C116", "C117", "C118", "C41", "C42", "C43"],
  ] },
  // MCU with its decoupling beside it, buttons and the 3.3 V LDO (U30).
  { name: "mcu", at: [46, 15], rows: [
    ["U40", "C130", "C131", "C132"],
    ["C133", "C134", "C135", "C136", "U30"],
    ["C110", "R103", "R26", "R100", "R111", "R112"],
  ] },
  // BOOT0 and RESET buttons by the debug headers.
  { name: "sw", at: [64, 9.5], gap: 2.0, rows: [["SW1", "SW2"]] },
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
  { name: "efuse", at: [44.5, 42], rows: [["U21", "Q13"], ["C62", "C61", "C60"], ["R60", "R61", "R62", "R63"]] },
  // VIN sense divider under the eFuse, next to the bulk caps.
  { name: "vin", at: [35, 63], rows: [["C90@0", "C91@0", "R90", "R91"]] },
  // USB-C PD in: J1 -> D1 TVS -> Q1/U1 ideal diode -> R93 shunt -> U41 (INA180) -> VIN.
  { name: "in_usb", at: [60, 41.5], rows: [["D1", "Q1", "U1"], ["R93", "U41", "C115", "C1"]] },
  // CH224A PD sink.
  { name: "pd", at: [60, 55], rows: [["U50", "C140", "R120", "R121", "C111"]] },
  // DC in: J2 -> D2 TVS -> Q2/U2 ideal diode -> VIN.
  { name: "in_dc", at: [60, 63.5], rows: [["D2", "Q2"], ["U2", "C2", "R94", "R95"]] },
  // Band C, y 80-130: the radio side. PSE by the radio jack, the 54 V boost
  // beside it, the 12 V and 5 V bucks below, fan driver and NTC on the left.
  // PSE: U22 with the port FET Q22, the port diodes and caps; sense and
  // programming resistors under it.
  { name: "pse", at: [16, 80], rows: [
    ["U22@90", "Q22", "D70", "D71"],
    ["C70", "C71", "R72", "R70", "R71", "R73", "R74", "R75", "R76", "R77", "R78", "R79"],
  ] },
  { name: "fan", at: [5.5, 96], rows: [["D32", "Q30", "C113", "R101"], ["R104", "R105", "R106"]] },
  { name: "port", at: [5.5, 106], rows: [["D22", "C112"]] },
  { name: "ntc", at: [16.5, 106], rows: [["RT1", "R107", "C114"]] },
  // 54 V boost: compensation and feedback on top, the controller, switch and
  // diode, then the output cap and shunt, the inductor at the bottom.
  { name: "boost", at: [62, 80], rows: [
    ["C20", "C21", "R21", "R22", "R23", "R24"],
    ["C22", "C23", "C24", "R25", "D21@90"],
    ["U20", "Q20"],
    ["C25", "R20@90"],
    ["L20", "D20@90"],
  ] },
  // 12 V buck: VIN -> C30 C34 -> U3 -> L3 -> C35..C37 -> Q6/U6 (ideal diode) -> +12V.
  { name: "buck12", at: [28.5, 96], rows: [
    ["C30", "C34", "U3", "L3"],
    ["C35", "C36", "C37", "Q6", "U6", "C6"],
    ["C31", "C32", "C33", "R30", "R31"],
  ] },
  // 5 V buck and the 3.3 V LDO U51.
  { name: "buck5", at: [28.5, 117], rows: [
    ["C50", "C54", "U5", "L5", "C55"],
    ["C56@0", "C57@0", "C51", "C52", "C53", "R50", "R51", "U51"],
  ] },
];

// The power-in jacks sit at the top of the right edge, above the cell
// holders: their pins would otherwise come through into a holder's base.
const CONNECTORS: Connector[] = [
  { ref: "J9", at: { x: 57.5, y: 5 }, face: "N", rotation: 90 }, // SWD, pins along the edge
  { ref: "J11", at: { x: 70, y: 5 }, face: "N", rotation: 90 },  // UART
  { ref: "J8", at: { x: 9.5, y: 83 }, face: "W", rotation: 0 },  // fan (internal), left column
  { ref: "J13", at: { x: 10.5, y: 90 }, face: "W", rotation: 0 }, // lid LED cable
  // WS2812B-4020: the lens is on the side opposite the pads (datasheet), so
  // the pad edge faces into the board.
  { ref: "D30", at: { x: 83, y: 21.5 }, face: "E", rotation: 270 }, // power LED at the wall between J1 and J2
  { ref: "D31", at: { x: 31, y: 131 }, face: "S", rotation: 180 }, // radio LED at the wall beside J5
];
// The RJ45s sit 4 mm in from the left so the Ethernet lanes (x 8-10 beside
// the jacks) pass between the corner hole and the jack's peg.
const FLUSH: Flush[] = [
  { ref: "J6", edge: "N", along: 19.7, front: "+y", overhang: 0.8 },  // laptop RJ45
  { ref: "J3", edge: "N", along: 31.7, front: "+x", overhang: 0 },    // laptop DC out
  { libMatch: /USB_C_Receptacle_HRO|USB_C_Receptacle_GCT/, edge: "N", along: 46, front: "+y", overhang: 0.8 }, // serial USB-C
  { ref: "J1", edge: "E", along: 13.2, front: "+y", overhang: 0.8 },    // USB-C PD in
  { ref: "J2", edge: "E", along: 28, front: "+x", overhang: 0 },      // DC in
  { ref: "J5", edge: "S", along: 20, front: "+y", overhang: 0.8 },    // radio RJ45
];
const SILK: Silk[] = [
  ["FRC RADIO KIOSK v2b", 15.5, 110.4, 0.95], ["Filip Kin  2026", 15.5, 112.4, 0.95], ["filipkin.com", 15.5, 114.2, 0.9],
  ["LAPTOP", 19.7, 15.4, 0.9], ["15.6V", 31.7, 15.4, 0.9], ["SERIAL", 46, 9.0, 0.8], ["SWD", 57.5, 7.4, 0.8], ["UART", 70, 7.4, 0.8],
  ["PD IN", 76.4, 13, 0.8, 90], ["DC IN", 76.4, 30, 0.8, 90], ["RADIO", 20, 116.0, 0.8], ["FAN", 14.6, 83, 0.8, 90], ["LID", 10.5, 93.7, 0.8], ["RESET", 66.4, 13.9, 0.8], ["BOOT", 73.2, 13.9, 0.8],
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
taken.push({ r: { x1: 0, y1: 8, x2: 5, y2: 114 }, what: "ethernet lane" });
// the front-side jogs of pair 3/6 and their vias, beside each jack
taken.push({ r: { x1: 0, y1: 8, x2: 11, y2: 13 }, what: "ethernet jog" });
taken.push({ r: { x1: 0, y1: H - 13, x2: 11, y2: H - 8 }, what: "ethernet jog" });

for (const ref of connectorRefs) { const f = board.footprints.find((x) => x.ref === ref)!; const r = rectOf(f, fpOf(f)); console.log(`  ${ref.padEnd(4)} rot ${String(f.rotation).padStart(3)}  x ${r.x1.toFixed(1)}-${r.x2.toFixed(1)}  y ${r.y1.toFixed(1)}-${r.y2.toFixed(1)}`); }
if (process.env.PLACE_DEBUG) for (const ref of process.env.PLACE_DEBUG.split(",")) { const f = board.footprints.find((x) => x.ref === ref)!; const fp = fpOf(f); console.log(`  ${ref}: courtyard ${JSON.stringify(fp.courtyard)} bbox ${JSON.stringify(fp.bbox)}`); }
const placed = new Set<string>(connectorRefs);
for (const b of BLOCKS) {
  let y = b.at[1];
  let bw = 0;
  for (const row of b.rows) {
    const parts = row.map((tok) => {
      const [ref, r] = tok.split("@");
      const f = board.footprints.find((x) => x.ref === ref);
      if (!f) { console.log(`${b.name}: no part ${ref}`); return null; }
      // Chip parts stand side by side in a row (pads along the row), the
      // way passives line up on a board; anything else lies as drawn.
      const chip = /R_(0603|0805|1206|1210)|C_(0603|0805|1206|1210)|Fuse_1206/.test(f.libId);
      f.rotation = r ? +r : chip ? 90 : 0;
      return { f, sz: sizeOf(fpOf(f), f.rotation) };
    }).filter((x): x is NonNullable<typeof x> => !!x);
    const rowH = Math.max(...parts.map((q) => q.sz.h));
    let x = b.at[0];
    for (const { f, sz } of parts) {
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

preRouteEthernet(p, H, 8.0, 2.0, 13);
addSilk(board, SILK);
const { rats } = checkBoard(p, W, H);
// Wall LEDs, labelled jacks and the holders print no reference: the label says what they are.
await writeBoard(p, project, placeOnly, ["D30", "D31", "J1", "J2", "J3", "J5", "J6", "J8", "J12", "J13", "BT1", "BT2", "BT3", "BT4"]);
await quickLook(p, W, H, rats, "/home/filip/tmp/radio-kiosk-v2b-pcb.svg");
