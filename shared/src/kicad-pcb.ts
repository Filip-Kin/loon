// #region .kicad_pcb codec
// Writes the board KiCad (and OSH Park, who take this file directly) will read.
// Footprints are emitted from their verbatim library S-expression with only
// placement, reference and pad nets injected, so the land patterns in the
// output are byte-for-byte KiCad's own rather than loon's reading of them.

import { serialize, parse, node, sym, str, num, list, find, findAll, type Sx, type SxList } from "./sexpr";
import { KICAD_PCB_VERSION, KICAD_PRO_VERSION, KICAD_NET_SETTINGS_VERSION } from "./kicad-version";
import type { Board, PlacedFootprint } from "./board";
import type { Point } from "./schematic";

function clone(sx: Sx): Sx {
  return sx.kind === "atom" ? { ...sx } : { kind: "list", items: sx.items.map(clone) };
}

function setChild(l: SxList, name: string, replacement: SxList) {
  const idx = l.items.findIndex((i) => i.kind === "list" && i.items[0]?.kind === "atom" && i.items[0].value === name);
  if (idx >= 0) l.items[idx] = replacement;
  else l.items.push(replacement);
}

function removeChildren(l: SxList, name: string) {
  l.items = l.items.filter((i) => !(i.kind === "list" && i.items[0]?.kind === "atom" && i.items[0].value === name));
}

// Property nodes differ between KiCad versions (fp_text vs property); set both
// where they exist so the reference shows up whichever reader opens it.
function setReference(fpNode: SxList, ref: string, value: string) {
  for (const p of findAll(fpNode, "property")) {
    const key = p.items[1]?.kind === "atom" ? p.items[1].value : "";
    if (key === "Reference") p.items[2] = str(ref);
    if (key === "Value") p.items[2] = str(value);
  }
  for (const t of findAll(fpNode, "fp_text")) {
    const kind = t.items[1]?.kind === "atom" ? t.items[1].value : "";
    if (kind === "reference") t.items[2] = str(ref);
    if (kind === "value") t.items[2] = str(value);
  }
}

// A footprint on the back is stored flipped: every F.* layer becomes B.* and
// the local X of every coordinate is mirrored, which is the same mirror loon's
// padWorld applies for side B. Text gets the mirror flag so it reads from
// the back. Without this KiCad draws the courtyard and silk on the front and
// reports every back-side part as overlapping its front-side neighbours.
const LAYER_FLIP: Record<string, string> = {};
for (const l of ["Cu", "Adhes", "Paste", "SilkS", "Mask", "CrtYd", "Fab"]) { LAYER_FLIP[`F.${l}`] = `B.${l}`; LAYER_FLIP[`B.${l}`] = `F.${l}`; }
function flipRaw(node: SxList): void {
  const head = node.items[0]?.kind === "atom" ? node.items[0].value : "";
  if (head === "layer" || head === "layers") {
    for (let i = 1; i < node.items.length; i++) {
      const it = node.items[i];
      if (it.kind === "atom" && LAYER_FLIP[it.value]) it.value = LAYER_FLIP[it.value];
    }
    return;
  }
  if (["at", "start", "end", "mid", "center", "xy"].includes(head)) {
    const x = node.items[1];
    if (x?.kind === "atom" && !isNaN(Number(x.value))) x.value = String(-Number(x.value));
    // the rotation of a mirrored item flips sign
    if (head === "at" && node.items[3]?.kind === "atom" && !isNaN(Number(node.items[3].value))) node.items[3].value = String(-Number(node.items[3].value));
    return;
  }
  if (head === "effects") {
    let justify = node.items.find((i) => i.kind === "list" && i.items[0]?.kind === "atom" && i.items[0].value === "justify") as SxList | undefined;
    if (!justify) { justify = list(sym("justify")); node.items.push(justify); }
    if (!justify.items.some((i) => i.kind === "atom" && i.value === "mirror")) justify.items.push(sym("mirror"));
    return;
  }
  for (const it of node.items) if (it.kind === "list") flipRaw(it);
}

