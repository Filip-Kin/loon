// #region Footprints
// Parses KiCad `.kicad_mod` files into a model the canvas can draw and the
// board can place. The original S-expression is kept verbatim so a saved
// .kicad_pcb embeds exactly what KiCad's library says, rather than loon's
// interpretation of it - a land pattern is not something to paraphrase.

import { parse, findAll, find, type Sx, type SxList } from "./sexpr";
import type { Point } from "./schematic";

export type PadType = "smd" | "thru_hole" | "np_thru_hole" | "connect";
export type PadShape = "rect" | "roundrect" | "circle" | "oval" | "trapezoid" | "custom";

export interface FpPad {
  number: string;
  type: PadType;
  shape: PadShape;
  at: Point;
  rotation: number;
  size: { w: number; h: number };
  drill?: number;
  layers: string[];
  roundrectRatio?: number;
}

export type FpGraphic =
  | { type: "line"; a: Point; b: Point; layer: string; width: number }
  | { type: "rect"; a: Point; b: Point; layer: string; width: number }
  | { type: "circle"; center: Point; end: Point; layer: string; width: number }
  | { type: "arc"; start: Point; mid: Point; end: Point; layer: string; width: number };

export interface Footprint {
  libId: string; // "RF_Module:ESP32-S3-WROOM-1"
  name: string;
  pads: FpPad[];
  graphics: FpGraphic[];
  bbox: { min: Point; max: Point };
  // The courtyard is the keep-clear area KiCad's DRC checks between parts. It
  // is bigger than the pads, so placement has to use it.
  courtyard?: { min: Point; max: Point };
  // Keepout zones the part declares - an RF module's antenna clearance, for
  // one. Copper is not allowed inside them.
  keepouts?: Point[][];
  // True when the land pattern came from KiCad's library rather than being
  // generated from a package name. Generated ones must be checked before fab.
  fromLibrary: boolean;
  raw?: SxList;
}

const atom = (sx: Sx | undefined): string | undefined => (sx && sx.kind === "atom" ? sx.value : undefined);
const numAt = (l: SxList | undefined, i: number): number => {
  const v = atom(l?.items[i]);
  const n = v === undefined ? NaN : parseFloat(v);
  return isNaN(n) ? 0 : n;
};
const pt = (l: SxList | undefined): Point => ({ x: numAt(l, 1), y: numAt(l, 2) });

function layersOf(l: SxList): string[] {
  const node = find(l, "layers");
  if (!node) {
    const one = find(l, "layer");
    const v = atom(one?.items[1]);
    return v ? [v] : [];
  }
  return node.items.slice(1).map((i) => atom(i) ?? "").filter(Boolean);
}

function widthOf(l: SxList): number {
  const stroke = find(l, "stroke");
  if (stroke) return numAt(find(stroke, "width"), 1) || 0.12;
  return numAt(find(l, "width"), 1) || 0.12;
}

// #region KiCad 5 -> 9
// easyeda2kicad and older libraries write the KiCad 5 "module" form. KiCad 9
// refuses a board that embeds it, so every pattern is normalised on load:
// the node name, tedit, bare properties, (width) on graphics, and the legacy
// centre/angle arc, which is what actually made KiCad 9 abort.
function normalizeKicad9(root: SxList): void {
  if (atom(root.items[0]) === "module") root.items[0] = { kind: "atom", value: "footprint" } as Sx;
  root.items = root.items.filter((it) => !(it.kind === "list" && atom(it.items[0]) === "tedit"));
  root.items = root.items.filter((it) => !(it.kind === "list" && atom(it.items[0]) === "property" && !find(it, "at")));
  const A = (v: string): Sx => ({ kind: "atom", value: v }) as Sx;
  const L = (...items: Sx[]): SxList => ({ kind: "list", items }) as SxList;
  for (const it of root.items) {
    if (it.kind !== "list") continue;
    const head = atom(it.items[0]) ?? "";
    if (!/^fp_(line|circle|arc|rect|poly)$/.test(head)) continue;
    const wi = it.items.findIndex((x) => x.kind === "list" && atom((x as SxList).items[0]) === "width");
    if (wi >= 0 && !find(it, "stroke")) {
      const w = (it.items[wi] as SxList).items[1];
      it.items[wi] = L(A("stroke"), L(A("width"), w), L(A("type"), A("solid")));
    }
    if (head === "fp_arc") {
      const ang = find(it, "angle");
      const c = find(it, "start");
      const e = find(it, "end");
      if (ang && c && e && !find(it, "mid")) {
        const cx = numAt(c, 1), cy = numAt(c, 2), ex = numAt(e, 1), ey = numAt(e, 2);
        const t = (numAt(ang, 1) * Math.PI) / 180;
        const rot = (k: number) => ({ x: cx + (ex - cx) * Math.cos(k) - (ey - cy) * Math.sin(k), y: cy + (ex - cx) * Math.sin(k) + (ey - cy) * Math.cos(k) });
        const m = rot(t / 2), p2 = rot(t);
        const pt = (n: string, q: { x: number; y: number }) => L(A(n), A(q.x.toFixed(3)), A(q.y.toFixed(3)));
        it.items = it.items.filter((x) => !(x.kind === "list" && ["start", "end", "angle"].includes(atom((x as SxList).items[0]) ?? "")));
        it.items.splice(1, 0, pt("start", { x: ex, y: ey }), pt("mid", m), pt("end", p2));
      }
    }
  }
}

