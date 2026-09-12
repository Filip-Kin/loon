// #region Symbol generation
// Builds a rectangular IC-style LibSymbol from a plain pin list. This is the
// escape hatch that stops the assistant from substituting a generic header
// whenever a part is missing from the builtin catalog: any chip, module or
// connector can be declared by its pins and used immediately, on the sheet and
// in the saved .kicad_sch.
//
// Coordinates follow the KiCad symbol convention: local space, Y-up, origin at
// the middle of the body. A pin's `at` is the wire connection point (outside
// the body) and its rotation points back toward the body.

import type { LibSymbol, SymGraphic, SymPin, PinType, Point } from "./schematic";

export type IcPinSide = "left" | "right" | "top" | "bottom";

export interface IcPinSpec {
  number: string;
  name: string;
  type?: PinType;
  side?: IcPinSide;
}

export interface IcSymbolSpec {
  // Fully qualified id, e.g. "RF_Module:ESP32-S3-WROOM-1".
  libId: string;
  refPrefix?: string;
  value?: string;
  description?: string;
  keywords?: string;
  datasheet?: string;
  footprint?: string;
  pins: IcPinSpec[];
}

const PIN_LEN = 2.54;
const PITCH = 2.54;
// Rough advance width of the 1.27mm KiCad pin-name font, for body sizing.
const CHAR_W = 0.85;

// Power/ground names get a power_in type automatically so ERC and the
// assistant both see them as rails rather than signals.
function inferType(name: string, given?: PinType): PinType {
  if (given) return given;
  const n = name.toUpperCase();
  if (/^(GND|VSS|AGND|DGND|EPAD|PAD|VEE)/.test(n)) return "power_in";
  if (/^(VCC|VDD|VIN|VBUS|VBAT|3V3|5V|\+?\d+V\d*)/.test(n)) return "power_in";
  if (/^(VOUT|VO)$/.test(n)) return "power_out";
  return "bidirectional";
}

function sideFor(p: IcPinSpec, index: number, total: number): IcPinSide {
  if (p.side) return p.side;
  return index < Math.ceil(total / 2) ? "left" : "right";
}

export function buildIcSymbol(spec: IcSymbolSpec): LibSymbol {
  const pinsIn = spec.pins ?? [];
  const grouped: Record<IcPinSide, IcPinSpec[]> = { left: [], right: [], top: [], bottom: [] };
  pinsIn.forEach((p, i) => grouped[sideFor(p, i, pinsIn.length)].push(p));

  const rows = Math.max(grouped.left.length, grouped.right.length, 1);
  const cols = Math.max(grouped.top.length, grouped.bottom.length, 0);

  const nameW = (list: IcPinSpec[]) => list.reduce((m, p) => Math.max(m, p.name.length), 0) * CHAR_W;
  const needW = nameW(grouped.left) + nameW(grouped.right) + 6.35;
  const colW = cols > 0 ? (cols + 1) * PITCH : 0;
  const width = Math.max(15.24, colW, Math.ceil(needW / PITCH) * PITCH);
  const height = Math.max(10.16, (rows + 1) * PITCH);
  const halfW = width / 2;
  const halfH = height / 2;

  const graphics: SymGraphic[] = [
    { type: "rect", a: { x: -halfW, y: -halfH }, b: { x: halfW, y: halfH }, fill: "background" },
  ];

  const pins: SymPin[] = [];
  const top = ((rows - 1) * PITCH) / 2;
  const place = (p: IcPinSpec, at: Point, rotation: number) => {
    pins.push({
      number: p.number,
      name: p.name,
      type: inferType(p.name, p.type),
      at,
      rotation,
      length: PIN_LEN,
    });
  };

  grouped.left.forEach((p, i) => place(p, { x: -halfW - PIN_LEN, y: top - i * PITCH }, 0));
  grouped.right.forEach((p, i) => place(p, { x: halfW + PIN_LEN, y: top - i * PITCH }, 180));
  const colStart = -((cols - 1) * PITCH) / 2;
  grouped.top.forEach((p, i) => place(p, { x: colStart + i * PITCH, y: halfH + PIN_LEN }, 270));
  grouped.bottom.forEach((p, i) => place(p, { x: colStart + i * PITCH, y: -halfH - PIN_LEN }, 90));

  const defaults: Record<string, string> = {
    Value: spec.value ?? spec.libId.split(":")[1] ?? spec.libId,
  };
  if (spec.footprint) defaults.Footprint = spec.footprint;

  let minx = -halfW - PIN_LEN, maxx = halfW + PIN_LEN;
  let miny = -halfH - (grouped.bottom.length ? PIN_LEN : 0);
  let maxy = halfH + (grouped.top.length ? PIN_LEN : 0);
  for (const p of pins) {
    minx = Math.min(minx, p.at.x); maxx = Math.max(maxx, p.at.x);
    miny = Math.min(miny, p.at.y); maxy = Math.max(maxy, p.at.y);
  }

  return {
    libId: spec.libId,
    refPrefix: spec.refPrefix ?? "U",
    description: spec.description ?? "",
    keywords: spec.keywords ?? "",
    datasheet: spec.datasheet ?? "~",
    defaults,
    graphics,
    pins,
    bbox: { min: { x: minx, y: miny }, max: { x: maxx, y: maxy } },
  };
}