function emitFootprint(f: PlacedFootprint, raw: SxList | undefined, netIndex: Map<string, number>, minDrill = 0): SxList {
  const fpNode = raw ? (clone(raw) as SxList) : list(sym("footprint"), str(f.libId));
  if (f.side === "B" && raw) for (const it of fpNode.items) if (it.kind === "list") flipRaw(it);
  // KiCad wants the library id on the footprint node itself.
  fpNode.items[1] = str(f.libId);
  setChild(fpNode, "at", node("at", num(f.at.x), num(f.at.y), num(f.rotation)));
  setChild(fpNode, "layer", node("layer", str(f.side === "B" ? "B.Cu" : "F.Cu")));
  setChild(fpNode, "uuid", node("uuid", str(f.uuid)));
  removeChildren(fpNode, "tstamp");
  setReference(fpNode, f.ref, f.value);

  for (const pad of findAll(fpNode, "pad")) {
    // Open any hole the fab cannot drill. The ESP32-S3 land pattern's thermal
    // vias are 0.2mm, under OSH Park's 0.254mm minimum, and every one of them
    // is a DRC error until it is enlarged.
    if (minDrill > 0) {
      const drill = find(pad, "drill");
      const v = drill?.items[1];
      if (drill && v && v.kind === "atom") {
        const d = parseFloat(v.value);
        if (!isNaN(d) && d > 0 && d < minDrill) drill.items[1] = num(minDrill);
      }
    }
    const number = pad.items[1]?.kind === "atom" ? pad.items[1].value : "";
    removeChildren(pad, "net");
    const net = f.padNets[number];
    if (net) {
      const idx = netIndex.get(net);
      if (idx !== undefined) pad.items.push(node("net", num(idx), str(net)));
    }
  }
  return fpNode;
}

export type Box = { min: { x: number; y: number }; max: { x: number; y: number } };
// The reference sits above the part on the board whatever the part's
// rotation: the land pattern puts it above its own outline, and a turned
// instance moves it to the local side that ends up on top, counter-turned
// so it reads upright.
function uprightReference(fpNode: SxList, rotation: number, box: Box | undefined) {
  if (!box) return;
  const r = ((rotation % 360) + 360) % 360;
  if (r === 0) return;
  const pad = 0.8;
  const at = r === 90 ? [box.max.x + pad, 0, 270] : r === 270 ? [box.min.x - pad, 0, 90] : r === 180 ? [0, box.max.y + pad, 180] : null;
  if (!at) return;
  for (const it of fpNode.items) {
    if (it.kind !== "list") continue;
    const head = it.items[0]?.kind === "atom" ? it.items[0].value : "";
    const isRef = (head === "property" && it.items[1]?.kind === "atom" && it.items[1].value === "Reference") || (head === "fp_text" && it.items[1]?.kind === "atom" && it.items[1].value === "reference");
    if (!isRef) continue;
    setChild(it, "at", node("at", num(at[0]), num(at[1]), num(at[2])));
  }
}

// Parts whose reference should not print (LEDs at the wall, where the
// text would land on a neighbour): the property is kept but hidden.
function hideReference(fpNode: SxList) {
  for (const it of fpNode.items) {
    if (it.kind !== "list") continue;
    const head = it.items[0]?.kind === "atom" ? it.items[0].value : "";
    const isRef = (head === "property" && it.items[1]?.kind === "atom" && it.items[1].value === "Reference") || (head === "fp_text" && it.items[1]?.kind === "atom" && it.items[1].value === "reference");
    if (!isRef) continue;
    removeChildren(it, "hide");
    it.items.push(node("hide", sym("yes")));
  }
}

