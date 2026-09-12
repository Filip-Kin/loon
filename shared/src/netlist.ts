// #region Netlist
// Turns geometry and label text into connectivity: which pins are actually on
// the same net. Everything downstream is a function of this - ERC, the PCB
// ratsnest, simulation, the pin budget, and every question the assistant
// answers about what is wired to what.
//
// Connection rules, matching KiCad:
// - Two things at the same point are connected.
// - A wire connects all of its own vertices.
// - A wire endpoint or a pin landing on another wire's segment connects (a T).
// - Two wires merely crossing mid-span do NOT connect without a junction.
// - Labels with the same text connect, and name the net.
// - A power symbol names its net after its Value ("GND", "+3V3").

import type { Schematic, LibSymbol, Point, PinType } from "./schematic";
import { pinWorld } from "./geometry";

export interface NetPin {
  ref: string;
  pin: string;
  pinName: string;
  type: PinType;
  libId: string;
  at: Point;
}

export interface Net {
  id: string;
  name: string;
  // True when the net is a supply rail, named by a power symbol or a rail label.
  isPower: boolean;
  pins: NetPin[];
  labels: string[];
}

export interface Netlist {
  nets: Net[];
  // "REF:PIN" -> net name.
  netOfPin: Record<string, string>;
}

export type DefResolver = (libId: string) => LibSymbol | undefined;

const TOL = 0.05; // mm
const key = (p: Point) => `${Math.round(p.x / TOL)},${Math.round(p.y / TOL)}`;

class DisjointSet {
  private parent = new Map<string, string>();
  find(a: string): string {
    let root = this.parent.get(a);
    if (root === undefined) {
      this.parent.set(a, a);
      return a;
    }
    while (root !== this.parent.get(root)) root = this.parent.get(root)!;
    this.parent.set(a, root);
    return root;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

// Is p on the segment a-b, strictly between the endpoints?
function onSegment(p: Point, a: Point, b: Point): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < TOL) return false;
  const cross = Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
  if (cross > TOL) return false;
  const dot = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len;
  return dot > TOL && dot < len - TOL;
}

const RAIL_NAME = /^(GND|AGND|DGND|PGND|VSS|VCC|VDD|VBUS|\+?\d+V\d*|\+\d+V\d*)$/i;

export function buildNetlist(schem: Schematic, resolve?: DefResolver): Netlist {
  const ds = new DisjointSet();
  const def = (libId: string) => resolve?.(libId) ?? schem.libSymbols[libId];

  // Every distinct point is a node; equal points merge for free through the key.
  const allPoints: Point[] = [];
  const addPoint = (p: Point) => {
    ds.find(key(p));
    allPoints.push(p);
  };

  // 1. Wires join their own vertices.
  for (const w of schem.wires) {
    for (let i = 0; i < w.pts.length; i++) {
      addPoint(w.pts[i]);
      if (i > 0) ds.union(key(w.pts[i - 1]), key(w.pts[i]));
    }
  }

  // 2. Pins.
  const pins: NetPin[] = [];
  for (const inst of schem.symbols) {
    const d = def(inst.libId);
    if (!d) continue;
    for (const p of d.pins) {
      const at = pinWorld(p, inst);
      addPoint(at);
      pins.push({
        ref: inst.properties.Reference ?? "?",
        pin: p.number,
        pinName: p.name,
        type: p.type,
        libId: inst.libId,
        at,
      });
    }
  }

  for (const j of schem.junctions) addPoint(j.at);
  for (const l of schem.labels) addPoint(l.at);

  // 3. A point sitting on another wire's segment is a T connection.
  for (const p of allPoints) {
    for (const w of schem.wires) {
      for (let i = 1; i < w.pts.length; i++) {
        if (onSegment(p, w.pts[i - 1], w.pts[i])) ds.union(key(p), key(w.pts[i - 1]));
      }
    }
  }

  // 4. Labels name a node, and equal names join.
  const labelNodes = new Map<string, string[]>();
  for (const l of schem.labels) {
    const text = l.text.trim();
    const arr = labelNodes.get(text) ?? [];
    arr.push(key(l.at));
    labelNodes.set(text, arr);
  }
  // Power symbols behave like a label carrying their Value.
  for (const inst of schem.symbols) {
    if (!inst.libId.startsWith("power:")) continue;
    const d = def(inst.libId);
    const p = d?.pins[0];
    if (!p) continue;
    const text = (inst.properties.Value ?? "").trim();
    if (!text) continue;
    const arr = labelNodes.get(text) ?? [];
    arr.push(key(pinWorld(p, inst)));
    labelNodes.set(text, arr);
  }
  for (const [, nodes] of labelNodes) {
    for (let i = 1; i < nodes.length; i++) ds.union(nodes[0], nodes[i]);
  }

  // 5. Collect.
  const byRoot = new Map<string, Net>();
  const netFor = (k: string): Net => {
    const root = ds.find(k);
    let net = byRoot.get(root);
    if (!net) {
      net = { id: root, name: "", isPower: false, pins: [], labels: [] };
      byRoot.set(root, net);
    }
    return net;
  };
  for (const [text, nodes] of labelNodes) {
    const net = netFor(nodes[0]);
    if (!net.labels.includes(text)) net.labels.push(text);
  }
  for (const p of pins) {
    // Power symbol pins are naming devices, not real loads.
    if (p.libId.startsWith("power:")) continue;
    netFor(key(p.at)).pins.push(p);
  }

  const nets: Net[] = [];
  let anon = 0;
  for (const net of byRoot.values()) {
    if (net.pins.length === 0 && net.labels.length === 0) continue;
    const railLabel = net.labels.find((l) => RAIL_NAME.test(l));
    net.name = railLabel ?? net.labels[0] ?? `N$${++anon}`;
    net.isPower = !!railLabel;
    nets.push(net);
  }
  nets.sort((a, b) => a.name.localeCompare(b.name));

  const netOfPin: Record<string, string> = {};
  for (const net of nets) for (const p of net.pins) netOfPin[`${p.ref}:${p.pin}`] = net.name;

  return { nets, netOfPin };
}

export function formatNetlist(nl: Netlist, limit = 60): string {
  const lines = nl.nets
    .slice(0, limit)
    .map((n) => `${n.name}: ${n.pins.map((p) => `${p.ref}.${p.pin}(${p.pinName})`).join(" ") || "(no pins)"}`);
  if (nl.nets.length > limit) lines.push(`... and ${nl.nets.length - limit} more nets`);
  return lines.join("\n");
}