// The reference designator goes just above the part's outline, where it can
// still be read with the part fitted. Set on the pattern, so every instance
// gets it and KiCad rotates it with the part.
function placeReferenceAbove(root: SxList, minY: number): void {
  const A = (v: string): Sx => ({ kind: "atom", value: v }) as Sx;
  const at = { kind: "list", items: [A("at"), A("0"), A((minY - 0.9).toFixed(2))] } as SxList;
  for (const it of root.items) {
    if (it.kind !== "list") continue;
    const head = atom(it.items[0]);
    const isRef = (head === "fp_text" && atom(it.items[1]) === "reference") || (head === "property" && atom(it.items[1]) === "Reference");
    if (!isRef) continue;
    const i = it.items.findIndex((x) => x.kind === "list" && atom((x as SxList).items[0]) === "at");
    if (i >= 0) it.items[i] = at; else it.items.push(at);
  }
}

export function parseFootprint(text: string, libId: string): Footprint {
  const root = parse(text);
  normalizeKicad9(root);
  const name = atom(root.items[1]) ?? libId.split(":")[1] ?? libId;
  const pads: FpPad[] = [];
  for (const p of findAll(root, "pad")) {
    const number = atom(p.items[1]) ?? "";
    const type = (atom(p.items[2]) ?? "smd") as PadType;
    const shape = (atom(p.items[3]) ?? "rect") as PadShape;
    const at = find(p, "at");
    const size = find(p, "size");
    const drillNode = find(p, "drill");
    pads.push({
      number,
      type,
      shape,
      at: pt(at),
      rotation: numAt(at, 3),
      size: { w: numAt(size, 1), h: numAt(size, 2) },
      drill: drillNode ? numAt(drillNode, 1) : undefined,
      layers: layersOf(p),
      roundrectRatio: find(p, "roundrect_rratio") ? numAt(find(p, "roundrect_rratio"), 1) : undefined,
    });
  }

  const graphics: FpGraphic[] = [];
  for (const l of findAll(root, "fp_line")) {
    graphics.push({ type: "line", a: pt(find(l, "start")), b: pt(find(l, "end")), layer: layersOf(l)[0] ?? "F.SilkS", width: widthOf(l) });
  }
  for (const l of findAll(root, "fp_rect")) {
    graphics.push({ type: "rect", a: pt(find(l, "start")), b: pt(find(l, "end")), layer: layersOf(l)[0] ?? "F.SilkS", width: widthOf(l) });
  }
  for (const l of findAll(root, "fp_circle")) {
    graphics.push({ type: "circle", center: pt(find(l, "center")), end: pt(find(l, "end")), layer: layersOf(l)[0] ?? "F.SilkS", width: widthOf(l) });
  }
  for (const l of findAll(root, "fp_arc")) {
    graphics.push({ type: "arc", start: pt(find(l, "start")), mid: pt(find(l, "mid")), end: pt(find(l, "end")), layer: layersOf(l)[0] ?? "F.SilkS", width: widthOf(l) });
  }

  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  const acc = (p: Point, pad = 0) => {
    minx = Math.min(minx, p.x - pad); miny = Math.min(miny, p.y - pad);
    maxx = Math.max(maxx, p.x + pad); maxy = Math.max(maxy, p.y + pad);
  };
  for (const p of pads) acc(p.at, Math.max(p.size.w, p.size.h) / 2);
  for (const g of graphics) {
    if (g.type === "line" || g.type === "rect") { acc(g.a); acc(g.b); }
    else if (g.type === "circle") { acc(g.center); acc(g.end); }
    else { acc(g.start); acc(g.mid); acc(g.end); }
  }
  if (!isFinite(minx)) { minx = -1; miny = -1; maxx = 1; maxy = 1; }

  let cminx = Infinity, cminy = Infinity, cmaxx = -Infinity, cmaxy = -Infinity;
  const cacc = (p: Point) => {
    cminx = Math.min(cminx, p.x); cminy = Math.min(cminy, p.y);
    cmaxx = Math.max(cmaxx, p.x); cmaxy = Math.max(cmaxy, p.y);
  };
  for (const g of graphics) {
    if (!g.layer.endsWith("CrtYd")) continue;
    if (g.type === "line" || g.type === "rect") { cacc(g.a); cacc(g.b); }
    else if (g.type === "circle") { cacc(g.center); cacc(g.end); }
    else { cacc(g.start); cacc(g.mid); cacc(g.end); }
  }

  // Keepout zones: a zone node carrying a (keepout ...) child.
  const keepouts: Point[][] = [];
  for (const z of findAll(root, "zone")) {
    if (!find(z, "keepout")) continue;
    for (const poly of findAll(z, "polygon")) {
      const ptsNode = find(poly, "pts");
      if (!ptsNode) continue;
      const ring: Point[] = [];
      for (const xy of findAll(ptsNode, "xy")) ring.push({ x: numAt(xy, 1), y: numAt(xy, 2) });
      if (ring.length > 2) keepouts.push(ring);
    }
  }

  placeReferenceAbove(root, miny);
  return {
    libId,
    name,
    pads,
    graphics,
    keepouts: keepouts.length ? keepouts : undefined,
    bbox: { min: { x: minx, y: miny }, max: { x: maxx, y: maxy } },
    courtyard: isFinite(cminx) ? { min: { x: cminx, y: cminy }, max: { x: cmaxx, y: cmaxy } } : undefined,
    fromLibrary: true,
    raw: root,
  };
}