export function serializeBoard(board: Board, rawFootprints: Record<string, SxList>, boxes: Record<string, Box> = {}, hideRefs: Set<string> = new Set()): string {
  const root = list(sym("kicad_pcb"));
  // Always the format loon writes today, not whatever the board was loaded at.
  // A board stamped with an older version opens with an upgrade prompt, and the
  // embedded footprints have to be written for the same version.
  root.items.push(node("version", num(KICAD_PCB_VERSION)));
  root.items.push(node("generator", str("loon")));
  root.items.push(node("generator_version", str("10.0")));

  const layerCount = board.rules.layers;
  const general = list(sym("general"), node("thickness", num(1.6)), node("legacy_teardrops", sym("no")));
  root.items.push(general);
  root.items.push(node("paper", str("A4")));

  const layers = list(sym("layers"));
  const copper: string[] = ["F.Cu"];
  for (let i = 1; i <= layerCount - 2; i++) copper.push(`In${i}.Cu`);
  copper.push("B.Cu");
  copper.forEach((name, i) => {
    layers.items.push(list(num(i === copper.length - 1 ? 31 : i), str(name), sym("signal")));
  });
  const tech: [number, string][] = [
    [32, "B.Adhes"], [33, "F.Adhes"], [34, "B.Paste"], [35, "F.Paste"],
    [36, "B.SilkS"], [37, "F.SilkS"], [38, "B.Mask"], [39, "F.Mask"],
    [40, "Dwgs.User"], [41, "Cmts.User"], [42, "Eco1.User"], [43, "Eco2.User"],
    [44, "Edge.Cuts"], [45, "Margin"], [46, "B.CrtYd"], [47, "F.CrtYd"],
    [48, "B.Fab"], [49, "F.Fab"],
  ];
  for (const [n, name] of tech) layers.items.push(list(num(n), str(name), sym("user")));
  root.items.push(layers);

  // Design rules, so KiCad's own DRC agrees with loon's.
  const setup = list(
    sym("setup"),
    node("pad_to_mask_clearance", num(0)),
    list(
      sym("pcbplotparams"),
      node("layerselection", sym("0x00010fc_ffffffff")),
      node("plot_on_all_layers_selection", sym("0x0000000_00000000")),
      node("disableapertmacros", sym("no")),
      node("usegerberextensions", sym("no")),
      node("usegerberattributes", sym("yes")),
      node("usegerberadvancedattributes", sym("yes")),
      node("creategerberjobfile", sym("yes")),
      node("svgprecision", num(4)),
      node("plotframeref", sym("no")),
      node("mode", num(1)),
      node("useauxorigin", sym("no")),
      node("dxfpolygonmode", sym("yes")),
      node("dxfimperialunits", sym("yes")),
      node("dxfusepcbnewfont", sym("yes")),
      node("psnegative", sym("no")),
      node("psa4output", sym("no")),
      node("plotreference", sym("yes")),
      node("plotvalue", sym("yes")),
      node("plotinvisibletext", sym("no")),
      node("sketchpadsonfab", sym("no")),
      node("subtractmaskfromsilk", sym("no")),
      node("outputformat", num(1)),
      node("mirror", sym("no")),
      node("drillshape", num(1)),
      node("scaleselection", num(1)),
      node("outputdirectory", str("")),
    ),
  );
  root.items.push(setup);

  // Nets must be declared before they are used, index 0 is the no-net.
  const netNames = new Set<string>();
  for (const f of board.footprints) for (const n of Object.values(f.padNets)) netNames.add(n);
  for (const t of board.tracks) if (t.net) netNames.add(t.net);
  for (const v of board.vias) if (v.net) netNames.add(v.net);
  for (const z of board.zones) if (z.net) netNames.add(z.net);
  const netIndex = new Map<string, number>();
  root.items.push(list(sym("net"), num(0), str("")));
  let i = 1;
  for (const name of [...netNames].sort()) {
    netIndex.set(name, i);
    root.items.push(list(sym("net"), num(i), str(name)));
    i++;
  }

  for (const f of board.footprints) {
    const fpNode = emitFootprint(f, rawFootprints[f.libId], netIndex, board.rules.minDrill);
    if (f.side !== "B") uprightReference(fpNode, f.rotation, boxes[f.libId]);
    if (hideRefs.has(f.ref)) hideReference(fpNode);
    root.items.push(fpNode);
  }

  // Silkscreen text.
  for (const t of board.texts ?? []) {
    root.items.push(
      list(
        sym("gr_text"),
        str(t.text),
        node("at", num(t.at.x), num(t.at.y), num(t.rotation ?? 0)),
        node("layer", str(t.layer)),
        node("uuid", str(t.uuid ?? crypto.randomUUID())),
        list(
          sym("effects"),
          list(
            sym("font"),
            node("size", num(t.size), num(t.size)),
            node("thickness", num(t.thickness ?? Math.max(0.12, t.size * 0.15))),
            ...(t.bold ? [node("bold", sym("yes"))] : []),
          ),
          node("justify", sym("left")),
        ),
      ),
    );
  }

  // Board outline on Edge.Cuts.
  const outline = board.outline;
  for (let k = 0; k < outline.length; k++) {
    const a = outline[k];
    const b = outline[(k + 1) % outline.length];
    root.items.push(
      list(
        sym("gr_line"),
        node("start", num(a.x), num(a.y)),
        node("end", num(b.x), num(b.y)),
        node("stroke", node("width", num(0.1)), node("type", sym("default"))),
        node("layer", str("Edge.Cuts")),
        node("uuid", str(crypto.randomUUID())),
      ),
    );
  }

  for (const t of board.tracks) {
    root.items.push(
      list(
        sym("segment"),
        node("start", num(t.start.x), num(t.start.y)),
        node("end", num(t.end.x), num(t.end.y)),
        node("width", num(t.width)),
        node("layer", str(t.layer)),
        node("net", num(netIndex.get(t.net) ?? 0)),
        node("uuid", str(t.uuid)),
      ),
    );
  }

  for (const v of board.vias) {
    root.items.push(
      list(
        sym("via"),
        node("at", num(v.at.x), num(v.at.y)),
        node("size", num(v.size)),
        node("drill", num(v.drill)),
        node("layers", str("F.Cu"), str("B.Cu")),
        node("net", num(netIndex.get(v.net) ?? 0)),
        node("uuid", str(v.uuid)),
      ),
    );
  }

  for (const z of board.zones) {
    const poly = list(sym("pts"), ...z.polygon.map((p) => node("xy", num(p.x), num(p.y))));
    root.items.push(
      list(
        sym("zone"),
        node("net", num(netIndex.get(z.net) ?? 0)),
        node("net_name", str(z.net)),
        // KiCad writes a zone's layer as "layers", plural, even for one layer.
        // Read back from "layer" the zone lands on no layer at all, fills into
        // nothing, and connects nothing.
        node("layers", str(z.layer)),
        node("uuid", str(z.uuid)),
        node("hatch", sym("edge"), num(0.5)),
        ...(z.priority ? [node("priority", num(z.priority))] : []),
        // Solid connections to the zone's own pads, so KiCad does not expect
        // thermal spokes and then report them as starved. The clearance here is
        // the gap held around pads that are NOT on this net: zero shorts the
        // pour to every pad it touches.
        list(sym("connect_pads"), sym("yes"), node("clearance", num(board.rules.minClearance))),
        node("min_thickness", num(board.rules.minTrackWidth)),
        // Without this KiCad reads the zone as a legacy fill, strokes the
        // outline instead of filling the area, and the pour connects nothing.
        node("filled_areas_thickness", sym("no")),
        // Islands: a scrap of pour between two tracks that touches no pad is
        // not copper, it is an antenna. Mode 0 drops them.
        list(
          sym("fill"),
          sym("yes"),
          node("thermal_gap", num(0.5)),
          node("thermal_bridge_width", num(0.5)),
          node("island_removal_mode", num(0)),
        ),
        list(sym("polygon"), poly),
        ...(z.filled ?? []).map((shape) =>
          list(
            sym("filled_polygon"),
            node("layer", str(z.layer)),
            list(sym("pts"), ...shape.map((p) => node("xy", num(p.x), num(p.y)))),
          ),
        ),
      ),
    );
  }

  return serialize(root);
}

