// #region .kicad_pcb codec
// Writes the board KiCad (and OSH Park, who take this file directly) will read.
// Footprints are emitted from their verbatim library S-expression with only
// placement, reference and pad nets injected, so the land patterns in the
// output are byte-for-byte KiCad's own rather than loon's reading of them.

import { serialize, parse, node, sym, str, num, list, find, findAll, type Sx, type SxList } from "./sexpr";
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

function emitFootprint(f: PlacedFootprint, raw: SxList | undefined, netIndex: Map<string, number>, minDrill = 0): SxList {
  const fpNode = raw ? (clone(raw) as SxList) : list(sym("footprint"), str(f.libId));
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

export function serializeBoard(board: Board, rawFootprints: Record<string, SxList>): string {
  const root = list(sym("kicad_pcb"));
  // Board format version must match what the embedded footprints were written
  // for, or KiCad refuses the file outright.
  root.items.push(node("version", num(board.version)));
  root.items.push(node("generator", str("loon")));
  root.items.push(node("generator_version", str("1.0")));

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

  for (const f of board.footprints) root.items.push(emitFootprint(f, rawFootprints[f.libId], netIndex, board.rules.minDrill));

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
        node("layer", str(z.layer)),
        node("uuid", str(z.uuid)),
        node("hatch", sym("edge"), num(0.5)),
        list(sym("connect_pads"), node("clearance", num(board.rules.minClearance))),
        node("min_thickness", num(board.rules.minTrackWidth)),
        list(sym("fill"), sym("yes"), node("thermal_gap", num(0.5)), node("thermal_bridge_width", num(0.5))),
        list(sym("polygon"), poly),
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
      meta: { filename: `${name}.kicad_pro`, version: 3 },
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
          },
        ],
        meta: { version: 3 },
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
