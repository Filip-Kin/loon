// #region Apply ops (shared)
// The single mutation path for a schematic. UI edits, AI edits, and undo/redo
// all funnel Op[] through here. It is pure over a LibResolver so the browser
// (instant local edits) and the server (AI edits) run identical logic.

import type { Schematic, SymbolInstance, LibSymbol, Point } from "./schematic";
import type { Op, OpResult } from "./ops";
import { findPin, pinWorld, routeOrthogonal, snapPoint, instanceBBox, PLACE_GRID } from "./geometry";
import { MODULES } from "./modules";
import { buildIcSymbol } from "./symbolgen";

export interface ResolvedPart {
  def: LibSymbol;
  footprint?: string;
}

export type LibResolver = (libId: string) => ResolvedPart | undefined;

function newUuid(): string {
  return crypto.randomUUID();
}

function nextRef(schem: Schematic, prefix: string): string {
  let max = 0;
  for (const s of schem.symbols) {
    const ref = s.properties.Reference ?? "";
    if (ref.startsWith(prefix)) {
      const n = parseInt(ref.slice(prefix.length), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  }
  return `${prefix}${max + 1}`;
}

const normRef = (r: string) => r.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

// Power and ground nets are joined by name everywhere, the way a schematic is
// normally drawn; everything else inside a block is drawn as wire.
const RAIL_NETS = /^(GND|AGND|PGND|VBUS|VCC|VDD|\+?\d+V\d*|\+\d+V)$/i;
function isRailNet(label: string): boolean {
  return RAIL_NETS.test(label.trim());
}

// A wire that passes over an unrelated pin connects to it - that is how KiCad
// reads it, and it is a real short, not a cosmetic problem. So a wire is only
// drawn when its route is clear of every other pin and symbol body; otherwise
// the two ends stay joined by name.
const CLEAR_TOL = 0.6; // mm

function pointOnSegment(p: Point, a: Point, b: Point, tol: number): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return false;
  const cross = Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
  if (cross > tol) return false;
  const dot = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len;
  return dot > tol && dot < len - tol;
}

function segmentHitsBox(a: Point, b: Point, box: { min: Point; max: Point }): boolean {
  // Axis-aligned segments only, which is all routeOrthogonal produces.
  const lo = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
  const hi = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
  return lo.x <= box.max.x && hi.x >= box.min.x && lo.y <= box.max.y && hi.y >= box.min.y;
}

function routeIsClear(pts: Point[], obstacles: { pins: Point[]; boxes: { min: Point; max: Point }[] }): boolean {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    for (const p of obstacles.pins) if (pointOnSegment(p, a, b, CLEAR_TOL)) return false;
    for (const box of obstacles.boxes) if (segmentHitsBox(a, b, box)) return false;
  }
  return true;
}

function findByRef(schem: Schematic, ref: string): SymbolInstance | undefined {
  // Exact match first, then a forgiving normalized match so an AI-guessed
  // "#PWR01" still resolves to a "PWR1" instance.
  return (
    schem.symbols.find((s) => s.properties.Reference === ref) ??
    schem.symbols.find((s) => normRef(s.properties.Reference ?? "") === normRef(ref))
  );
}

// Pin lookup by number, falling back to pin name (case-insensitive) so
// references like {pin: "+5V"} or {pin: "GND"} also work.
function resolvePin(def: LibSymbol, pin: string) {
  return (
    findPin(def, pin) ??
    def.pins.find((p) => p.name.toLowerCase() === pin.toLowerCase())
  );
}