// KiCad keeps DRC constraints in the project file, not the board, so without
// this KiCad checks against its own defaults instead of the fab's rules.
export function serializeProject(board: Board, name: string): string {
  const r = board.rules;
  return JSON.stringify(
    {
      board: { design_settings: {
        defaults: { board_outline_line_width: 0.1, copper_line_width: 0.2, silk_line_width: 0.12 },
        rules: {
          min_clearance: Math.min(r.minClearance, 0.15),
          min_copper_edge_clearance: 0.3,
          min_hole_clearance: 0.25,
          min_through_hole_diameter: r.minDrill,
          min_track_width: r.minTrackWidth,
          min_via_annular_width: r.minAnnularRing,
          min_via_diameter: r.minDrill + r.minAnnularRing * 2,
        },
        track_widths: [0, r.minTrackWidth, 0.25, 0.5, 1.0, 2.0],
        via_dimensions: [{ diameter: 0.6, drill: r.minDrill }],
      } },
      meta: { filename: `${name}.kicad_pro`, version: KICAD_PRO_VERSION },
      net_settings: {
        classes: [
          {
            name: "Default",
            clearance: Math.min(r.minClearance, 0.15),
            track_width: 0.25,
            via_diameter: 0.6,
            via_drill: r.minDrill,
            microvia_diameter: 0.3,
            microvia_drill: 0.1,
            diff_pair_gap: 0.25,
            diff_pair_width: 0.2,
            line_style: 0,
            pcb_color: "rgba(0, 0, 0, 0.000)",
            schematic_color: "rgba(0, 0, 0, 0.000)",
            wire_width: 6,
            bus_width: 12,
            priority: 2147483647,
          },
        ],
        meta: { version: KICAD_NET_SETTINGS_VERSION },
      },
      sheets: [],
      text_variables: {},
    },
    null,
    2,
  );
}

