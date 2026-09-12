// #region Placement
// A grid of footprints is not a layout. A power distribution board has a shape
// dictated by how it is wired into a robot: lugs at one end, screw terminals
// along the outside edges where wire can reach them, each channel's breaker and
// switch inline behind its own terminal, converters in the middle, and the
// logic kept away from the switching nodes.
//
// Placement is derived from each part's role and from the netlist, so a channel
// stays together because it is actually connected, not because of its name.

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
  | "passive"
  | "other";

const EDGE = 6; // mm from the board edge to a part's centre line
const GAP = 3; // mm between neighbours

export function roleOf(f: PlacedFootprint, fp?: Footprint): Role {
  const v = `${f.value} ${f.libId}`.toLowerCase();
  const ref = f.ref.toUpperCase();
  if (/lug|awg|stud|busbar/.test(v) && /6awg|4awg|lug/.test(v)) return "lug";
  if (ref.startsWith("F") || /fuse|ato|breaker/.test(v)) return "fuse";
  if (/tps27s|high.?side|power_switch/.test(v)) return "switch";
  if (/usb/.test(v)) return "usb";
  if (/esp32|rp2040|stm32|atmega/.test(v)) return "mcu";
  if (/nrf24|rfm|lora|radio|antenna/.test(v)) return "rf";
  if (/regulator|tps54|lm5175|ap2112|ldo|buck/.test(v)) return "converter";
  if (/logic_|74lvc|flipflop|latch/.test(v)) return "logic";
  if (ref.startsWith("J") || /conn_|terminal|screw|receptacle|rj45/.test(v)) return "terminal";
  if (/^[RCLDQY]/.test(ref)) return "passive";
  void fp;
  return "other";
}

function sizeOf(fp?: Footprint): { w: number; h: number } {
  if (!fp) return { w: 5, h: 5 };
  return {
    w: Math.max(2, fp.bbox.max.x - fp.bbox.min.x),
    h: Math.max(2, fp.bbox.max.y - fp.bbox.min.y),
  };
}