export function applyOp(schem: Schematic, op: Op, resolveBase: LibResolver): OpResult {
  // Parts declared at runtime (define_symbol) and parts loaded from an
  // external file live on the schematic, not in the builtin catalog. Falling
  // back to them here means every caller - browser, server, undo/redo - can
  // place and wire them without a library round trip.
  const resolve: LibResolver = (libId) => {
    const hit = resolveBase(libId);
    if (hit) return hit;
    const def = schem.libSymbols[libId];
    return def ? { def, footprint: def.defaults.Footprint || undefined } : undefined;
  };
  switch (op.op) {
    case "define_symbol": {
      const { op: _op, ...spec } = op;
      if (!spec.libId || !spec.libId.includes(":")) {
        return { ok: false, error: `define_symbol needs a libId like "Library:PartName"` };
      }
      if (!spec.pins || spec.pins.length === 0) {
        return { ok: false, error: `define_symbol ${spec.libId} has no pins` };
      }
      schem.libSymbols[spec.libId] = buildIcSymbol(spec);
      return { ok: true };
    }

    case "add_symbol": {
      const part = resolve(op.libId);
      if (!part) return { ok: false, error: `Unknown part: ${op.libId}` };
      const uuid = op.uuid ?? newUuid();
      const ref = op.ref ?? nextRef(schem, part.def.refPrefix);
      const at = op.at ? snapPoint(op.at, PLACE_GRID) : { x: 100, y: 100 };
      const props: Record<string, string> = {
        Reference: ref,
        Value: op.value ?? part.def.defaults.Value ?? part.def.libId.split(":")[1] ?? "",
        Footprint: part.footprint ?? "",
        Datasheet: part.def.datasheet ?? "~",
      };
      schem.symbols.push({ uuid, libId: op.libId, at, rotation: op.rotation ?? 0, mirror: null, unit: 1, properties: props });
      // Ensure the schematic carries the def for rendering + save.
      schem.libSymbols[op.libId] = part.def;
      return { ok: true, createdUuid: uuid };
    }

    case "move_symbol": {
      const s = schem.symbols.find((x) => x.uuid === op.uuid);
      if (!s) return { ok: false, error: `No symbol ${op.uuid}` };
      s.at = snapPoint(op.at, PLACE_GRID);
      if (op.rotation !== undefined) s.rotation = ((op.rotation % 360) + 360) % 360;
      return { ok: true };
    }

    case "set_property": {
      const s = schem.symbols.find((x) => x.uuid === op.uuid);
      if (!s) return { ok: false, error: `No symbol ${op.uuid}` };
      s.properties[op.key] = op.value;
      return { ok: true };
    }

    case "delete": {
      if (!schem.texts) schem.texts = [];
      const has = (arr: { uuid: string }[]) => arr.some((x) => x.uuid === op.uuid);
      const had = has(schem.symbols) || has(schem.wires) || has(schem.labels) || has(schem.junctions) || has(schem.noConnects) || has(schem.texts);
      schem.symbols = schem.symbols.filter((x) => x.uuid !== op.uuid);
      schem.wires = schem.wires.filter((x) => x.uuid !== op.uuid);
      schem.labels = schem.labels.filter((x) => x.uuid !== op.uuid);
      schem.junctions = schem.junctions.filter((x) => x.uuid !== op.uuid);
      schem.noConnects = schem.noConnects.filter((x) => x.uuid !== op.uuid);
      schem.texts = schem.texts.filter((x) => x.uuid !== op.uuid);
      return had ? { ok: true } : { ok: false, error: `Nothing with uuid ${op.uuid}` };
    }

    case "add_wire": {
      const uuid = newUuid();
      schem.wires.push({ uuid, pts: routeOrthogonal(op.from, op.to) });
      return { ok: true, createdUuid: uuid };
    }

    case "connect_pins": {
      const a = findByRef(schem, op.a.ref);
      const b = findByRef(schem, op.b.ref);
      if (!a) return { ok: false, error: `No symbol with reference ${op.a.ref}` };
      if (!b) return { ok: false, error: `No symbol with reference ${op.b.ref}` };
      const ad = resolve(a.libId)?.def;
      const bd = resolve(b.libId)?.def;
      if (!ad || !bd) return { ok: false, error: `Missing symbol definition` };
      const ap = resolvePin(ad, op.a.pin);
      const bp = resolvePin(bd, op.b.pin);
      if (!ap) return { ok: false, error: `${op.a.ref} has no pin ${op.a.pin}` };
      if (!bp) return { ok: false, error: `${op.b.ref} has no pin ${op.b.pin}` };
      const from = pinWorld(ap, a);
      const to = pinWorld(bp, b);
      const uuid = newUuid();
      schem.wires.push({ uuid, pts: routeOrthogonal(from, to) });
      return { ok: true, createdUuid: uuid };
    }

    case "add_junction": {
      const uuid = newUuid();
      schem.junctions.push({ uuid, at: snapPoint(op.at) });
      return { ok: true, createdUuid: uuid };
    }

    case "add_label": {
      const uuid = newUuid();
      schem.labels.push({ uuid, kind: op.kind ?? "local", text: op.text, at: snapPoint(op.at), rotation: op.rotation ?? 0 });
      return { ok: true, createdUuid: uuid };
    }

    case "add_no_connect": {
      const uuid = newUuid();
      schem.noConnects.push({ uuid, at: snapPoint(op.at) });
      return { ok: true, createdUuid: uuid };
    }

    case "add_text": {
      const uuid = newUuid();
      if (!schem.texts) schem.texts = [];
      schem.texts.push({ uuid, text: op.text, at: op.at, rotation: op.rotation ?? 0, size: op.size ?? 1.6 });
      return { ok: true, createdUuid: uuid };
    }

    case "set_title": {
      if (op.title !== undefined) schem.title = op.title;
      if (op.rev !== undefined) schem.rev = op.rev;
      if (op.company !== undefined) schem.company = op.company;
      return { ok: true };
    }

    case "move_block": {
      const members = schem.symbols.filter((s) => s.properties.LoonBlock === op.blockId);
      if (members.length === 0) return { ok: false, error: `No block ${op.blockId}` };
      let dx = op.by?.dx ?? 0;
      let dy = op.by?.dy ?? 0;
      if (op.at) {
        // Move so the block's top-left member lands on `at`.
        const minX = Math.min(...members.map((m) => m.at.x));
        const minY = Math.min(...members.map((m) => m.at.y));
        dx = op.at.x - minX;
        dy = op.at.y - minY;
      }
      for (const m of members) m.at = snapPoint({ x: m.at.x + dx, y: m.at.y + dy }, PLACE_GRID);
      // Wires and labels inside the block travel with it.
      const refs = new Set(members.map((m) => m.properties.Reference));
      for (const l of schem.labels) {
        // Only labels that sat on a member pin move; a label out on the sheet
        // belongs to the sheet.
        for (const m of members) {
          const d = resolve(m.libId)?.def;
          if (!d) continue;
          const hit = d.pins.some((pin) => {
            const at = pinWorld(pin, { at: { x: m.at.x - dx, y: m.at.y - dy }, rotation: m.rotation, mirror: m.mirror });
            return Math.abs(at.x - l.at.x) < 0.6 && Math.abs(at.y - l.at.y) < 0.6;
          });
          if (hit) {
            l.at = { x: l.at.x + dx, y: l.at.y + dy };
            break;
          }
        }
      }
      for (const w of schem.wires) {
        const inside = w.pts.every((pt) =>
          members.some((m) => {
            const d = resolve(m.libId)?.def;
            if (!d) return false;
            return d.pins.some((pin) => {
              const at = pinWorld(pin, { at: { x: m.at.x - dx, y: m.at.y - dy }, rotation: m.rotation, mirror: m.mirror });
              return Math.abs(at.x - pt.x) < 8 && Math.abs(at.y - pt.y) < 8;
            });
          }),
        );
        if (inside) w.pts = w.pts.map((pt) => ({ x: pt.x + dx, y: pt.y + dy }));
      }
      void refs;
      return { ok: true };
    }

    case "delete_block": {
      const members = schem.symbols.filter((s) => s.properties.LoonBlock === op.blockId);
      if (members.length === 0) return { ok: false, error: `No block ${op.blockId}` };
      for (const m of members) applyOp(schem, { op: "delete", uuid: m.uuid }, resolveBase);
      return { ok: true };
    }

    case "rename_net": {
      let n = 0;
      for (const l of schem.labels) {
        if (l.text === op.from) {
          l.text = op.to;
          n++;
        }
      }
      return n > 0 ? { ok: true } : { ok: false, error: `No net named ${op.from}` };
    }

    case "set_block_params": {
      const members = schem.symbols.filter((s) => s.properties.LoonBlock === op.blockId);
      if (members.length === 0) return { ok: false, error: `No block ${op.blockId}` };
      const moduleId = members[0].properties.LoonModule;
      if (!moduleId || !MODULES[moduleId]) return { ok: false, error: `Block ${op.blockId} has no module to rebuild from` };
      const at = { x: Math.min(...members.map((m) => m.at.x)), y: Math.min(...members.map((m) => m.at.y)) };
      const old = JSON.parse(members[0].properties.LoonBlockParams ?? "{}");
      for (const m of members) applyOp(schem, { op: "delete", uuid: m.uuid }, resolveBase);
      return applyOp(schem, { op: "instantiate_module", moduleId, params: { ...old, ...op.params }, at }, resolveBase);
    }

    case "instantiate_module": {
      const mod = MODULES[op.moduleId];
      if (!mod) return { ok: false, error: `Unknown module: ${op.moduleId}` };
      const block = mod.build(op.params ?? {});
      const base = op.at ? snapPoint(op.at, PLACE_GRID) : { x: 100, y: 100 };
      const localToRef = new Map<string, string>();
      let firstUuid: string | undefined;
      // One block id shared by all parts, so a future block view can collapse,
      // re-parametrise, or drill into this instance. Provenance survives save
      // as ordinary KiCad symbol fields.
      const blockId = newUuid();
      const paramStr = JSON.stringify(op.params ?? {});
      // Place each part; record the auto-assigned reference for local wiring.
      for (const part of block.parts) {
        const r = applyOp(schem, { op: "add_symbol", libId: part.libId, value: part.value, at: { x: base.x + part.dx, y: base.y + part.dy }, rotation: part.rotation }, resolve);
        if (!r.ok) return { ok: false, error: `module ${op.moduleId}: ${r.error}` };
        const inst = schem.symbols.find((s) => s.uuid === r.createdUuid)!;
        inst.properties.LoonBlock = blockId;
        inst.properties.LoonModule = op.moduleId;
        inst.properties.LoonBlockPart = part.local;
        if (part.local === block.parts[0].local) inst.properties.LoonBlockParams = paramStr;
        localToRef.set(part.local, inst.properties.Reference);
        firstUuid ??= r.createdUuid;
      }
      for (const w of block.wires) {
        applyOp(schem, { op: "connect_pins", a: { ref: localToRef.get(w.a.local) ?? w.a.local, pin: w.a.pin }, b: { ref: localToRef.get(w.b.local) ?? w.b.local, pin: w.b.pin } }, resolve);
      }
      // Nets inside a module get drawn as real wires between the pins that
      // share them, with a single label left on the net so other blocks can
      // still join it by name. Power rails stay label-only: chaining every GND
      // pin into one polyline is spaghetti, and rails are understood by name.
      const netPoints = new Map<string, { at: Point; first: boolean }[]>();
      for (const net of block.nets) {
        const ref = localToRef.get(net.local);
        const inst = schem.symbols.find((s) => s.properties.Reference === ref);
        const def = inst ? resolve(inst.libId)?.def : undefined;
        const pin = def ? findPin(def, net.pin) ?? def.pins.find((pp) => pp.name.toLowerCase() === net.pin.toLowerCase()) : undefined;
        if (!inst || !pin) continue;
        const at = pinWorld(pin, inst);
        const list = netPoints.get(net.label) ?? [];
        list.push({ at, first: list.length === 0 });
        netPoints.set(net.label, list);
      }
      // Obstacles: every pin not on this net, and every symbol body.
      const memberRefs = new Set(localToRef.values());
      const allPinPoints: { at: Point; netLabel?: string }[] = [];
      const bodyBoxes: { min: Point; max: Point }[] = [];
      for (const inst of schem.symbols) {
        const d = resolve(inst.libId)?.def;
        if (!d) continue;
        for (const pin of d.pins) allPinPoints.push({ at: pinWorld(pin, inst) });
        if (memberRefs.has(inst.properties.Reference ?? "")) {
          bodyBoxes.push(instanceBBox(d, { at: inst.at, rotation: inst.rotation, mirror: inst.mirror }));
        }
      }

      for (const [label, pts] of netPoints) {
        const blockedEnds: Point[] = [];
        if (!isRailNet(label) && pts.length > 1) {
          // Chain the pins nearest-first so the wire order follows the layout
          // rather than the order the module happened to declare them in.
          const remaining = pts.slice(1).map((p) => p.at);
          let cur = pts[0].at;
          while (remaining.length > 0) {
            let bestIdx = 0;
            let bestD = Infinity;
            for (let i = 0; i < remaining.length; i++) {
              const d = Math.abs(remaining[i].x - cur.x) + Math.abs(remaining[i].y - cur.y);
              if (d < bestD) { bestD = d; bestIdx = i; }
            }
            const next = remaining.splice(bestIdx, 1)[0];
            const route = routeOrthogonal(cur, next);
            const onNet = new Set(pts.map((pp) => `${pp.at.x},${pp.at.y}`));
            const obstacles = {
              pins: allPinPoints.filter((pp) => !onNet.has(`${pp.at.x},${pp.at.y}`)).map((pp) => pp.at),
              boxes: bodyBoxes,
            };
            if (routeIsClear(route, obstacles)) {
              schem.wires.push({ uuid: newUuid(), pts: route });
            } else {
              // Blocked: fall back to joining by name at both ends.
              blockedEnds.push(cur, next);
            }
            cur = next;
          }
        }
        // One label per net inside the block (every pin for rails, and both
        // ends of any hop that could not be wired without crossing something).
        const labelled = isRailNet(label) ? pts.map((pp) => pp.at) : [pts[0].at, ...blockedEnds];
        const placed = new Set<string>();
        for (const at of labelled) {
          const k = `${at.x},${at.y}`;
          if (placed.has(k)) continue;
          placed.add(k);
          schem.labels.push({ uuid: newUuid(), kind: "local", text: label, at, rotation: 0 });
        }
      }
      return { ok: true, createdUuid: firstUuid };
    }

    default:
      return { ok: false, error: `Unknown op` };
  }
}

export function applyOps(schem: Schematic, ops: Op[], resolve: LibResolver): { results: OpResult[]; createdUuids: string[] } {
  const results: OpResult[] = [];
  const createdUuids: string[] = [];
  for (const op of ops) {
    const r = applyOp(schem, op, resolve);
    results.push(r);
    if (r.createdUuid) createdUuids.push(r.createdUuid);
  }
  return { results, createdUuids };
}
