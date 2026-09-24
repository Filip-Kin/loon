// #region Sheet compaction
// A generated sheet is laid out by whatever built it, and what a builder
// chooses is an anchor per sub-circuit and offsets around it. Those anchors get
// spread out to keep the blocks from colliding while the sheet is being
// written, and nothing ever pulls them back in. The radio kiosk came out
// 918 x 714 mm - nine A4 sheets - which is unreadable at any zoom that also
// shows a pin number.
//
// This packs the sheet without touching anything inside a block: clusters are
// found, each cluster keeps its own internal layout exactly, and the clusters
// are re-laid into rows with a fixed gutter. Wires, labels, junctions and
// no-connects move with the cluster they belong to.

import type { Schematic, LibSymbol, Point } from "./schematic";
import { instanceBBox, snapPoint, pinWorld, PLACE_GRID } from "./geometry";

export interface CompactOptions {
  // How far apart two parts can be and still count as the same sub-circuit.
  // Bigger than the gap inside a block, smaller than the gap between blocks.
  joinGap?: number;
  // Space left between packed clusters.
  gutter?: number;
  // Width to wrap rows at. Left out, it is chosen so the packed sheet comes
  // out about 4:3, which is the shape of the window it is read in.
  targetWidth?: number;
  // Free text (the design notes) is stacked under the packed blocks rather
  // than left wherever it was.
  notesGutter?: number;
  // Top-left corner of the packed sheet. KiCad's page border sits inside the
  // first 10 mm or so, so anything packed from 0,0 is drawn under it.
  origin?: Point;
}

interface Box { min: Point; max: Point }

const grow = (b: Box, p: Point) => {
  b.min.x = Math.min(b.min.x, p.x); b.min.y = Math.min(b.min.y, p.y);
  b.max.x = Math.max(b.max.x, p.x); b.max.y = Math.max(b.max.y, p.y);
};
const empty = (): Box => ({ min: { x: Infinity, y: Infinity }, max: { x: -Infinity, y: -Infinity } });
const overlaps = (a: Box, b: Box, pad: number) =>
  a.min.x - pad <= b.max.x && b.min.x - pad <= a.max.x && a.min.y - pad <= b.max.y && b.min.y - pad <= a.max.y;

/**
 * Pack the sheet. Returns the size before and after so a caller can say what it
 * saved; the schematic is changed in place.
 */