// #region generated fallback
// When a footprint is not in the library, generate a land pattern from the
// package name. Anything produced here is approximate and is flagged as such,
// because fabricating a guessed land pattern is how you get a board you cannot
// solder.
export function generateFootprint(libId: string, padCount: number): Footprint {
  const name = libId.split(":")[1] ?? libId;
  const pitch = parseFloat(name.match(/P([\d.]+)mm/)?.[1] ?? "1.27");
  const perSide = Math.max(1, Math.ceil(padCount / 2));
  const padW = Math.min(1.5, pitch * 0.6);
  const padH = Math.max(0.8, pitch * 1.2);
  const rowGap = Math.max(3, pitch * 4);
  const pads: FpPad[] = [];
  for (let i = 0; i < padCount; i++) {
    const left = i < perSide;
    const idx = left ? i : i - perSide;
    const y = (idx - (perSide - 1) / 2) * pitch;
    pads.push({
      number: String(i + 1),
      type: "smd",
      shape: "rect",
      at: { x: left ? -rowGap / 2 : rowGap / 2, y },
      rotation: 0,
      size: { w: padW, h: padH },
      layers: ["F.Cu", "F.Paste", "F.Mask"],
    });
  }
  const h = perSide * pitch;
  const graphics: FpGraphic[] = [
    { type: "rect", a: { x: -rowGap / 2 - 1, y: -h / 2 - 1 }, b: { x: rowGap / 2 + 1, y: h / 2 + 1 }, layer: "F.SilkS", width: 0.12 },
  ];
  return {
    libId,
    name,
    pads,
    graphics,
    bbox: { min: { x: -rowGap / 2 - 1, y: -h / 2 - 1 }, max: { x: rowGap / 2 + 1, y: h / 2 + 1 } },
    fromLibrary: false,
  };
}
