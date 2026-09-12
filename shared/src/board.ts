// #region Board model
// The PCB. Deliberately small: placed footprints, tracks, vias, a board
// outline, and the net each copper item belongs to. Everything KiCad knows that
// loon does not is carried through verbatim on the footprint S-expression, so a
// saved board is KiCad's own land patterns with loon's placement around them.
//
// OSH Park accepts .kicad_pcb directly, so this model is the deliverable, not
// an intermediate step on the way to Gerbers.

import type { Point } from "./schematic";

export type BoardSide = "F" | "B";

export interface PlacedFootprint {
  uuid: string;
  ref: string;
  value: string;
  // Schematic symbol this came from, so the two views stay linked.
  symbolUuid?: string;
  libId: string; // footprint lib id, e.g. "Resistor_SMD:R_0603_1608Metric"
  at: Point;
  rotation: number;
  side: BoardSide;
  // Pad number -> net name, resolved from the schematic netlist.
  padNets: Record<string, string>;
  // Block this part belongs to, so placement can keep a module together.
  blockId?: string;
}

export interface Track {
  uuid: string;
  layer: string; // "F.Cu" | "B.Cu" | "In1.Cu" ...
  width: number;
  start: Point;
  end: Point;
  net: string;
}

export interface Via {
  uuid: string;
  at: Point;
  size: number;
  drill: number;
  net: string;
}

export interface Zone {
  uuid: string;
  layer: string;
  net: string;
  // Polygon outline; the pour itself is filled by KiCad on open.
  polygon: Point[];
  // Where two pours share a layer, the higher priority takes the area.
  priority?: number;
  // The copper, computed by loon. KiCad's command line will not fill a zone,
  // so a zone without this is a zone the fab never sees.
  filled?: Point[][];
}

export interface DesignRules {
  name: string;
  minTrackWidth: number;
  minClearance: number;
  minDrill: number;
  minAnnularRing: number;
  layers: number;
  note: string;
}

// OSH Park two-layer prototype service, from their published design rules.
export const OSHPARK_2LAYER: DesignRules = {
  name: "OSH Park 2-layer prototype",
  minTrackWidth: 0.1524, // 6 mil
  minClearance: 0.1524, // 6 mil
  minDrill: 0.254, // 10 mil
  minAnnularRing: 0.127, // 5 mil
  layers: 2,
  note: "6 mil trace and space, 10 mil minimum drill, 5 mil annular ring, 1.6mm 1oz, purple mask. OSH Park takes the .kicad_pcb file directly.",
};

export const OSHPARK_4LAYER: DesignRules = {
  ...OSHPARK_2LAYER,
  name: "OSH Park 4-layer prototype",
  layers: 4,
  note: "Same 6 mil rules as the 2-layer service, on four layers.",
};

// Silkscreen text: what the board says about itself. A connector you cannot
// identify without the schematic is a connector someone will wire backwards.
export interface BoardText {
  at: Point;
  text: string;
  layer: string; // "F.SilkS" / "B.SilkS"
  size: number; // mm
  thickness?: number;
  rotation?: number;
  bold?: boolean;
}

export interface Board {
  version: number;
  generator: string;
  rules: DesignRules;
  // Board edge, in mm, clockwise.
  outline: Point[];
  footprints: PlacedFootprint[];
  tracks: Track[];
  vias: Via[];
  zones: Zone[];
  texts: BoardText[];
}

export function emptyBoard(rules: DesignRules = OSHPARK_2LAYER): Board {
  return {
    version: 20241229, // KiCad 9 board format, matching the pinned footprint library

    generator: "loon",
    rules,
    outline: [],
    footprints: [],
    texts: [],
    tracks: [],
    vias: [],
    zones: [],
  };
}

export function rectOutline(x: number, y: number, w: number, h: number): Point[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

export function boardBBox(board: Board): { min: Point; max: Point } {
  const pts = board.outline.length
    ? board.outline
    : board.footprints.map((f) => f.at).concat([{ x: 0, y: 0 }]);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { min: { x: Math.min(...xs), y: Math.min(...ys) }, max: { x: Math.max(...xs), y: Math.max(...ys) } };
}