export function compactSheet(
  schem: Schematic,
  defs: (libId: string) => LibSymbol | undefined,
  opts: CompactOptions = {},
): { before: { w: number; h: number }; after: { w: number; h: number }; clusters: number; cutWires: number } {
  const joinGap = opts.joinGap ?? 26;
  const gutter = opts.gutter ?? 20;

  const notesGutter = opts.notesGutter ?? 16;

  const before = sheetSize(schem, defs);
  if (schem.symbols.length === 0) return { before, after: before, clusters: 0, cutWires: 0 };

  // #region clusters
  // A block the builder declared is a cluster. Everything else is clustered by
  // how close it sits, single linkage, which is what the eye does too.
  const boxOf = new Map<string, Box>();
  for (const inst of schem.symbols) {
    const def = defs(inst.libId);
    const b = def
      ? instanceBBox(def, { at: inst.at, rotation: inst.rotation, mirror: inst.mirror })
      : { min: { ...inst.at }, max: { ...inst.at } };
    boxOf.set(inst.uuid, { min: { ...b.min }, max: { ...b.max } });
  }

  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(a) !== r) { const n = parent.get(a)!; parent.set(a, r); a = n; }
    return r;
  };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const inst of schem.symbols) parent.set(inst.uuid, inst.uuid);

  // Declared blocks first: they are the builder's own answer to "what belongs
  // together", and proximity should never split one.
  const byBlock = new Map<string, string[]>();
  for (const inst of schem.symbols) {
    const id = inst.properties.LoonBlock;
    if (!id) continue;
    const list = byBlock.get(id) ?? [];
    list.push(inst.uuid);
    byBlock.set(id, list);
  }
  for (const list of byBlock.values()) for (let i = 1; i < list.length; i++) union(list[0], list[i]);

  for (let i = 0; i < schem.symbols.length; i++) {
    for (let j = i + 1; j < schem.symbols.length; j++) {
      const a = boxOf.get(schem.symbols[i].uuid)!, b = boxOf.get(schem.symbols[j].uuid)!;
      if (overlaps(a, b, joinGap)) union(schem.symbols[i].uuid, schem.symbols[j].uuid);
    }
  }

  const clusterOf = new Map<string, string>();
  const clusters = new Map<string, { members: string[]; box: Box }>();
  for (const inst of schem.symbols) {
    const root = find(inst.uuid);
    clusterOf.set(inst.uuid, root);
    const c = clusters.get(root) ?? { members: [], box: empty() };
    c.members.push(inst.uuid);
    const b = boxOf.get(inst.uuid)!;
    grow(c.box, b.min); grow(c.box, b.max);
    clusters.set(root, c);
  }

  // #region carry the rest
  // Labels, junctions and no-connects sit on pins, so each belongs to the
  // cluster of the symbol whose pin it sits on; only something on no pin at
  // all falls back to the nearest cluster box. (Two blocks whose boxes
  // overlap used to steal each other's pin labels, which silently cut nets.)
  // A wire belongs to the cluster holding its first point; one that spans two
  // clusters is redrawn afterwards.
  const list = [...clusters.entries()];
  const pinOwner = new Map<string, string>();
  const key = (p: Point) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
  for (const inst of schem.symbols) {
    const def = defs(inst.libId);
    if (!def) continue;
    for (const pin of def.pins) pinOwner.set(key(pinWorld(pin, { at: inst.at, rotation: inst.rotation, mirror: inst.mirror })), clusterOf.get(inst.uuid)!);
  }
  const clusterAt = (p: Point): string | null => {
    const owner = pinOwner.get(key(p));
    if (owner) return owner;
    let best: string | null = null;
    let bestD = Infinity;
    for (const [id, c] of list) {
      if (p.x < c.box.min.x - joinGap || p.x > c.box.max.x + joinGap || p.y < c.box.min.y - joinGap || p.y > c.box.max.y + joinGap) continue;
      const cx = (c.box.min.x + c.box.max.x) / 2, cy = (c.box.min.y + c.box.max.y) / 2;
      const d = Math.abs(p.x - cx) + Math.abs(p.y - cy);
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  };

  // #region pack
  // Tallest first into rows, which wastes less than source order does.
  const order = list.slice().sort((a, b) => (b[1].box.max.y - b[1].box.min.y) - (a[1].box.max.y - a[1].box.min.y));
  // Rows wrap at a width that lands the sheet near 4:3. Packing is imperfect,
  // so allow for it, and never wrap narrower than the widest single cluster.
  const area = order.reduce((a, [, c]) => a + (c.box.max.x - c.box.min.x + gutter) * (c.box.max.y - c.box.min.y + gutter), 0);
  const widest = Math.max(...order.map(([, c]) => c.box.max.x - c.box.min.x));
  const targetWidth = opts.targetWidth ?? Math.max(widest, Math.sqrt((area * 1.3 * 4) / 3));
  const shift = new Map<string, Point>();
  const ox = opts.origin?.x ?? 0, oy = opts.origin?.y ?? 0;
  let cx = 0, cy = 0, rowH = 0;
  for (const [id, c] of order) {
    const w = c.box.max.x - c.box.min.x;
    const h = c.box.max.y - c.box.min.y;
    if (cx > 0 && cx + w > targetWidth) { cx = 0; cy += rowH + gutter; rowH = 0; }
    shift.set(id, snapPoint({ x: ox + cx - c.box.min.x, y: oy + cy - c.box.min.y }, PLACE_GRID));
    cx += w + gutter;
    rowH = Math.max(rowH, h);
  }
  const packedBottom = cy + rowH;

  const move = (p: Point, id: string | null) => {
    const d = id ? shift.get(id) : undefined;
    if (!d) return p;
    return { x: p.x + d.x, y: p.y + d.y };
  };

  for (const inst of schem.symbols) inst.at = move(inst.at, clusterOf.get(inst.uuid) ?? null);
  for (const l of schem.labels) l.at = move(l.at, clusterAt(l.at));
  for (const j of schem.junctions) j.at = move(j.at, clusterAt(j.at));
  for (const n of schem.noConnects) n.at = move(n.at, clusterAt(n.at));

  // A wire whose ends land in different clusters no longer joins what it
  // joined; the net still holds it together by name, and autowire redraws it
  // if the caller asks. Keeping a stretched wire would be a lie on the sheet.
  const kept = [];
  let cut = 0;
  for (const w of schem.wires) {
    const ids = w.pts.map((p) => clusterAt(p));
    const home = ids[0];
    if (ids.some((i) => i !== home)) { cut++; continue; }
    w.pts = w.pts.map((p) => move(p, home));
    kept.push(w);
  }
  schem.wires = kept;

  // Notes go under the blocks, in the order they were written.
  if (schem.texts?.length) {
    let ty = oy + packedBottom + notesGutter;
    for (const t of schem.texts) {
      t.at = snapPoint({ x: ox, y: ty }, PLACE_GRID);
      ty += Math.max(t.size * 2, 6);
    }
  }

  return { before, after: sheetSize(schem, defs), clusters: clusters.size, cutWires: cut };
}

export function sheetSize(schem: Schematic, defs: (libId: string) => LibSymbol | undefined): { w: number; h: number } {
  const box = empty();
  for (const inst of schem.symbols) {
    const def = defs(inst.libId);
    const b = def ? instanceBBox(def, { at: inst.at, rotation: inst.rotation, mirror: inst.mirror }) : { min: inst.at, max: inst.at };
    grow(box, b.min); grow(box, b.max);
  }
  for (const l of schem.labels) grow(box, l.at);
  if (!isFinite(box.min.x)) return { w: 0, h: 0 };
  return { w: Math.round(box.max.x - box.min.x), h: Math.round(box.max.y - box.min.y) };
}