// Parts that share a net, ranked by how much they share. Used to keep a
// channel's breaker with its terminal and a decoupling cap with its chip.
function neighbours(ref: string, nl: Netlist): Map<string, number> {
  const out = new Map<string, number>();
  for (const net of nl.nets) {
    if (!net.pins.some((p) => p.ref === ref)) continue;
    // A rail touches everything, so it says nothing about who belongs together.
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

export function autoPlace(board: Board, footprints: Record<string, Footprint>, nl: Netlist): PlacementResult {
  const notes: string[] = [];
  const byRef = new Map(board.footprints.map((f) => [f.ref, f]));
  const fpOf = (f: PlacedFootprint) => footprints[f.libId];
  const roles = new Map<string, Role>();
  for (const f of board.footprints) roles.set(f.ref, roleOf(f, fpOf(f)));

  const of = (role: Role) => board.footprints.filter((f) => roles.get(f.ref) === role);
  const lugs = of("lug");
  const fuses = of("fuse");
  const switches = of("switch");
  const converters = of("converter");
  const terminals = of("terminal").filter((t) => !lugs.includes(t));

  // A channel is a terminal with the breaker and switch that feed it. Grouping
  // by connectivity rather than by reference number keeps a renamed channel
  // together.
  interface Channel { terminal: PlacedFootprint; fuse?: PlacedFootprint; sw?: PlacedFootprint }
  const channels: Channel[] = [];
  const usedFuse = new Set<string>();
  const usedSw = new Set<string>();
  for (const t of terminals) {
    const near = neighbours(t.ref, nl);
    const fuse = fuses
      .filter((f) => !usedFuse.has(f.ref))
      .sort((a, b) => (near.get(b.ref) ?? 0) - (near.get(a.ref) ?? 0))[0];
    if (fuse && (near.get(fuse.ref) ?? 0) > 0) usedFuse.add(fuse.ref);
    const fuseNear = fuse ? neighbours(fuse.ref, nl) : new Map<string, number>();
    const sw = switches
      .filter((s) => !usedSw.has(s.ref))
      .sort((a, b) => ((fuseNear.get(b.ref) ?? 0) + (near.get(b.ref) ?? 0)) - ((fuseNear.get(a.ref) ?? 0) + (near.get(a.ref) ?? 0)))[0];
    if (sw && ((fuseNear.get(sw.ref) ?? 0) + (near.get(sw.ref) ?? 0)) > 0) usedSw.add(sw.ref);
    channels.push({
      terminal: t,
      fuse: fuse && usedFuse.has(fuse.ref) ? fuse : undefined,
      sw: sw && usedSw.has(sw.ref) ? sw : undefined,
    });
  }

  // Board size follows from how many channels have to line an edge.
  const perEdge = Math.max(1, Math.ceil(channels.length / 2));
  const termPitch = Math.max(
    12,
    ...channels.map((c) => sizeOf(fpOf(c.terminal)).w + GAP * 2),
  );
  const lugWidth = lugs.length ? Math.max(...lugs.map((l) => sizeOf(fpOf(l)).w)) + EDGE * 2 : 0;
  const width = Math.max(90, lugWidth + perEdge * termPitch + EDGE * 2);
  const height = Math.max(70, 60 + converters.length * 6);

  const placed = new Set<string>();
  // Parts whose position is the point of the layout: a terminal belongs on the
  // edge, so the overlap pass moves everything else around it instead.
  const pinned = new Set<string>();
  const place = (f: PlacedFootprint | undefined, at: Point, rotation = 0, fix = false) => {
    if (!f) return;
    f.at = { x: +at.x.toFixed(2), y: +at.y.toFixed(2) };
    f.rotation = rotation;
    placed.add(f.ref);
    if (fix) pinned.add(f.ref);
  };

  // Lugs at one end, on the centre line, where heavy cable comes in.
  lugs.forEach((l, i) => {
    const h = sizeOf(fpOf(l)).h;
    place(l, { x: EDGE + sizeOf(fpOf(l)).w / 2, y: height / 2 + (i - (lugs.length - 1) / 2) * (h + GAP) }, 0, true);
  });

  // Parts placed against the bottom edge keep their distance from it, because
  // the board grows taller once everything else lands.
  const fromBottom = new Map<string, number>();

  // Channels line the top and bottom edges: terminal outermost so wire lands on
  // the outside, then its breaker, then its switch, marching inward.
  const startX = EDGE + lugWidth + termPitch / 2;
  channels.forEach((c, i) => {
    const top = i < perEdge;
    const idx = top ? i : i - perEdge;
    const x = startX + idx * termPitch;
    const termH = sizeOf(fpOf(c.terminal)).h;
    const fuseH = c.fuse ? sizeOf(fpOf(c.fuse)).h : 0;
    const swH = c.sw ? sizeOf(fpOf(c.sw)).h : 0;
    if (top) {
      let y = EDGE + termH / 2;
      place(c.terminal, { x, y }, 0, true);
      y += termH / 2 + GAP + fuseH / 2;
      place(c.fuse, { x, y }, 90, true);
      y += fuseH / 2 + GAP + swH / 2;
      place(c.sw, { x, y }, 0, true);
    } else {
      let d = EDGE + termH / 2;
      place(c.terminal, { x, y: height - d }, 180, true);
      fromBottom.set(c.terminal.ref, d);
      d += termH / 2 + GAP + fuseH / 2;
      if (c.fuse) { place(c.fuse, { x, y: height - d }, 90, true); fromBottom.set(c.fuse.ref, d); }
      d += fuseH / 2 + GAP + swH / 2;
      if (c.sw) { place(c.sw, { x, y: height - d }, 180, true); fromBottom.set(c.sw.ref, d); }
    }
  });

  // Converters run down the middle band, each with its own passives around it:
  // a switching loop wants its parts close, not spread across the board.
  let cx = EDGE + lugWidth + 8;
  const midY = height / 2;
  for (const conv of converters) {
    const s = sizeOf(fpOf(conv));
    place(conv, { x: cx + s.w / 2, y: midY });
    const near = [...neighbours(conv.ref, nl)].sort((a, b) => b[1] - a[1]);
    let ring = 0;
    for (const [ref] of near) {
      const part = byRef.get(ref);
      if (!part || placed.has(ref) || roles.get(ref) !== "passive") continue;
      const ps = sizeOf(fpOf(part));
      const angle = (ring / 8) * Math.PI * 2;
      const radius = s.w / 2 + ps.w / 2 + GAP + Math.floor(ring / 8) * (ps.h + GAP);
      place(part, { x: cx + s.w / 2 + Math.cos(angle) * radius, y: midY + Math.sin(angle) * radius });
      ring++;
      if (ring > 15) break;
    }
    cx += s.w + 26;
  }

  // Logic, MCU and radio go together at the far end, away from the switch nodes.
  const logicX = Math.max(cx + 10, width - 46);
  let ly = EDGE + 20;
  for (const role of ["mcu", "rf", "logic", "usb"] as Role[]) {
    for (const f of of(role)) {
      if (placed.has(f.ref)) continue;
      const s = sizeOf(fpOf(f));
      place(f, { x: logicX + s.w / 2, y: ly + s.h / 2 });
      ly += s.h + GAP * 2;
      const near = [...neighbours(f.ref, nl)].sort((a, b) => b[1] - a[1]);
      let k = 0;
      for (const [ref] of near) {
        const part = byRef.get(ref);
        if (!part || placed.has(ref) || roles.get(ref) !== "passive") continue;
        const ps = sizeOf(fpOf(part));
        place(part, { x: logicX + s.w + GAP + ps.w / 2 + (k % 3) * (ps.w + GAP), y: ly - s.h / 2 + Math.floor(k / 3) * (ps.h + GAP) });
        k++;
        if (k > 8) break;
      }
    }
  }

  // Anything left goes near whatever it is most connected to, or into a spare
  // row rather than on top of something else.
  let sx = EDGE;
  let sy = midY + 22;
  const laneTop = EDGE + 26;
  const laneBottom = height - EDGE - 26;
  for (const f of board.footprints) {
    if (placed.has(f.ref)) continue;
    const near = [...neighbours(f.ref, nl)].sort((a, b) => b[1] - a[1]);
    const anchor = near.map(([r]) => byRef.get(r)).find((p) => p && placed.has(p.ref));
    const s = sizeOf(fpOf(f));
    if (anchor) {
      const as = sizeOf(fpOf(anchor));
      place(f, { x: anchor.at.x + as.w / 2 + GAP + s.w / 2, y: anchor.at.y });
    } else {
      if (sx + s.w > width - EDGE) {
        sx = EDGE;
        sy += 8;
      }
      place(f, { x: sx + s.w / 2, y: Math.min(Math.max(sy, laneTop), laneBottom) });
      sx += s.w + GAP;
    }
  }

  // Nudge overlaps apart. Cheap, and better than parts sitting on each other.
  for (let pass = 0; pass < 4; pass++) {
    let moved = 0;
    for (let i = 0; i < board.footprints.length; i++) {
      for (let j = i + 1; j < board.footprints.length; j++) {
        const a = board.footprints[i];
        const b = board.footprints[j];
        const sa = sizeOf(fpOf(a));
        const sb = sizeOf(fpOf(b));
        const dx = Math.abs(a.at.x - b.at.x);
        const dy = Math.abs(a.at.y - b.at.y);
        const needX = (sa.w + sb.w) / 2 + 0.6;
        const needY = (sa.h + sb.h) / 2 + 0.6;
        if (dx < needX && dy < needY) {
          const aFixed = pinned.has(a.ref);
          const bFixed = pinned.has(b.ref);
          if (aFixed && bFixed) continue; // two edge parts: leave the layout alone
          const push = needY - dy + 0.4;
          const dir = a.at.y <= b.at.y ? -1 : 1;
          if (aFixed) b.at = { x: b.at.x, y: +(b.at.y - dir * push).toFixed(2) };
          else if (bFixed) a.at = { x: a.at.x, y: +(a.at.y + dir * push).toFixed(2) };
          else {
            a.at = { x: a.at.x, y: +(a.at.y + (dir * push) / 2).toFixed(2) };
            b.at = { x: b.at.x, y: +(b.at.y - (dir * push) / 2).toFixed(2) };
          }
          moved++;
        }
      }
    }
    if (moved === 0) break;
  }

  let maxX = 0;
  let maxY = 0;
  for (const f of board.footprints) {
    if (fromBottom.has(f.ref)) continue; // these follow the edge, not the other way round
    const s = sizeOf(fpOf(f));
    maxX = Math.max(maxX, f.at.x + s.w / 2);
    maxY = Math.max(maxY, f.at.y + s.h / 2);
  }
  const finalH = Math.ceil(Math.max(height, maxY + EDGE));
  // Now the board's real height is known, put the bottom row back on the edge.
  for (const [ref, d] of fromBottom) {
    const f = byRef.get(ref);
    if (f) f.at = { x: f.at.x, y: +(finalH - d).toFixed(2) };
  }
  for (const f of board.footprints) {
    const s = sizeOf(fpOf(f));
    maxX = Math.max(maxX, f.at.x + s.w / 2);
  }
  board.outline = [
    { x: 0, y: 0 },
    { x: Math.ceil(Math.max(width, maxX + EDGE)), y: 0 },
    { x: Math.ceil(Math.max(width, maxX + EDGE)), y: finalH },
    { x: 0, y: finalH },
  ];

  notes.push(`${channels.length} channels along the edges, ${lugs.length} lug(s) at the input end, ${converters.length} converter(s) in the middle`);
  return { board, notes };
}
