// #region KiCad .kicad_sch codec
// Converts between Loon's schematic model and KiCad's S-expression format.
// Symbol graphics/pins are parsed for rendering; the original symbol
// definition S-expr is preserved verbatim (libRaw) so saved files embed
// byte-faithful lib_symbols that open cleanly in KiCad.

import {
  parse,
  serialize,
  node,
  sym,
  str,
  num,
  list,
  find,
  findAll,
  value,
  values,
  numAt,
  type Sx,
  type SxList,
} from "./sexpr";
import type {
  Schematic,
  LibSymbol,
  SymGraphic,
  SymPin,
  PinType,
  SymbolInstance,
  Wire,
  Junction,
  NoConnect,
  Label,
  LabelKind,
  Point,
} from "./schematic";

// #region lib symbol parsing
function fillOf(l: SxList): string | undefined {
  const f = find(l, "fill");
  if (!f) return undefined;
  return value(f, "type");
}

function ptsOf(l: SxList): Point[] {
  const p = find(l, "pts");
  if (!p) return [];
  return findAll(p, "xy").map((xy) => ({ x: numAt(xy, 1), y: numAt(xy, 2) }));
}

function pointOf(l: SxList, name: string): Point {
  const c = find(l, name);
  if (!c) return { x: 0, y: 0 };
  return { x: numAt(c, 1), y: numAt(c, 2) };
}

function parsePin(l: SxList): SymPin {
  const type = (l.items[1]?.kind === "atom" ? l.items[1].value : "passive") as PinType;
  const at = find(l, "at");
  const nameL = find(l, "name");
  const numberL = find(l, "number");
  return {
    type,
    at: { x: at ? numAt(at, 1) : 0, y: at ? numAt(at, 2) : 0 },
    rotation: at ? numAt(at, 3) : 0,
    length: parseFloat(value(l, "length") ?? "2.54"),
    name: nameL?.items[1]?.kind === "atom" ? nameL.items[1].value : "~",
    number: numberL?.items[1]?.kind === "atom" ? numberL.items[1].value : "",
  };
}

function collectFromUnit(unit: SxList, graphics: SymGraphic[], pins: SymPin[]) {
  for (const it of unit.items) {
    if (it.kind !== "list" || it.items[0]?.kind !== "atom") continue;
    const head = it.items[0].value;
    switch (head) {
      case "rectangle":
        graphics.push({ type: "rect", a: pointOf(it, "start"), b: pointOf(it, "end"), fill: fillOf(it) });
        break;
      case "polyline":
        graphics.push({ type: "polyline", pts: ptsOf(it), fill: fillOf(it) });
        break;
      case "circle":
        graphics.push({ type: "circle", center: pointOf(it, "center"), radius: parseFloat(value(it, "radius") ?? "0"), fill: fillOf(it) });
        break;
      case "arc":
        graphics.push({ type: "arc", start: pointOf(it, "start"), mid: pointOf(it, "mid"), end: pointOf(it, "end") });
        break;
      case "text": {
        const t = it.items[1]?.kind === "atom" ? it.items[1].value : "";
        const eff = find(it, "effects");
        const fontSize = eff ? parseFloat(value(find(eff, "font") ?? eff, "size") ?? "1.27") : 1.27;
        graphics.push({ type: "text", at: pointOf(it, "at"), text: t, size: fontSize });
        break;
      }
      case "pin":
        pins.push(parsePin(it));
        break;
      case "symbol":
        // Nested sub-unit (graphics/pins for a unit). Recurse.
        collectFromUnit(it, graphics, pins);
        break;
      default:
        break;
    }
  }
}

export function parseLibSymbol(l: SxList): LibSymbol {
  const libId = l.items[1]?.kind === "atom" ? l.items[1].value : "unknown";
  const graphics: SymGraphic[] = [];
  const pins: SymPin[] = [];
  collectFromUnit(l, graphics, pins);

  const defaults: Record<string, string> = {};
  let refPrefix = "U";
  let description = "";
  let keywords = "";
  let datasheet = "";
  for (const prop of findAll(l, "property")) {
    const key = prop.items[1]?.kind === "atom" ? prop.items[1].value : "";
    const val = prop.items[2]?.kind === "atom" ? prop.items[2].value : "";
    // Keep the designator prefix as-is minus trailing digits, so power
    // symbols retain their leading '#': "#PWR" stays "#PWR", "R" stays "R".
    if (key === "Reference") refPrefix = val.replace(/\d+$/, "") || "U";
    else if (key === "ki_description") description = val;
    else if (key === "ki_keywords") keywords = val;
    else if (key === "Datasheet") datasheet = val;
    else if (key === "ki_fp_filters") {
      /* ignore */
    } else defaults[key] = val;
  }

  // bbox from graphics + pin endpoints.
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  const acc = (p: Point) => {
    minx = Math.min(minx, p.x); miny = Math.min(miny, p.y);
    maxx = Math.max(maxx, p.x); maxy = Math.max(maxy, p.y);
  };
  for (const g of graphics) {
    if (g.type === "rect") { acc(g.a); acc(g.b); }
    else if (g.type === "polyline") g.pts.forEach(acc);
    else if (g.type === "circle") { acc({ x: g.center.x - g.radius, y: g.center.y - g.radius }); acc({ x: g.center.x + g.radius, y: g.center.y + g.radius }); }
    else if (g.type === "arc") { acc(g.start); acc(g.mid); acc(g.end); }
    else if (g.type === "text") acc(g.at);
  }
  for (const p of pins) acc(p.at);
  if (!isFinite(minx)) { minx = -2.54; miny = -2.54; maxx = 2.54; maxy = 2.54; }

  return {
    libId,
    refPrefix,
    description,
    keywords,
    datasheet,
    defaults,
    graphics,
    pins,
    bbox: { min: { x: minx, y: miny }, max: { x: maxx, y: maxy } },
  };
}