// Minimal reader: enough to reopen a board loon wrote, or to keep a board KiCad
// touched from being thrown away.
export function parseBoardTracks(text: string): { tracks: number; footprints: number } {
  const root = parse(text);
  return { tracks: findAll(root, "segment").length, footprints: findAll(root, "footprint").length };
}

export function outlineFromText(text: string): Point[] {
  const root = parse(text);
  const pts: Point[] = [];
  for (const l of findAll(root, "gr_line")) {
    const layer = find(l, "layer");
    const name = layer?.items[1]?.kind === "atom" ? layer.items[1].value : "";
    if (name !== "Edge.Cuts") continue;
    const s = find(l, "start");
    if (s) pts.push({ x: Number((s.items[1] as any).value), y: Number((s.items[2] as any).value) });
  }
  return pts;
}

// #region zone fills
// KiCad computes a pour's real copper and writes it back into the board file.
// Reading it in again is what lets the layout view draw what the fab will get
// rather than an empty outline with a promise in it.
export function readZoneFills(text: string): { net: string; layer: string; polys: Point[][] }[] {
  const root = parse(text);
  const out: { net: string; layer: string; polys: Point[][] }[] = [];
  for (const z of findAll(root, "zone")) {
    const netNode = find(z, "net_name");
    const net = netNode?.items[1]?.kind === "atom" ? netNode.items[1].value : "";
    const layNode = find(z, "layers") ?? find(z, "layer");
    const layer = layNode?.items[1]?.kind === "atom" ? layNode.items[1].value : "";
    const polys: Point[][] = [];
    for (const fp of findAll(z, "filled_polygon")) {
      const pts = find(fp, "pts");
      if (!pts) continue;
      const ring: Point[] = [];
      for (const xy of findAll(pts, "xy")) {
        const x = xy.items[1]?.kind === "atom" ? Number(xy.items[1].value) : NaN;
        const y = xy.items[2]?.kind === "atom" ? Number(xy.items[2].value) : NaN;
        if (!isNaN(x) && !isNaN(y)) ring.push({ x, y });
      }
      if (ring.length > 2) polys.push(ring);
    }
    if (polys.length) out.push({ net, layer, polys });
  }
  return out;
}
