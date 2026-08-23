// #region Schematic model
// Loon's in-memory schematic model. It maps closely to KiCad's .kicad_sch so
// serialization stays faithful, but it is shaped for a live editor and for the
// AI to reason about (stable ids, flat lists, plain numbers).

export type Point = { x: number; y: number };

// Graphic primitives that make up a symbol's body, parsed from a KiCad
// symbol definition. Coordinates are in the symbol's local space (mm),
// y-up like KiCad symbol libraries.
export type SymGraphic =
  | { type: "rect"; a: Point; b: Point; fill?: string }
  | { type: "polyline"; pts: Point[]; fill?: string }
  | { type: "circle"; center: Point; radius: number; fill?: string }
  | { type: "arc"; start: Point; mid: Point; end: Point }
  | { type: "text"; at: Point; text: string; size: number };

export type PinType =
  | "input"
  | "output"
  | "bidirectional"
  | "power_in"
  | "power_out"
  | "passive"
  | "unspecified"
  | "no_connect";

export interface SymPin {
  // Pin number as printed (e.g. "1", "A0", "VCC").
  number: string;
  name: string;
  type: PinType;
  // Endpoint where wires connect, in symbol local space.
  at: Point;
  // Rotation of the pin stub in degrees (0 = pointing right/east from `at`).
  rotation: number;
  length: number;
}

// A reusable symbol definition (what KiCad calls a lib_symbol).
export interface LibSymbol {
  // Fully qualified id, e.g. "Device:R".
  libId: string;
  // Default reference designator prefix, e.g. "R", "C", "U".
  refPrefix: string;
  description?: string;
  keywords?: string;
  datasheet?: string;
  // Default property values (Value, Footprint, etc.).
  defaults: Record<string, string>;
  graphics: SymGraphic[];
  pins: SymPin[];
  // Bounding box in local space, precomputed for hit-testing/placement.
  bbox: { min: Point; max: Point };
}

// A placed instance of a symbol on the schematic.
export interface SymbolInstance {
  uuid: string;
  libId: string;
  // Placement in schematic space (mm). rotation in degrees CCW.
  at: Point;
  rotation: number;
  mirror?: "x" | "y" | null;
  unit: number;
  properties: Record<string, string>; // includes Reference, Value, Footprint
}

export interface Wire {
  uuid: string;
  pts: Point[];
}

export interface Junction {
  uuid: string;
  at: Point;
}

export interface NoConnect {
  uuid: string;
  at: Point;
}

export type LabelKind = "local" | "global" | "hier";

export interface Label {
  uuid: string;
  kind: LabelKind;
  text: string;
  at: Point;
  rotation: number;
}

export interface Schematic {
  version: number;
  generator: string;
  uuid: string;
  paper: string; // "A4", "A3", "USLetter", ...
  // Only the lib_symbols actually used by instances are embedded on save.
  libSymbols: Record<string, LibSymbol>;
  symbols: SymbolInstance[];
  wires: Wire[];
  junctions: Junction[];
  noConnects: NoConnect[];
  labels: Label[];
  // Free-form title-block metadata.
  title?: string;
  company?: string;
  rev?: string;
}

export function emptySchematic(uuid: string): Schematic {
  return {
    version: 20231120,
    generator: "loon",
    uuid,
    paper: "A4",
    libSymbols: {},
    symbols: [],
    wires: [],
    junctions: [],
    noConnects: [],
    labels: [],
  };
}
