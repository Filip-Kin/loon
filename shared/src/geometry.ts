// #region Geometry
// One transform used everywhere so wiring and rendering agree. Symbol library
// coordinates are Y-up (KiCad convention); schematic space is Y-down. We flip Y
// once, then apply mirror, rotation, and translation. Non-rotated placements
// match KiCad exactly; rotated/mirrored fidelity to KiCad is refined later.

import type { Point, SymbolInstance, LibSymbol, SymPin } from "./schematic";

export const MM = 1; // model unit is millimetres, matching KiCad
export const GRID = 1.27; // default fine grid
export const PLACE_GRID = 2.54; // default placement grid (100 mil)

export function snap(v: number, grid = GRID): number {
  return Math.round(v / grid) * grid;
}

export function snapPoint(p: Point, grid = GRID): Point {
  return { x: snap(p.x, grid), y: snap(p.y, grid) };
}

export interface Placement {
  at: Point;
  rotation: number;
  mirror?: "x" | "y" | null;
}

// Symbol-local point -> schematic-world point.
export function localToWorld(p: Point, place: Placement): Point {
  let x = p.x;
  let y = -p.y; // Y-up -> Y-down
  if (place.mirror === "x") y = -y;
  if (place.mirror === "y") x = -x;
  const r = ((place.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const rx = x * cos - y * sin;
  const ry = x * sin + y * cos;
  return { x: place.at.x + rx, y: place.at.y + ry };
}

// World endpoint of a pin's connection point for a placed instance.
export function pinWorld(pin: SymPin, place: Placement): Point {
  return localToWorld(pin.at, place);
}

export function pinBodyEnd(pin: SymPin, place: Placement): Point {
  // The stub end inside the symbol body, for drawing the pin line.
  const r = (pin.rotation * Math.PI) / 180;
  const end: Point = { x: pin.at.x + pin.length * Math.cos(r), y: pin.at.y + pin.length * Math.sin(r) };
  return localToWorld(end, place);
}

export function findPin(def: LibSymbol, pinNumber: string): SymPin | undefined {
  return def.pins.find((p) => p.number === pinNumber);
}

// World-space axis-aligned bounding box of a placed symbol (graphics + pins).
export function instanceBBox(def: LibSymbol, place: Placement): { min: Point; max: Point } {
  const corners = [
    def.bbox.min,
    def.bbox.max,
    { x: def.bbox.min.x, y: def.bbox.max.y },
    { x: def.bbox.max.x, y: def.bbox.min.y },
  ].map((p) => localToWorld(p, place));
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return { min: { x: Math.min(...xs), y: Math.min(...ys) }, max: { x: Math.max(...xs), y: Math.max(...ys) } };
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Manhattan two-segment route between two points (schematic-style orthogonal).
export function routeOrthogonal(from: Point, to: Point): Point[] {
  if (from.x === to.x || from.y === to.y) return [from, to];
  const mid: Point = { x: to.x, y: from.y };
  return [from, mid, to];
}
