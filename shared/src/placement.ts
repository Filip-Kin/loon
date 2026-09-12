// #region Placement
// A grid of footprints is not a layout, and neither is a packer. This places a
// board the way the layout guides do, and the order matters:
//
//   1. Parts that form a circuit are placed as one cluster, chip first, its
//      decoupling within a couple of mm of the pin it serves. A bypass cap
//      70mm from its chip is decoration.
//   2. Clusters go into zones - power, digital, RF, connectors - because a
//      switching node next to a microcontroller is how you get a board that
//      only works on the bench.
//   3. Connectors sit on the board edge where wire can reach them, with each
//      channel's breaker and switch inline behind its own terminal.
//   4. Everything lands on one grid, and repeated circuits repeat exactly.
//
// The last point is the aesthetic one, and it is not decoration either: a board
// that reads as columns and rows is a board you can probe, rework and explain.

import type { Point } from "./schematic";
import type { Footprint } from "./footprint";
import type { Board, PlacedFootprint } from "./board";
import type { Netlist } from "./netlist";

export type Role =
  | "lug"
  | "terminal"
  | "fuse"
  | "switch"
  | "converter"
  | "mcu"
  | "rf"
  | "logic"
  | "usb"
  | "button"
  | "passive"
  | "other";

// #region constants
const GRID = 0.5; // every part lands on this, so the board reads as a grid
const EDGE = 8; // mm of margin around the content, room for mounting hardware
const HOLE_INSET = 4; // mm from the board edge to a mounting hole centre
const CLUSTER_GAP = 0.6; // mm between parts inside one cluster: keep it tight
const ZONE_GAP = 8; // mm between zones, the gutter that keeps power off logic
const COL_GAP = 2.5; // mm between two channel columns
const LUG_GAP = 14; // mm between two studs: a ring terminal and a spanner need it
const LUG_INSET = 6; // mm further in than everything else: the ring overhangs the stud
const CRT = 0.3; // courtyards already stand off; this is the hair on top

const snap = (v: number) => Math.round(v / GRID) * GRID;

export function roleOf(f: PlacedFootprint, fp?: Footprint): Role {
  const v = `${f.value} ${f.libId}`.toLowerCase();
  const ref = f.ref.toUpperCase();
  if (/lug|stud|busbar/.test(v) || /mountinghole.*pad/.test(v)) return "lug";
  if (ref.startsWith("F") || /fuse|ato|breaker/.test(v)) return "fuse";
  if (/tps27s|high.?side|power_switch/.test(v)) return "switch";
  if (/usb/.test(v)) return "usb";
  if (/esp32|rp2040|stm32|atmega/.test(v)) return "mcu";
  if (/nrf24|rfm|lora|radio|antenna/.test(v)) return "rf";
  if (/regulator|tps54|lm5175|ap2112|ldo|buck/.test(v)) return "converter";
  if (/logic_|74lvc|flipflop|latch/.test(v)) return "logic";
  // An Ethernet controller is digital logic, and its jack belongs beside it.
  if (/w5500|enc28|lan87|ksz8|ethernet|_phy\b/.test(v)) return "logic";
  if (/sw_|button|switch_smd|b3u/.test(v)) return "button";
  if (ref.startsWith("J") || /conn_|terminal|screw|receptacle|rj45/.test(v)) return "terminal";
  if (/^[RCLDQY]/.test(ref)) return "passive";
  void fp;
  return "other";
}

// How much room a part needs, as KiCad measures it.
function sizeOf(fp?: Footprint, rotation = 0): { w: number; h: number } {
  if (!fp) return { w: 5, h: 5 };
  // Some footprints draw a courtyard smaller than their own pads - a lug pad
  // on a mounting hole, for one. Take whichever is bigger, or two lugs end up
  // on top of each other.
  const box = fp.courtyard ?? fp.bbox;
  const w = Math.max(1, box.max.x - box.min.x, fp.bbox.max.x - fp.bbox.min.x);
  const h = Math.max(1, box.max.y - box.min.y, fp.bbox.max.y - fp.bbox.min.y);
  const turned = Math.abs((((rotation % 180) + 180) % 180) - 90) < 1;
  return turned ? { w: h, h: w } : { w, h };
}

// A courtyard is not centred on the part origin - a screw terminal's body sits
// to one side - so every placement below positions the courtyard centre and
// this converts back to an origin.
function centreOffset(fp: Footprint | undefined, rotation: number): Point {
  const box = fp?.courtyard ?? fp?.bbox;
  if (!box) return { x: 0, y: 0 };
  const cx = (box.min.x + box.max.x) / 2;
  const cy = (box.min.y + box.max.y) / 2;
  const rad = (-rotation * Math.PI) / 180;
  return { x: cx * Math.cos(rad) - cy * Math.sin(rad), y: cx * Math.sin(rad) + cy * Math.cos(rad) };
}