// #region property serialization
function effects(size = 1.27, extra: Sx[] = []): SxList {
  return node("effects", node("font", node("size", num(size), num(size))), ...extra);
}

function propNode(key: string, val: string, at: Point, rot = 0, hide = false): SxList {
  const items: Sx[] = [
    str(key),
    str(val),
    node("at", num(at.x), num(at.y), num(rot)),
    effects(1.27, hide ? [sym("hide")] : []),
  ];
  return list(sym("property"), ...items);
}

// #region schematic serialization
export function serializeSchematic(schem: Schematic, libRaw: Record<string, SxList>): string {
  const root: SxList = list(sym("kicad_sch"));
  const push = (n: Sx) => root.items.push(n);

  push(node("version", num(schem.version)));
  push(node("generator", str(schem.generator)));
  push(node("uuid", str(schem.uuid)));
  push(node("paper", str(schem.paper)));

  if (schem.title || schem.company || schem.rev) {
    const tb: Sx[] = [];
    if (schem.title) tb.push(node("title", str(schem.title)));
    if (schem.company) tb.push(node("company", str(schem.company)));
    if (schem.rev) tb.push(node("rev", str(schem.rev)));
    push(list(sym("title_block"), ...tb));
  }

  // lib_symbols: embed the verbatim definition for each used lib_id.
  const usedLibIds = Array.from(new Set(schem.symbols.map((s) => s.libId)));
  const libSymsNode = list(sym("lib_symbols"));
  for (const libId of usedLibIds) {
    const raw = libRaw[libId];
    if (raw) libSymsNode.items.push(raw);
  }
  push(libSymsNode);

  // symbol instances
  for (const s of schem.symbols) {
    const symNode = list(sym("symbol"));
    symNode.items.push(node("lib_id", str(s.libId)));
    symNode.items.push(node("at", num(s.at.x), num(s.at.y), num(s.rotation)));
    if (s.mirror) symNode.items.push(node("mirror", sym(s.mirror)));
    symNode.items.push(node("unit", num(s.unit)));
    symNode.items.push(node("in_bom", sym("yes")));
    symNode.items.push(node("on_board", sym("yes")));
    symNode.items.push(node("dnp", sym("no")));
    symNode.items.push(node("uuid", str(s.uuid)));
    let propIdx = 0;
    for (const [k, v] of Object.entries(s.properties)) {
      const at: Point = { x: s.at.x, y: s.at.y - 2.54 - propIdx * 2.54 };
      symNode.items.push(propNode(k, v, at, 0, k === "Footprint" || k === "Datasheet"));
      propIdx++;
    }
    const ref = s.properties.Reference ?? "?";
    symNode.items.push(
      node("instances", node("project", str(schem.generator),
        node("path", str("/" + schem.uuid), node("reference", str(ref)), node("unit", num(s.unit))))),
    );
    push(symNode);
  }

  // wires
  for (const w of schem.wires) {
    const ptsNode = list(sym("pts"), ...w.pts.map((p) => node("xy", num(p.x), num(p.y))));
    push(node("wire", ptsNode, node("stroke", node("width", num(0)), node("type", sym("default"))), node("uuid", str(w.uuid))));
  }

  // junctions
  for (const j of schem.junctions) {
    push(node("junction", node("at", num(j.at.x), num(j.at.y)), node("diameter", num(0)), node("uuid", str(j.uuid))));
  }

  // no-connects
  for (const nc of schem.noConnects) {
    push(node("no_connect", node("at", num(nc.at.x), num(nc.at.y)), node("uuid", str(nc.uuid))));
  }

  // labels
  for (const lb of schem.labels) {
    const head = lb.kind === "global" ? "global_label" : lb.kind === "hier" ? "hierarchical_label" : "label";
    const items: Sx[] = [str(lb.text), node("at", num(lb.at.x), num(lb.at.y), num(lb.rotation))];
    if (lb.kind !== "local") items.splice(1, 0, node("shape", sym("input")));
    items.push(effects(1.27, [node("justify", sym("left"), sym("bottom"))]));
    items.push(node("uuid", str(lb.uuid)));
    push(list(sym(head), ...items));
  }

  // text annotations
  for (const t of schem.texts ?? []) {
    push(list(sym("text"), str(t.text), node("at", num(t.at.x), num(t.at.y), num(t.rotation)), effects(t.size), node("uuid", str(t.uuid))));
  }

  push(node("sheet_instances", node("path", str("/"), node("page", str("1")))));

  return serialize(root) + "\n";
}

