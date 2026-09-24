// #region Autorouter
// A grid maze router over two layers. It routes signals, not power: a 30A
// channel is not a trace, it is a pour or a bus bar, and pretending otherwise
// produces a board that melts. High-current nets are left for copper and for
// the user's judgement, and the router says which ones it skipped.
//
// The grid is one cell per track pitch. A cell is free, owned by a net, or hard
// blocked; a path may cross a cell owned by its own net, which is what lets a
// later branch of the same net join an earlier one.

import type { Point } from "./schematic";
import type { Footprint } from "./footprint";
import type { Board, Track, Via } from "./board";
import type { Netlist } from "./netlist";
import { padWorld } from "./pcbgen";

export interface RouteOptions {
  pitch?: number; // grid, mm
  trackWidth?: number;
  clearance?: number;
  viaDrill?: number;
  viaSize?: number;
  // Nets the router must not touch: heavy current belongs in copper, not a trace.
  powerNet?: (name: string) => boolean;
  maxSeconds?: number;
}

export interface RouteResult {
  routed: number;
  failed: number;
  skipped: string[];
  tracks: Track[];
  vias: Via[];
  seconds: number;
}

const FREE = 0;
const BLOCKED = -1;

export function autoroute(
  board: Board,
  footprints: Record<string, Footprint>,
  nl: Netlist,
  opts: RouteOptions = {},
): RouteResult {
  const started = Date.now();
  // The grid pitch has to hold a track plus the clearance on both sides, or two
  // nets in neighbouring cells are already too close to each other.
  const pitchFloor = (opts.trackWidth ?? Math.max(board.rules.minTrackWidth, 0.25)) + (opts.clearance ?? board.rules.minClearance) * 2;
  const pitch = Math.max(opts.pitch ?? 0.5, pitchFloor);
  const trackWidth = opts.trackWidth ?? Math.max(board.rules.minTrackWidth, 0.25);
  const clearance = opts.clearance ?? board.rules.minClearance;
  const viaDrill = opts.viaDrill ?? Math.max(board.rules.minDrill, 0.3);
  const viaSize = opts.viaSize ?? viaDrill + board.rules.minAnnularRing * 2;
  const maxMs = (opts.maxSeconds ?? 90) * 1000;
  const isPower =
    opts.powerNet ?? ((name: string) => /^(\+|GND|VBAT|VBUS)/i.test(name) || /_OUT$|_FUSED$/.test(name));

  const xs = board.outline.map((p) => p.x);
  const ys = board.outline.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const W = Math.max(1, Math.ceil((Math.max(...xs) - minX) / pitch));
  const H = Math.max(1, Math.ceil((Math.max(...ys) - minY) / pitch));
  const LAYER = W * H;
  const owner = new Int32Array(LAYER * 2); // 0 free, >0 net id, -1 blocked

  const cellX = (mm: number) => Math.round((mm - minX) / pitch);
  const cellY = (mm: number) => Math.round((mm - minY) / pitch);
  const mmX = (cx: number) => minX + cx * pitch;
  const mmY = (cy: number) => minY + cy * pitch;
  const idx = (cx: number, cy: number, layer: number) => layer * LAYER + cy * W + cx;

  // Net ids start at 1 so 0 can mean "free".
  const netId = new Map<string, number>();
  nl.nets.forEach((n, i) => netId.set(n.name, i + 1));

  // Copper must stay inside the board. The outline is a rectangle here, so an
  // inset border of blocked cells is enough and cheap.
  const edgeKeepout = Math.ceil((clearance + trackWidth / 2 + 0.3) / pitch);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      if (x >= edgeKeepout && y >= edgeKeepout && x < W - edgeKeepout && y < H - edgeKeepout) continue;
      owner[idx(x, y, 0)] = BLOCKED;
      owner[idx(x, y, 1)] = BLOCKED;
    }
  }

  // Copper already on the board - a previous pass, or a trace someone drew by
  // hand - is an obstacle like any other. Without this a second routing pass
  // lays its tracks straight across the first one's.
  const markExisting = () => {
    const layerOf = (name: string) => (name === "B.Cu" ? 1 : 0);
    for (const t of board.tracks) {
      const id = netId.get(t.net) ?? BLOCKED;
      const layer = layerOf(t.layer);
      const steps = Math.max(1, Math.ceil(Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y) / pitch));
      const r = Math.ceil((t.width / 2 + clearance) / pitch);
      for (let k = 0; k <= steps; k++) {
        const x = cellX(t.start.x + ((t.end.x - t.start.x) * k) / steps);
        const y = cellY(t.start.y + ((t.end.y - t.start.y) * k) / steps);
        for (let dx = -r; dx <= r; dx++) {
          for (let dy = -r; dy <= r; dy++) {
            const cx2 = x + dx;
            const cy2 = y + dy;
            if (cx2 < 0 || cy2 < 0 || cx2 >= W || cy2 >= H) continue;
            const cell = idx(cx2, cy2, layer);
            if (owner[cell] === FREE || owner[cell] === id) owner[cell] = id;
            else if (owner[cell] !== id) owner[cell] = BLOCKED;
          }
        }
      }
    }
    for (const v of board.vias) {
      const id = netId.get(v.net) ?? BLOCKED;
      const r = Math.ceil((v.size / 2 + clearance) / pitch);
      const x = cellX(v.at.x);
      const y = cellY(v.at.y);
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          const cx2 = x + dx;
          const cy2 = y + dy;
          if (cx2 < 0 || cy2 < 0 || cx2 >= W || cy2 >= H) continue;
          for (const l of [0, 1]) {
            const cell = idx(cx2, cy2, l);
            if (owner[cell] === FREE || owner[cell] === id) owner[cell] = id;
            else if (owner[cell] !== id) owner[cell] = BLOCKED;
          }
        }
      }
    }
  };

  // #region obstacles
  const padCells = new Map<string, { cx: number; cy: number; layer: number }[]>();
  // Where each pad entry cell has to reach to actually touch copper. A grid
  // cell centre is not the pad centre, and a track that stops one cell short of
  // the pad is not a connection - KiCad counts it as one more loose end.
  const padAnchor = new Map<number, { x: number; y: number }>();
  for (const f of board.footprints) {
    const fp = footprints[f.libId];
    if (!fp) continue;

    // Keepout zones are the part's own rules - an RF module's antenna clearance
    // is the reason this board has a radio that works.
    for (const ring of fp.keepouts ?? []) {
      const world = ring.map((pt) => ({
        ...localWorld(f, pt),
      }));
      const kx1 = Math.max(0, cellX(Math.min(...world.map((p) => p.x))) - 1);
      const kx2 = Math.min(W - 1, cellX(Math.max(...world.map((p) => p.x))) + 1);
      const ky1 = Math.max(0, cellY(Math.min(...world.map((p) => p.y))) - 1);
      const ky2 = Math.min(H - 1, cellY(Math.max(...world.map((p) => p.y))) + 1);
      for (let x = kx1; x <= kx2; x++) {
        for (let y = ky1; y <= ky2; y++) {
          owner[idx(x, y, 0)] = BLOCKED;
          owner[idx(x, y, 1)] = BLOCKED;
        }
      }
    }
    for (const pad of fp.pads) {
      const at = padWorld(f, pad.at);
      const net = f.padNets[pad.number];
      const id = net ? netId.get(net) ?? BLOCKED : BLOCKED;
      const thru = pad.type !== "smd";
      const layers = thru ? [0, 1] : f.side === "B" ? [1] : [0];
      // A rotated pad is measured by its larger dimension: cheap, and erring
      // toward keeping copper away from a pad is the safe direction.
      const half = Math.max(pad.size.w, pad.size.h) / 2 + clearance + trackWidth / 2;
      const r = Math.ceil(half / pitch);
      const cx = cellX(at.x);
      const cy = cellY(at.y);
      // Mark the copper the pad actually occupies, using its rotated extent.
      // Where two pads of different nets land on the same cell, nobody gets it:
      // the loser of a first-come claim would otherwise let one net lay copper
      // straight across its neighbour's pad.
      const own: { cx: number; cy: number; layer: number }[] = padCells.get(net ?? "") ?? [];
      const ang = ((f.rotation + pad.rotation) * Math.PI) / 180;
      const ca = Math.abs(Math.cos(ang));
      const sa = Math.abs(Math.sin(ang));
      // A hole needs more room than the copper around it, and a hole with no
      // copper at all - the keying hole in a fuse holder - still needs it.
      const holeR = pad.drill ? pad.drill / 2 + 0.25 + trackWidth / 2 : 0;
      const hw = Math.max(0.15, (pad.size.w / 2) * ca + (pad.size.h / 2) * sa, holeR);
      const hh = Math.max(0.15, (pad.size.w / 2) * sa + (pad.size.h / 2) * ca, holeR);
      const rx = Math.max(0, Math.round(hw / pitch));
      const ry = Math.max(0, Math.round(hh / pitch));
      for (let dx = -rx; dx <= rx; dx++) {
        for (let dy = -ry; dy <= ry; dy++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          for (const layer of layers) {
            const at2 = idx(x, y, layer);
            const mine = id > 0 ? id : BLOCKED;
            if (owner[at2] === FREE) owner[at2] = mine;
            else if (owner[at2] !== mine) owner[at2] = BLOCKED;
          }
        }
      }
      // Entry points: every cell of this pad the net still owns after the
      // conflict pass. A pad that lost all of them stays in the ratsnest.
      // Entry cells have to sit on the pad's own copper. The stub drawn from the
      // entry cell back to the pad centre is not clearance checked - it cannot
      // be, it has to touch the pad - so it must never leave the pad, or it
      // shaves the pad next door. On a 1.27mm pitch connector that is the
      // difference between a clean board and a short.
      if (net) {
        const entries: { cx: number; cy: number; layer: number }[] = [];
        for (let dx = -rx; dx <= rx; dx++) {
          for (let dy = -ry; dy <= ry; dy++) {
            const x = cx + dx;
            const y = cy + dy;
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            if (Math.abs(mmX(x) - at.x) > hw || Math.abs(mmY(y) - at.y) > hh) continue;
            for (const layer of layers) {
              const cell = idx(x, y, layer);
              if (owner[cell] !== id) continue;
              entries.push({ cx: x, cy: y, layer });
              padAnchor.set(cell, { x: at.x, y: at.y });
            }
          }
        }
        // A pad whose own copper is all spoken for can still be entered from a
        // cell outside it, as long as the stub back to the pad centre does not
        // pass anything that belongs to someone else.
        if (true) {
          for (let dx = -rx; dx <= rx; dx++) {
            for (let dy = -ry; dy <= ry; dy++) {
              const x = cx + dx;
              const y = cy + dy;
              if (x < 0 || y < 0 || x >= W || y >= H) continue;
              for (const layer of layers) {
                const cell = idx(x, y, layer);
                if (owner[cell] !== id) continue;
                const steps = Math.max(Math.abs(dx), Math.abs(dy));
                let clear = true;
                for (let k = 1; k <= steps && clear; k++) {
                  const sx = cx + Math.round((dx * k) / steps);
                  const sy = cy + Math.round((dy * k) / steps);
                  // The cell itself and the four it touches: enough to catch a
                  // stub shaving the pad next door, without rejecting every
                  // escape route inside a dense footprint.
                  for (const [ox, oy] of [
                    [0, 0],
                    [1, 0],
                    [-1, 0],
                    [0, 1],
                    [0, -1],
                  ]) {
                    const nx = sx + ox;
                    const ny = sy + oy;
                    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
                    const o = owner[idx(nx, ny, layer)];
                    if (o !== FREE && o !== id) {
                      clear = false;
                      break;
                    }
                  }
                }
                if (!clear) continue;
                if (entries.some((e) => e.cx === x && e.cy === y && e.layer === layer)) continue;
                entries.push({ cx: x, cy: y, layer });
                padAnchor.set(cell, { x: at.x, y: at.y });
              }
            }
          }
        }
        for (const e of entries) own.push(e);
        padCells.set(net, own);
      }
      void r;
    }
  }

  // A track may enter a cell when nothing belonging to another net sits within
  // the clearance distance of it. Checking the neighbourhood at this moment,
  // rather than reserving space up front, is what keeps two nets apart without
  // either of them hogging the board.
  const halo = Math.max(1, Math.ceil((clearance + trackWidth / 2) / pitch));
  function roomFor(cx: number, cy: number, layer: number, id: number): boolean {
    for (let dx = -halo; dx <= halo; dx++) {
      for (let dy = -halo; dy <= halo; dy++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const o = owner[idx(x, y, layer)];
        if (o !== FREE && o !== id) return false;
      }
    }
    return true;
  }

  const viaHalo = Math.max(halo + 1, Math.ceil((viaSize / 2 + clearance + 0.25) / pitch));
  function roomForVia(cx: number, cy: number, id: number): boolean {
    for (let dx = -viaHalo; dx <= viaHalo; dx++) {
      for (let dy = -viaHalo; dy <= viaHalo; dy++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) return false;
        for (const l of [0, 1]) {
          const o = owner[idx(x, y, l)];
          if (o !== FREE && o !== id) return false;
        }
      }
    }
    return true;
  }

  markExisting();

  // #region search
  const prev = new Int32Array(LAYER * 2);
  const seen = new Int32Array(LAYER * 2);
  let stamp = 0;
  const queue = new Int32Array(LAYER * 2);

  const tracks: Track[] = [];
  const vias: Via[] = [];
  const skipped: string[] = [];
  let routed = 0;
  let failed = 0;

  // Short nets first: they are the easiest and they get out of the way.
  const order = nl.nets
    .filter((n) => n.pins.length > 1)
    .map((n) => {
      const pts = padCells.get(n.name) ?? [];
      let span = 0;
      if (pts.length > 1) {
        const cxs = pts.map((p) => p.cx);
        const cys = pts.map((p) => p.cy);
        span = Math.max(...cxs) - Math.min(...cxs) + (Math.max(...cys) - Math.min(...cys));
      }
      return { net: n, span };
    })
    .sort((a, b) => a.span - b.span);

  for (const { net } of order) {
    if (Date.now() - started > maxMs) break;
    if (isPower(net.name)) {
      skipped.push(net.name);
      continue;
    }
    const id = netId.get(net.name)!;
    const cells = padCells.get(net.name) ?? [];
    if (cells.length < 2) continue;

    // Grow the net one pad at a time, from everything already connected.
    const groups: { cx: number; cy: number; layer: number }[][] = [];
    const byPad = new Map<string, { cx: number; cy: number; layer: number }[]>();
    for (const c of cells) {
      const key = `${Math.round(c.cx / 2)},${Math.round(c.cy / 2)}`;
      const arr = byPad.get(key) ?? [];
      arr.push(c);
      byPad.set(key, arr);
    }
    // A pad cell is usable only if a track may legally sit on it. On dense
    // parts the pad next door can be inside the clearance distance, and seeding
    // the search there puts copper where it is not allowed.
    for (const arr of byPad.values()) {
      const usable = arr.filter((c) => roomFor(c.cx, c.cy, c.layer, id));
      if (usable.length) groups.push(usable);
    }
    if (groups.length < 2) continue;

    let connected = groups[0];
    for (let g = 1; g < groups.length; g++) {
      if (Date.now() - started > maxMs) break;
      const target = new Set(groups[g].map((c) => idx(c.cx, c.cy, c.layer)));
      stamp++;
      let head = 0;
      let tail = 0;
      for (const c of connected) {
        const i = idx(c.cx, c.cy, c.layer);
        if (seen[i] === stamp) continue;
        seen[i] = stamp;
        prev[i] = -1;
        queue[tail++] = i;
      }
      let found = -1;
      while (head < tail && found < 0) {
        const cur = queue[head++];
        if (target.has(cur)) {
          found = cur;
          break;
        }
        const layer = cur >= LAYER ? 1 : 0;
        const rest = cur - layer * LAYER;
        const cy = (rest / W) | 0;
        const cx = rest - cy * W;
        const push = (nx: number, ny: number, nl2: number) => {
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) return;
          const ni = idx(nx, ny, nl2);
          if (seen[ni] === stamp) return;
          if (!roomFor(nx, ny, nl2, id)) return;
          seen[ni] = stamp;
          prev[ni] = cur;
          queue[tail++] = ni;
        };
        push(cx + 1, cy, layer);
        push(cx - 1, cy, layer);
        push(cx, cy + 1, layer);
        push(cx, cy - 1, layer);
        // A via punches through both layers and needs its own clearance, so it
        // only goes where the neighbourhood is free on both sides of the board.
        // A via is a hole, and a hole needs more room than a track does.
        if (roomForVia(cx, cy, id)) push(cx, cy, 1 - layer);
      }

      if (found < 0) {
        failed++;
        continue;
      }

      // Walk back, emitting straight runs and a via wherever the layer changes.
      const path: { cx: number; cy: number; layer: number }[] = [];
      for (let p = found; p >= 0; p = prev[p]) {
        const layer = p >= LAYER ? 1 : 0;
        const rest = p - layer * LAYER;
        const cy = (rest / W) | 0;
        const cx = rest - cy * W;
        path.push({ cx, cy, layer });
        owner[p] = id;
        if (prev[p] === -1) break;
      }
      path.reverse();

      // Land both ends on the pad they belong to.
      for (const end of [path[0], path[path.length - 1]]) {
        const anchor = padAnchor.get(idx(end.cx, end.cy, end.layer));
        if (!anchor) continue;
        const cellPt = { x: mmX(end.cx), y: mmY(end.cy) };
        if (Math.hypot(anchor.x - cellPt.x, anchor.y - cellPt.y) < 0.01) continue;
        tracks.push(stub(end.layer, anchor, cellPt, net.name));
      }

      let runStart = path[0];
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1];
        const b = path[i];
        const turning = i + 1 < path.length && (path[i + 1].cx - b.cx !== b.cx - a.cx || path[i + 1].cy - b.cy !== b.cy - a.cy);
        if (b.layer !== a.layer) {
          if (runStart.cx !== a.cx || runStart.cy !== a.cy) {
            tracks.push(segment(runStart, a, net.name));
          }
          vias.push({
            uuid: crypto.randomUUID(),
            at: { x: +mmX(b.cx).toFixed(3), y: +mmY(b.cy).toFixed(3) },
            size: viaSize,
            drill: viaDrill,
            net: net.name,
          });
          runStart = b;
        } else if (turning || i === path.length - 1) {
          tracks.push(segment(runStart, b, net.name));
          runStart = b;
        }
      }
      connected = connected.concat(groups[g], path);
      routed++;
    }
  }

  function stub(layer: number, from: { x: number; y: number }, to: { x: number; y: number }, net: string): Track {
    return {
      uuid: crypto.randomUUID(),
      layer: layer === 0 ? "F.Cu" : "B.Cu",
      width: trackWidth,
      start: { x: +from.x.toFixed(3), y: +from.y.toFixed(3) },
      end: { x: +to.x.toFixed(3), y: +to.y.toFixed(3) },
      net,
    };
  }

  function segment(a: { cx: number; cy: number; layer: number }, b: { cx: number; cy: number; layer: number }, net: string): Track {
    return {
      uuid: crypto.randomUUID(),
      layer: a.layer === 0 ? "F.Cu" : "B.Cu",
      width: trackWidth,
      start: { x: +mmX(a.cx).toFixed(3), y: +mmY(a.cy).toFixed(3) },
      end: { x: +mmX(b.cx).toFixed(3), y: +mmY(b.cy).toFixed(3) },
      net,
    };
  }

  return { routed, failed, skipped, tracks, vias, seconds: (Date.now() - started) / 1000 };
}