// Which way a part wants to face. A connector's body sits off to one side of
// its pads - that is the side you plug into - and an RF module's keepout sits
// over its antenna. Both are the direction that has to point off the board.
function outwardOf(fp?: Footprint): Point | undefined {
  if (!fp) return undefined;
  if (fp.keepouts?.length) {
    const pts = fp.keepouts.flat();
    const k = { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
    if (Math.hypot(k.x, k.y) > 0.5) return k;
  }
  if (!fp.pads.length || !fp.courtyard) return undefined;
  const pc = {
    x: fp.pads.reduce((s, p) => s + p.at.x, 0) / fp.pads.length,
    y: fp.pads.reduce((s, p) => s + p.at.y, 0) / fp.pads.length,
  };
  const cc = { x: (fp.courtyard.min.x + fp.courtyard.max.x) / 2, y: (fp.courtyard.min.y + fp.courtyard.max.y) / 2 };
  const v = { x: cc.x - pc.x, y: cc.y - pc.y };
  return Math.hypot(v.x, v.y) > 0.4 ? v : undefined;
}

// The rotation that points a part's outward direction at the given edge.
function faceRotation(fp: Footprint | undefined, normal: Point, fallback = 0): number {
  const v = outwardOf(fp);
  if (!v) return fallback;
  let best = fallback;
  let bestDot = -Infinity;
  for (const rot of [0, 90, 180, 270]) {
    const rad = (-rot * Math.PI) / 180;
    const rx = v.x * Math.cos(rad) - v.y * Math.sin(rad);
    const ry = v.x * Math.sin(rad) + v.y * Math.cos(rad);
    const len = Math.hypot(rx, ry) || 1;
    const dot = (rx * normal.x + ry * normal.y) / len;
    if (dot > bestDot) {
      bestDot = dot;
      best = rot;
    }
  }
  return best;
}

// Parts that share a net, ranked by how much they share. A rail touches
// everything, so it says nothing about who belongs with whom.
function neighbours(ref: string, nl: Netlist): Map<string, number> {
  const out = new Map<string, number>();
  for (const net of nl.nets) {
    if (!net.pins.some((p) => p.ref === ref)) continue;
    if (net.isPower || net.pins.length > 12) continue;
    for (const p of net.pins) {
      if (p.ref === ref) continue;
      out.set(p.ref, (out.get(p.ref) ?? 0) + 1);
    }
  }
  return out;
}

export interface PlacementResult {
  board: Board;
  notes: string[];
}

// #region clusters
interface Cluster {
  id: string;
  head: PlacedFootprint;
  kind: Role;
  // The head may have to be turned - an RF module's antenna has to face off the
  // board - and everything around it is then laid out against the turned size.
  headRot?: number;
  // On a board edge, everything hangs off one side of the head, so the head
  // itself can sit on the edge. An antenna behind a column of capacitors is
  // not on the edge.
  packSide?: "left" | "right";
  parts: PlacedFootprint[];
  // Offsets from the cluster's own centre, filled by layoutCluster.
  layout: Map<string, { dx: number; dy: number; rot: number }>;
  w: number;
  h: number;
}

const HEAD_RANK: Role[] = ["mcu", "converter", "rf", "logic", "switch", "usb", "terminal", "fuse", "button", "other", "passive", "lug"];

export interface PlaceOptions {
  title?: string;
  rev?: string;
  org?: string;
}

export function autoPlace(board: Board, footprints: Record<string, Footprint>, nl: Netlist, opts: PlaceOptions = {}): PlacementResult {
  const notes: string[] = [];
  const byRef = new Map(board.footprints.map((f) => [f.ref, f]));
  const fpOf = (f: PlacedFootprint) => footprints[f.libId];
  const roles = new Map<string, Role>();
  for (const f of board.footprints) roles.set(f.ref, roleOf(f, fpOf(f)));
  const roleOfRef = (ref: string) => roles.get(ref) ?? "other";
  const of = (role: Role) => board.footprints.filter((f) => roleOfRef(f.ref) === role);

  const place = (f: PlacedFootprint, centre: Point, rotation = 0) => {
    const off = centreOffset(fpOf(f), rotation);
    f.rotation = rotation;
    f.at = { x: snap(centre.x - off.x), y: snap(centre.y - off.y) };
  };

  // Group by the module block each part came from. A block is a circuit the
  // designer named, which beats anything inferred from the netlist.
  const clusters: Cluster[] = [];
  const inCluster = new Set<string>();
  const groups = new Map<string, PlacedFootprint[]>();
  for (const f of board.footprints) {
    if (!f.blockId) continue;
    const arr = groups.get(f.blockId) ?? [];
    arr.push(f);
    groups.set(f.blockId, arr);
  }
  const newCluster = (id: string, parts: PlacedFootprint[]): Cluster => {
    const head = [...parts].sort((a, b) => HEAD_RANK.indexOf(roleOfRef(a.ref)) - HEAD_RANK.indexOf(roleOfRef(b.ref)))[0];
    for (const p of parts) inCluster.add(p.ref);
    return { id, head, kind: roleOfRef(head.ref), parts, layout: new Map(), w: 0, h: 0 };
  };
  for (const [id, parts] of groups) clusters.push(newCluster(id, parts));

  // Loose parts: a passive joins the cluster it is most connected to, anything
  // else becomes its own cluster.
  for (const f of board.footprints) {
    if (inCluster.has(f.ref)) continue;
    if (roleOfRef(f.ref) === "passive") {
      const near = [...neighbours(f.ref, nl)].sort((a, b) => b[1] - a[1]);
      const host = near.map(([ref]) => clusters.find((c) => c.parts.some((p) => p.ref === ref))).find(Boolean);
      if (host) {
        host.parts.push(f);
        inCluster.add(f.ref);
        continue;
      }
    }
    clusters.push(newCluster(f.ref, [f]));
  }

  // A connector inside a module is still a connector, and the circuit behind it
  // wants to stay with it: an Ethernet controller 80mm from its jack is four
  // differential pairs crossing a board full of switching converters. So the
  // block is re-headed onto its connector and travels to the edge as one piece,
  // with everything else laid out behind it.
  for (const c of clusters) {
    if (c.kind === "terminal" || c.kind === "usb") continue;
    const conn = c.parts.find((f) => f !== c.head && ["terminal", "usb"].includes(roleOfRef(f.ref)));
    if (!conn) continue;
    c.head = conn;
    c.kind = roleOfRef(conn.ref);
  }

  // #region cluster layout
  // Inside a cluster: the chip in the middle, its parts in columns either side,
  // closest first. Two clusters with the same parts come out identical, which
  // is what makes eight channels look like eight channels.
  const layoutCluster = (c: Cluster) => {
    const headSize = sizeOf(fpOf(c.head), c.headRot ?? 0);
    c.layout.set(c.head.ref, { dx: 0, dy: 0, rot: c.headRot ?? 0 });
    const near = neighbours(c.head.ref, nl);
    const rest = c.parts
      .filter((p) => p.ref !== c.head.ref)
      .sort(
        (a, b) =>
          (near.get(b.ref) ?? 0) - (near.get(a.ref) ?? 0) ||
          a.libId.localeCompare(b.libId) ||
          a.value.localeCompare(b.value) ||
          a.ref.localeCompare(b.ref),
      );
    // Columns stack to roughly the height that keeps the cluster square. Using
    // the head's height alone turns eighteen 0603s into a 48mm line, which is
    // the row problem again, one level down.
    const restArea = rest.reduce((sum, p) => {
      const s = sizeOf(fpOf(p));
      return sum + (s.w + CLUSTER_GAP) * (s.h + CLUSTER_GAP);
    }, 0);
    const target = Math.max(headSize.h, Math.sqrt(restArea) * 1.1, 4);
    const cols: PlacedFootprint[][] = [];
    let col: PlacedFootprint[] = [];
    let colH = 0;
    for (const p of rest) {
      const h = sizeOf(fpOf(p)).h + CLUSTER_GAP;
      if (col.length && colH + h > target) {
        cols.push(col);
        col = [];
        colH = 0;
      }
      col.push(p);
      colH += h;
    }
    if (col.length) cols.push(col);

    // Nearest column to the left, next to the right, then further out. The
    // first column holds the parts with the strongest connection to the chip,
    // which is where the decoupling ends up.
    let leftX = -headSize.w / 2;
    let rightX = headSize.w / 2;
    cols.forEach((column, i) => {
      const colW = Math.max(...column.map((p) => sizeOf(fpOf(p)).w));
      const colHeight = column.reduce((s, p) => s + sizeOf(fpOf(p)).h + CLUSTER_GAP, -CLUSTER_GAP);
      const left = c.packSide ? c.packSide === "left" : i % 2 === 0;
      const cx = left ? leftX - CLUSTER_GAP - colW / 2 : rightX + CLUSTER_GAP + colW / 2;
      if (left) leftX = cx - colW / 2;
      else rightX = cx + colW / 2;
      let y = -colHeight / 2;
      for (const p of column) {
        const s = sizeOf(fpOf(p));
        c.layout.set(p.ref, { dx: snap(cx), dy: snap(y + s.h / 2), rot: 0 });
        y += s.h + CLUSTER_GAP;
      }
    });

    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const p of c.parts) {
      const l = c.layout.get(p.ref)!;
      const s = sizeOf(fpOf(p), l.rot);
      x1 = Math.min(x1, l.dx - s.w / 2);
      x2 = Math.max(x2, l.dx + s.w / 2);
      y1 = Math.min(y1, l.dy - s.h / 2);
      y2 = Math.max(y2, l.dy + s.h / 2);
    }
    // Re-centre so the cluster's own centre is the middle of its bounding box.
    const ox = (x1 + x2) / 2;
    const oy = (y1 + y2) / 2;
    for (const [ref, l] of c.layout) c.layout.set(ref, { ...l, dx: l.dx - ox, dy: l.dy - oy });
    c.w = x2 - x1 + CRT * 2;
    c.h = y2 - y1 + CRT * 2;
  };
  for (const c of clusters) layoutCluster(c);

  const dropCluster = (c: Cluster, centre: Point) => {
    for (const p of c.parts) {
      const l = c.layout.get(p.ref)!;
      place(p, { x: centre.x + l.dx, y: centre.y + l.dy }, l.rot);
    }
  };

  // #region channels
  // A channel is a terminal with the breaker and switch that feed it. Current
  // goes breaker -> switch -> terminal, so finding the breaker from the
  // terminal takes two hops.
  interface Column { terminal: PlacedFootprint; fuse?: PlacedFootprint; sw?: Cluster; w: number; h: number }
  const lugs = of("lug");
  const terminals = of("terminal").filter((t) => !lugs.includes(t) && !/usb/i.test(t.libId));
  const fuses = of("fuse");
  const switchClusters = clusters.filter((c) => c.kind === "switch");
  const usedFuse = new Set<string>();
  const usedSw = new Set<string>();
  const allColumns: Column[] = [];
  for (const t of terminals) {
    const near = neighbours(t.ref, nl);
    const sw = switchClusters
      .filter((c) => !usedSw.has(c.id) && (near.get(c.head.ref) ?? 0) > 0)
      .sort((a, b) => (near.get(b.head.ref) ?? 0) - (near.get(a.head.ref) ?? 0))[0];
    if (sw) usedSw.add(sw.id);
    const swNear = sw ? neighbours(sw.head.ref, nl) : new Map<string, number>();
    const pickFuse = (from: Map<string, number>) =>
      fuses.filter((f) => !usedFuse.has(f.ref) && (from.get(f.ref) ?? 0) > 0).sort((a, b) => (from.get(b.ref) ?? 0) - (from.get(a.ref) ?? 0))[0];
    const fuse = pickFuse(swNear) ?? pickFuse(near);
    if (fuse) usedFuse.add(fuse.ref);
    const tw = sizeOf(fpOf(t)).w;
    const col: Column = {
      terminal: t,
      fuse,
      sw,
      w: Math.max(tw, fuse ? sizeOf(fpOf(fuse), 90).w : 0, sw?.w ?? 0),
      h:
        sizeOf(fpOf(t)).h +
        (fuse ? sizeOf(fpOf(fuse), 90).h + CLUSTER_GAP * 2 : 0) +
        (sw ? sw.h + CLUSTER_GAP * 2 : 0),
    };
    // A switched channel is a column of its own. A plain rail output is just a
    // terminal and its fuse, and those go on the opposite edge together.
    // A terminal with no breaker behind it is a signal connector, not an
    // output, and it does not belong on the output edge.
    if (fuse) allColumns.push(col);
    else continue;
  }

  // Outputs of the same kind belong together: the biggest family of connectors
  // is the channel bank and takes one long edge, the rest take the other. That
  // is what turns "6 on one side, 5 on the other" into two banks that read.
  const byFamily = new Map<string, Column[]>();
  for (const c of allColumns) {
    const arr = byFamily.get(c.terminal.libId) ?? [];
    arr.push(c);
    byFamily.set(c.terminal.libId, arr);
  }
  const families = [...byFamily.values()].sort((a, b) => b.length - a.length);
  const columns = families[0] ?? [];
  const railColumns = families.slice(1).flat();

  const edgeRefs = new Set<string>();
  const railRefs = new Set<string>();
  for (const c of railColumns) {
    railRefs.add(c.terminal.ref);
    if (c.fuse) railRefs.add(c.fuse.ref);
  }
  const columnClusterIds = new Set<string>();
  for (const c of allColumns) {
    edgeRefs.add(c.terminal.ref);
    if (c.fuse) edgeRefs.add(c.fuse.ref);
    if (c.sw) {
      columnClusterIds.add(c.sw.id);
      for (const p of c.sw.parts) edgeRefs.add(p.ref);
    }
  }

  // A terminal or breaker that went to an edge leaves its cluster. Whatever is
  // left of that cluster still has to be placed - dropping it is how parts end
  // up sitting wherever they were first put.
  for (const c of clusters) {
    if (columnClusterIds.has(c.id)) continue;
    const keep = c.parts.filter((p) => !edgeRefs.has(p.ref));
    if (keep.length === c.parts.length) continue;
    c.parts = keep;
    if (!keep.length) continue;
    if (edgeRefs.has(c.head.ref)) {
      c.head = [...keep].sort((a, b) => HEAD_RANK.indexOf(roleOfRef(a.ref)) - HEAD_RANK.indexOf(roleOfRef(b.ref)))[0];
      c.kind = roleOfRef(c.head.ref);
    }
    c.layout.clear();
    layoutCluster(c);
  }

  // #region zones
  // What is left over, split into the two zones that must not mix.
  const middle = clusters.filter((c) => !columnClusterIds.has(c.id) && c.parts.length > 0 && c.kind !== "lug");
  const powerZone = middle.filter((c) => c.kind === "converter");
  // A connector you plug something into belongs on an edge, even when it is a
  // signal connector: an e-stop header in the middle of the board is a header
  // you cannot reach.
  const edgeConnectors = middle.filter((c) => c.kind === "terminal" || c.kind === "usb");
  // A radio module lives on the right-hand edge, not in the middle band. Laying
  // it out twice leaves a hole where it used to be and widens the board.
  const rfClusters = middle.filter((c) => (c.kind === "mcu" || c.kind === "rf") && outwardOf(fpOf(c.head)));
  const digitalZone = middle.filter(
    (c) => !edgeConnectors.includes(c) && !rfClusters.includes(c) && ["mcu", "logic", "button", "rf"].includes(c.kind),
  );
  const otherZone = middle.filter((c) => !powerZone.includes(c) && !digitalZone.includes(c) && !edgeConnectors.includes(c));

  // #region right column
  // The right-hand edge is a column: the radio module at the top with its
  // antenna looking off the board, then the connectors that serve the logic.
  // Deciding this before the middle band is laid out is what keeps the column
  // from widening the board once everything else is already down.
  for (const c of rfClusters) {
    c.headRot = faceRotation(fpOf(c.head), { x: 1, y: 0 });
    c.packSide = "left";
    c.layout.clear();
    layoutCluster(c);
  }

  // A connector goes on the edge nearest the circuit it serves. Ask the whole
  // cluster, not just the connector: a USB port reaches the MCU through its own
  // ESD part, so the connector's own net list says nothing useful.
  const rightConns: Cluster[] = [];
  const leftConns: Cluster[] = [];
  for (const c of edgeConnectors) {
    const near = new Map<string, number>();
    for (const p of c.parts) {
      for (const [ref, n] of neighbours(p.ref, nl)) {
        if (c.parts.some((q) => q.ref === ref)) continue;
        near.set(ref, (near.get(ref) ?? 0) + n);
      }
    }
    const friend =
      [...near]
        .sort((a, b) => b[1] - a[1])
        .map(([ref]) => byRef.get(ref))
        .find((f) => f && !edgeConnectors.some((e) => e.parts.includes(f)));
    // The right-hand edge is where the logic lives, so a connector whose
    // circuit is in there goes with it. Anything else goes left, by the lugs.
    const onRight =
      !!friend && (rfClusters.some((r) => r.parts.includes(friend)) || digitalZone.some((d) => d.parts.includes(friend)));
    (onRight ? rightConns : leftConns).push(c);
  }
  // Turn them to face their edge before measuring: a jack laid out flat and
  // then rotated is a jack whose size the column planned wrong, which is how it
  // ends up 12mm short of the edge it was supposed to sit on.
  for (const c of rightConns) {
    c.headRot = faceRotation(fpOf(c.head), { x: 1, y: 0 });
    c.packSide = "left";
    c.layout.clear();
    layoutCluster(c);
  }
  for (const c of leftConns) {
    c.headRot = faceRotation(fpOf(c.head), { x: -1, y: 0 });
    c.packSide = "right";
    c.layout.clear();
    layoutCluster(c);
  }
  const rightMembers = [...rfClusters, ...rightConns];
  const colW = rightMembers.length ? Math.max(...rightMembers.map((c) => c.w)) : 0;
  const colZoneW = colW ? colW + ZONE_GAP : 0;

  const rowsOf = (list: Cluster[], maxW: number) => {
    const rows: Cluster[][] = [];
    let row: Cluster[] = [];
    let w = 0;
    for (const c of list) {
      if (row.length && w + c.w + ZONE_GAP / 2 > maxW) {
        rows.push(row);
        row = [];
        w = 0;
      }
      row.push(c);
      w += c.w + ZONE_GAP / 2;
    }
    if (row.length) rows.push(row);
    return rows;
  };
  const sizeRows = (rows: Cluster[][]) => ({
    w: Math.max(0, ...rows.map((r) => r.reduce((s, c) => s + c.w + ZONE_GAP / 2, -ZONE_GAP / 2))),
    h: rows.reduce((s, r) => s + Math.max(...r.map((c) => c.h)) + ZONE_GAP / 2, -ZONE_GAP / 2),
  });

  // Width: the channel bank sets it, unless the middle zones need more. The
  // lugs take a column of their own at the input end.
  const lugW = lugs.length ? Math.max(...lugs.map((l) => sizeOf(fpOf(l)).w)) : 0;
  const lugZoneW = lugs.length ? lugW + LUG_INSET + ZONE_GAP : 0;
  const colPitch = columns.length ? Math.max(...columns.map((c) => c.w)) + COL_GAP : 0;
  const railPitch = railColumns.length ? Math.max(...railColumns.map((c) => c.w)) + COL_GAP : 0;
  const bankW = columns.length * colPitch;
  const railBankW = railColumns.length * railPitch;

  // Power and digital sit side by side in the middle band, separated by a
  // gutter. Each gets roughly the width it needs.
  const powerW = powerZone.reduce((s, c) => s + c.w + ZONE_GAP / 2, 0);
  const digitalW = digitalZone.reduce((s, c) => s + c.w + ZONE_GAP / 2, 0);
  const otherW = otherZone.reduce((s, c) => s + c.w + ZONE_GAP / 2, 0);

  // The channel bank sets the width of a board that has one. The middle band
  // then wraps to fit inside it, beside the right-hand column, instead of
  // setting its own width and pushing everything else outward.
  // With no bank, two wide zones sharing a row make a board that is all width
  // and no height, so they stack instead.
  // Power above logic, using the full width, whenever the right-hand edge is
  // already spoken for. Splitting the remaining width between two zones makes
  // both of them wrap, and a board that wraps twice is a tall empty board.
  const stacked = powerW > 0 && digitalW > 0 && (colZoneW > 0 || (!allColumns.length && powerW + digitalW > 80));
  const looseW = (stacked ? Math.max(powerW, digitalW) : powerW + (powerW && digitalW ? ZONE_GAP : 0) + digitalW) + (otherW ? ZONE_GAP + otherW / 2 : 0);
  const midTarget = bankW ? Math.max(bankW - colZoneW, 80) : Math.max(looseW * 0.8, 40);

  const powerRows = rowsOf(powerZone, stacked ? midTarget : Math.max(midTarget * 0.55, 35));
  const digitalRows = rowsOf(digitalZone, stacked ? midTarget : Math.max(midTarget * 0.45, 35));
  const powerSize = sizeRows(powerRows);
  const digitalSize = sizeRows(digitalRows);
  const midUsed = stacked ? Math.max(powerSize.w, digitalSize.w) : powerSize.w + (powerSize.w && digitalSize.w ? ZONE_GAP : 0) + digitalSize.w;
  // The left column - lugs and the connectors that sit beside them - is as much
  // a part of the width as the right one. Leaving it out pushes the middle band
  // into the right column, and the overlap guard then throws parts off the
  // board.
  const connW = leftConns.length ? Math.max(...leftConns.map((c) => c.w)) : 0;
  const leftZoneW = Math.max(lugZoneW, connW ? connW + ZONE_GAP : 0);
  const contentW = Math.max(bankW, railBankW + lugZoneW, leftZoneW + midUsed + colZoneW, leftZoneW + colZoneW + 40, 40);
  const otherRows = rowsOf(otherZone, Math.max(contentW - colZoneW, 40));
  const otherSize = sizeRows(otherRows);

  const topDepth = columns.length ? Math.max(...columns.map((c) => c.h)) : 0;
  const bottomDepth = railColumns.length ? Math.max(...railColumns.map((c) => c.h)) : 0;
  const midDepth = Math.max(powerSize.h, digitalSize.h) + (otherRows.length ? otherSize.h + ZONE_GAP : 0);
  const contentH = topDepth + ZONE_GAP + midDepth + (bottomDepth ? ZONE_GAP + bottomDepth : 0);

  const W = snap(contentW + EDGE * 2);
  const H = snap(contentH + EDGE * 2);

  // #region compose
  // Top edge: the channel bank. Terminal flush to the edge, then its breaker,
  // then its switch, marching inward - the order current travels.
  const bankX = EDGE + (columns.length ? (contentW - bankW) / 2 : 0);
  columns.forEach((c, i) => {
    const x = bankX + i * colPitch + colPitch / 2;
    let y = EDGE;
    const trot = faceRotation(fpOf(c.terminal), { x: 0, y: -1 }, 0);
    const th = sizeOf(fpOf(c.terminal), trot).h;
    place(c.terminal, { x, y: y + th / 2 }, trot);
    y += th + CLUSTER_GAP * 2;
    if (c.fuse) {
      const fh = sizeOf(fpOf(c.fuse), 90).h;
      place(c.fuse, { x, y: y + fh / 2 }, 90);
      y += fh + CLUSTER_GAP * 2;
    }
    if (c.sw) dropCluster(c.sw, { x, y: y + c.sw.h / 2 });
  });

  // Lugs at the input end, stacked on the left edge: heavy cable lands where it
  // enters the board, not somewhere in the middle of it.
  const lugTop = EDGE + topDepth + ZONE_GAP;
  const lugPitch = Math.max(...lugs.map((l) => sizeOf(fpOf(l)).h), 6) + LUG_GAP;
  lugs.forEach((l, i) => {
    place(l, { x: EDGE + LUG_INSET + lugW / 2, y: lugTop + sizeOf(fpOf(l)).h / 2 + i * lugPitch });
  });
  const lugBottom = lugs.length ? lugTop + (lugs.length - 1) * lugPitch + Math.max(...lugs.map((l) => sizeOf(fpOf(l)).h)) : lugTop;

  // The middle band: power on the left, logic on the right, a gutter between
  // them. Switchers and a microcontroller do not share a neighbourhood.
  const midTop = EDGE + topDepth + ZONE_GAP;
  const dropRows = (rows: Cluster[][], left: number, top: number, width: number) => {
    let y = top;
    for (const row of rows) {
      const rowH = Math.max(...row.map((c) => c.h));
      const rowW = row.reduce((s, c) => s + c.w + ZONE_GAP / 2, -ZONE_GAP / 2);
      let x = left + Math.max(0, (width - rowW) / 2);
      for (const c of row) {
        dropCluster(c, { x: x + c.w / 2, y: y + rowH / 2 });
        x += c.w + ZONE_GAP / 2;
      }
      y += rowH + ZONE_GAP / 2;
    }
    return y;
  };
  const powerLeft = EDGE + leftZoneW;
  const powerWidth = powerSize.w;
  const digitalLeft = stacked || !powerWidth ? powerLeft : powerLeft + powerWidth + ZONE_GAP;
  const powerBottom = dropRows(powerRows, powerLeft, midTop, powerWidth);
  const digitalBottom = dropRows(digitalRows, digitalLeft, stacked ? powerBottom + ZONE_GAP : midTop, digitalSize.w);
  dropRows(otherRows, EDGE + leftZoneW, Math.max(powerBottom, digitalBottom) + ZONE_GAP / 2, contentW - leftZoneW);

  // The right column, aligned on one edge so the antenna is on the board edge
  // itself rather than behind a row of capacitors.
  const colRight = EDGE + contentW;
  let rightY = EDGE + topDepth + ZONE_GAP;
  for (const c of rightMembers) {
    dropCluster(c, { x: colRight - c.w / 2, y: rightY + c.h / 2 });
    rightY += c.h + ZONE_GAP / 2;
  }

  let leftY = lugBottom + ZONE_GAP;
  const leftW = leftConns.length ? Math.max(...leftConns.map((c) => c.w)) : 0;
  for (const c of leftConns) {
    dropCluster(c, { x: EDGE + leftW / 2, y: leftY + c.h / 2 });
    leftY += c.h + ZONE_GAP / 2;
  }

  // The board is as wide as what is on it, not as wide as the first guess. A
  // connector on the right-hand edge gets the edge itself: the face you plug
  // into belongs at the board outline, not 15mm inside it. Mounting holes sit
  // relative to the outline, so they do not get a vote on where it is.
  const edgeFace = new Set<string>();
  // Connectors and the radio module both want the outline itself: one is a face
  // you plug into, the other is an antenna that has to look off the board.
  for (const c of rightMembers) {
    if (c.kind !== "terminal" && c.kind !== "usb" && !rfClusters.includes(c)) continue;
    for (const p2 of c.parts) edgeFace.add(p2.ref);
  }
  let normalRight = EDGE;
  let faceRight = 0;
  for (const f of board.footprints) {
    if (/^H\d+$/.test(f.ref)) continue;
    const right = f.at.x + sizeOf(fpOf(f), f.rotation).w / 2;
    if (edgeFace.has(f.ref)) faceRight = Math.max(faceRight, right);
    else normalRight = Math.max(normalRight, right);
  }
  const boardW = snap(Math.max(normalRight + EDGE, faceRight + 1, EDGE * 2 + 40));

  // Bottom edge: the regulated outputs, seated against the real edge rather
  // than a guess made before the middle was laid out. Guessing leaves a 40mm
  // band of nothing between the logic and the connectors.
  const usedBottom = board.footprints.reduce((m, f) => {
    if (railRefs.has(f.ref)) return m;
    const s2 = sizeOf(fpOf(f), f.rotation);
    return Math.max(m, f.at.y + s2.h / 2);
  }, EDGE);
  const realH = snap(Math.max(H, usedBottom + (bottomDepth ? ZONE_GAP + bottomDepth : 0) + EDGE));
  const railX = EDGE + lugZoneW;
  railColumns.forEach((c, i) => {
    const x = railX + i * railPitch + railPitch / 2;
    let y = realH - EDGE;
    const trot = faceRotation(fpOf(c.terminal), { x: 0, y: 1 }, 180);
    const th = sizeOf(fpOf(c.terminal), trot).h;
    place(c.terminal, { x, y: y - th / 2 }, trot);
    y -= th + CLUSTER_GAP * 2;
    if (c.fuse) {
      const fh = sizeOf(fpOf(c.fuse), 90).h;
      place(c.fuse, { x, y: y - fh / 2 }, 90);
    }
  });

  // #region mounting holes
  // A board with 12AWG pulling on its terminals needs to be bolted down.
  const holeFp = Object.keys(footprints).find((k) => /MountingHole_3\.2mm/.test(k));
  if (holeFp) {
    const spots: Point[] = [
      { x: HOLE_INSET, y: HOLE_INSET },
      { x: boardW - HOLE_INSET, y: HOLE_INSET },
      { x: HOLE_INSET, y: realH - HOLE_INSET },
      { x: boardW - HOLE_INSET, y: realH - HOLE_INSET },
    ];
    board.footprints = board.footprints.filter((f) => !/^H\d+$/.test(f.ref));
    spots.forEach((p, i) => {
      board.footprints.push({
        uuid: crypto.randomUUID(),
        ref: `H${i + 1}`,
        value: "M3 mount",
        libId: holeFp,
        at: { x: snap(p.x), y: snap(p.y) },
        rotation: 0,
        side: "F",
        padNets: {},
      });
    });
    notes.push("4 M3 mounting holes at the corners");
  }

  // #region guard
  // Nothing should overlap by now. If something does it is a bug, and a part
  // parked below the board is easier to find than two parts on top of each
  // other - but say so, loudly, in the notes.
  const rectOf = (f: PlacedFootprint) => {
    const fp = fpOf(f);
    const box = fp?.courtyard ?? fp?.bbox;
    if (!box) {
      const s = sizeOf(fp, f.rotation);
      return { x1: f.at.x - s.w / 2, y1: f.at.y - s.h / 2, x2: f.at.x + s.w / 2, y2: f.at.y + s.h / 2 };
    }
    const rad = (-f.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const xs: number[] = [];
    const ys: number[] = [];
    for (const c of [
      { x: box.min.x, y: box.min.y },
      { x: box.max.x, y: box.min.y },
      { x: box.max.x, y: box.max.y },
      { x: box.min.x, y: box.max.y },
    ]) {
      xs.push(f.at.x + c.x * cos - c.y * sin);
      ys.push(f.at.y + c.x * sin + c.y * cos);
    }
    const pad = 0.1;
    return { x1: Math.min(...xs) - pad, y1: Math.min(...ys) - pad, x2: Math.max(...xs) + pad, y2: Math.max(...ys) + pad };
  };
  const hits = (a: ReturnType<typeof rectOf>, b: ReturnType<typeof rectOf>) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
  const accepted: ReturnType<typeof rectOf>[] = [];
  const displaced: string[] = [];
  let spareX = EDGE;
  let spareY = realH + ZONE_GAP;
  let spareRow = 0;
  const order = [...board.footprints].sort((a, b) => Number(edgeRefs.has(b.ref)) - Number(edgeRefs.has(a.ref)));
  for (const f of order) {
    let r = rectOf(f);
    if (accepted.some((a) => hits(a, r))) {
      const s = sizeOf(fpOf(f), f.rotation);
      if (spareX + s.w > boardW - EDGE) {
        spareX = EDGE;
        spareY += spareRow + CLUSTER_GAP * 2;
        spareRow = 0;
      }
      place(f, { x: spareX + s.w / 2, y: spareY + s.h / 2 }, f.rotation);
      spareX += s.w + CLUSTER_GAP * 2;
      spareRow = Math.max(spareRow, s.h);
      r = rectOf(f);
      displaced.push(f.ref);
    }
    accepted.push(r);
  }

  // #region silkscreen
  // What the board says about itself. A terminal you have to trace back to the
  // schematic to identify is a terminal someone wires backwards at 2am.
  board.texts = (board.texts ?? []).filter((t) => !t.text.startsWith("\u0000"));
  board.texts = [];
  const shortLabel = (v: string) => v.replace(/\s*(OUT|12AWG|6AWG|x4|self-resetting)\s*/gi, " ").replace(/\s+/g, " ").trim().slice(0, 18);
  for (const c of allColumns) {
    const t = c.terminal;
    const s2 = sizeOf(fpOf(t), t.rotation);
    const top = t.at.y < (board.outline[2]?.y ?? realH) / 2;
    const label = shortLabel(t.value) || t.ref;
    board.texts.push({
      at: { x: t.at.x - label.length * 0.42, y: top ? t.at.y + s2.h / 2 + 1.6 : t.at.y - s2.h / 2 - 1.6 },
      text: label.toUpperCase(),
      layer: "F.SilkS",
      size: 1.2,
    });
  }
  for (const l of lugs) {
    const net = Object.values(l.padNets)[0] ?? "";
    if (!net) continue;
    const s2 = sizeOf(fpOf(l), l.rotation);
    board.texts.push({
      at: { x: l.at.x - s2.w / 2, y: l.at.y - s2.h / 2 - 1.8 },
      text: net.toUpperCase(),
      layer: "F.SilkS",
      size: 2,
      bold: true,
    });
  }

  // #region outline
  let maxX = 0;
  let maxY = 0;
  for (const f of board.footprints) {
    if (/^H\d+$/.test(f.ref)) continue; // holes follow the outline, not the other way round
    const r = rectOf(f);
    maxX = Math.max(maxX, edgeFace.has(f.ref) ? r.x2 - EDGE + 1 : r.x2);
    maxY = Math.max(maxY, r.y2);
  }
  const outW = Math.max(boardW, snap(maxX + EDGE));
  const outH = Math.max(realH, snap(maxY + EDGE));
  board.outline = [
    { x: 0, y: 0 },
    { x: outW, y: 0 },
    { x: outW, y: outH },
    { x: 0, y: outH },
  ];

  // A title block, dropped into the biggest piece of empty board there is.
  const lines = [opts.org, opts.title, [opts.rev ? `REV ${opts.rev}` : "", new Date().toISOString().slice(0, 7)].filter(Boolean).join("   ")]
    .filter((l): l is string => !!l && l.trim().length > 0)
    .map((l) => l.toUpperCase());
  if (lines.length) {
    const blockW = Math.max(...lines.map((l) => l.length)) * 1.1;
    const blockH = lines.length * 3;
    let spot: Point | undefined;
    for (let y = outH - EDGE - blockH; y > EDGE && !spot; y -= 2) {
      for (let x = EDGE; x + blockW < outW - EDGE; x += 2) {
        const box = { x1: x - 1, y1: y - 1, x2: x + blockW + 1, y2: y + blockH + 1 };
        if (accepted.some((a) => hits(a, box))) continue;
        spot = { x, y };
        break;
      }
    }
    if (spot) {
      lines.forEach((l, i) => {
        board.texts.push({
          at: { x: spot!.x, y: spot!.y + i * 3 },
          text: l,
          layer: "F.SilkS",
          size: i === 0 ? 2.2 : 1.6,
          bold: i === 0,
        });
      });
    } else {
      notes.push("no clear space for a title block on the silkscreen");
    }
  }

  if (displaced.length) notes.push(`overlap guard moved ${displaced.length} parts below the board: ${displaced.slice(0, 8).join(", ")}`);
  notes.push(
    `${columns.length} channel columns on the top edge, ${railColumns.length} rail outputs on the bottom, ` +
      `${lugs.length} lug(s) at the input end, ${powerZone.length} converter clusters and ${digitalZone.length} logic clusters in separate zones`,
  );
  notes.push(`board ${outW.toFixed(0)} x ${outH.toFixed(0)} mm (${((outW * outH) / 645.16).toFixed(1)} sq in)`);
  return { board, notes };
}