// #region schematic parsing
function parseInstance(l: SxList): SymbolInstance {
  const libId = value(l, "lib_id") ?? "unknown";
  const at = find(l, "at");
  const props: Record<string, string> = {};
  for (const p of findAll(l, "property")) {
    const k = p.items[1]?.kind === "atom" ? p.items[1].value : "";
    const v = p.items[2]?.kind === "atom" ? p.items[2].value : "";
    if (k) props[k] = v;
  }
  const mirror = value(l, "mirror") as "x" | "y" | undefined;
  return {
    uuid: value(l, "uuid") ?? crypto.randomUUID(),
    libId,
    at: { x: at ? numAt(at, 1) : 0, y: at ? numAt(at, 2) : 0 },
    rotation: at ? numAt(at, 3) : 0,
    mirror: mirror ?? null,
    unit: parseInt(value(l, "unit") ?? "1", 10),
    properties: props,
  };
}

export function parseSchematic(text: string): { schem: Schematic; libRaw: Record<string, SxList> } {
  const root = parse(text);
  const libRaw: Record<string, SxList> = {};
  const libSymbols: Record<string, LibSymbol> = {};
  const libNode = find(root, "lib_symbols");
  if (libNode) {
    for (const s of findAll(libNode, "symbol")) {
      const parsed = parseLibSymbol(s);
      libRaw[parsed.libId] = s;
      libSymbols[parsed.libId] = parsed;
    }
  }

  const symbols: SymbolInstance[] = findAll(root, "symbol").map(parseInstance);

  const wires: Wire[] = findAll(root, "wire").map((w) => ({
    uuid: value(w, "uuid") ?? crypto.randomUUID(),
    pts: ptsOf(w),
  }));

  const junctions: Junction[] = findAll(root, "junction").map((j) => {
    const at = find(j, "at");
    return { uuid: value(j, "uuid") ?? crypto.randomUUID(), at: { x: at ? numAt(at, 1) : 0, y: at ? numAt(at, 2) : 0 } };
  });

  const noConnects: NoConnect[] = findAll(root, "no_connect").map((n) => {
    const at = find(n, "at");
    return { uuid: value(n, "uuid") ?? crypto.randomUUID(), at: { x: at ? numAt(at, 1) : 0, y: at ? numAt(at, 2) : 0 } };
  });

  const labels: Label[] = [];
  for (const [head, kind] of [["label", "local"], ["global_label", "global"], ["hierarchical_label", "hier"]] as [string, LabelKind][]) {
    for (const lb of findAll(root, head)) {
      const at = find(lb, "at");
      labels.push({
        uuid: value(lb, "uuid") ?? crypto.randomUUID(),
        kind,
        text: lb.items[1]?.kind === "atom" ? lb.items[1].value : "",
        at: { x: at ? numAt(at, 1) : 0, y: at ? numAt(at, 2) : 0 },
        rotation: at ? numAt(at, 3) : 0,
      });
    }
  }

  const texts = findAll(root, "text").map((t) => {
    const at = find(t, "at");
    const eff = find(t, "effects");
    const size = eff ? parseFloat(value(find(eff, "font") ?? eff, "size") ?? "1.27") : 1.27;
    return {
      uuid: value(t, "uuid") ?? crypto.randomUUID(),
      text: t.items[1]?.kind === "atom" ? t.items[1].value : "",
      at: { x: at ? numAt(at, 1) : 0, y: at ? numAt(at, 2) : 0 },
      rotation: at ? numAt(at, 3) : 0,
      size,
    };
  });

  const tb = find(root, "title_block");
  const schem: Schematic = {
    version: parseInt(value(root, "version") ?? "20231120", 10),
    generator: value(root, "generator") ?? "loon",
    uuid: value(root, "uuid") ?? crypto.randomUUID(),
    paper: value(root, "paper") ?? "A4",
    libSymbols,
    symbols,
    wires,
    junctions,
    noConnects,
    labels,
    texts,
    title: tb ? value(tb, "title") : undefined,
    company: tb ? value(tb, "company") : undefined,
    rev: tb ? value(tb, "rev") : undefined,
  };

  return { schem, libRaw };
}
