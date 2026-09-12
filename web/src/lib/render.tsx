import React from "react";
import type { LibSymbol, SymbolInstance, SymGraphic, Point } from "@loon/shared/schematic";
import { localToWorld, pinWorld, pinBodyEnd, type Placement } from "@loon/shared/geometry";

const SYMBOL = "#d8b24a";
const PIN = "#cf3a3a";
const TEXT = "#9a9a9a";

function fillFor(fill?: string): string {
  if (fill === "outline") return "rgba(216,178,74,0.12)";
  if (fill === "background") return "rgba(120,120,120,0.10)";
  return "none";
}

// Circular arc through three points, sampled to a polyline in world space.
function arcPoints(start: Point, mid: Point, end: Point, place: Placement): Point[] {
  const ax = start.x, ay = start.y, bx = mid.x, by = mid.y, cx = end.x, cy = end.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return [localToWorld(start, place), localToWorld(end, place)];
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const center = { x: ux, y: uy };
  const r = Math.hypot(ax - ux, ay - uy);
  let a0 = Math.atan2(ay - uy, ax - ux);
  let a1 = Math.atan2(cy - uy, cx - ux);
  const am = Math.atan2(by - uy, bx - ux);
  const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  // Walk from a0 to a1 the way that passes through am.
  let start0 = norm(a0);
  let end0 = norm(a1);
  let midN = norm(am);
  let sweepCCW = false;
  const inRange = (s: number, e: number, m: number, ccw: boolean) => {
    if (ccw) { if (e < s) e += 2 * Math.PI; if (m < s) m += 2 * Math.PI; return m >= s && m <= e; }
    else { if (e > s) e -= 2 * Math.PI; if (m > s) m -= 2 * Math.PI; return m <= s && m >= e; }
  };
  sweepCCW = inRange(start0, end0, midN, true);
  const pts: Point[] = [];
  const N = 16;
  let span = end0 - start0;
  if (sweepCCW && span < 0) span += 2 * Math.PI;
  if (!sweepCCW && span > 0) span -= 2 * Math.PI;
  for (let i = 0; i <= N; i++) {
    const a = start0 + (span * i) / N;
    pts.push(localToWorld({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) }, place));
  }
  return pts;
}

function graphicEl(g: SymGraphic, place: Placement, key: number): React.ReactNode {
  const commonStroke = { stroke: SYMBOL, strokeWidth: 0.2, vectorEffect: "non-scaling-stroke" as const };
  switch (g.type) {
    case "rect": {
      const p1 = localToWorld(g.a, place);
      const p2 = localToWorld(g.b, place);
      const x = Math.min(p1.x, p2.x), y = Math.min(p1.y, p2.y);
      return <rect key={key} x={x} y={y} width={Math.abs(p2.x - p1.x)} height={Math.abs(p2.y - p1.y)} fill={fillFor(g.fill)} {...commonStroke} />;
    }
    case "polyline": {
      const pts = g.pts.map((p) => localToWorld(p, place));
      return <polyline key={key} points={pts.map((p) => `${p.x},${p.y}`).join(" ")} fill={fillFor(g.fill)} {...commonStroke} />;
    }
    case "circle": {
      const c = localToWorld(g.center, place);
      return <circle key={key} cx={c.x} cy={c.y} r={g.radius} fill={fillFor(g.fill)} {...commonStroke} />;
    }
    case "arc": {
      const pts = arcPoints(g.start, g.mid, g.end, place);
      return <polyline key={key} points={pts.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" {...commonStroke} />;
    }
    case "text": {
      const p = localToWorld(g.at, place);
      return <text key={key} x={p.x} y={p.y} fontSize={g.size} fill={TEXT} textAnchor="middle" dominantBaseline="middle">{g.text}</text>;
    }
  }
}

export function SymbolView({ inst, def, selected, highlighted }: { inst: SymbolInstance; def: LibSymbol; selected: boolean; highlighted?: boolean }) {
  const place: Placement = { at: inst.at, rotation: inst.rotation, mirror: inst.mirror };
  return (
    <g opacity={selected ? 1 : 0.95} filter={highlighted ? "url(#netglow)" : undefined}>
      {def.graphics.map((g, i) => graphicEl(g, place, i))}
      {def.pins.map((pin, i) => {
        const a = pinWorld(pin, place);
        const b = pinBodyEnd(pin, place);
        // Named pins get their name inside the body and their number outside,
        // the way KiCad draws an IC. Anonymous passives (name "~") stay bare.
        const named = pin.name && pin.name !== "~";
        const dx = b.x - a.x, dy = b.y - a.y;
        const anchor = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "start" : "end") : "middle";
        return (
          <g key={`p${i}`}>
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={SYMBOL} strokeWidth={0.2} vectorEffect="non-scaling-stroke" />
            <circle cx={a.x} cy={a.y} r={0.5} fill={PIN} />
            {named && (
              <>
                <text x={b.x + Math.sign(dx) * 0.6} y={b.y + 0.45} fontSize={1.1} fill={TEXT} stroke="#14151a" strokeWidth={0.4} paintOrder="stroke" strokeLinejoin="round" textAnchor={anchor}>{pin.name}</text>
                <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 0.4} fontSize={0.9} fill="#6f6f6f" textAnchor="middle">{pin.number}</text>
              </>
            )}
          </g>
        );
      })}
      {/* Reference + value text, kept upright for readability. */}
      <text x={inst.at.x + 2} y={inst.at.y - 3} fontSize={1.4} fill={selected ? "#fff" : "#cfcfcf"} stroke="#14151a" strokeWidth={0.45} paintOrder="stroke" strokeLinejoin="round">{inst.properties.Reference}</text>
      <text x={inst.at.x + 2} y={inst.at.y - 1.2} fontSize={1.3} fill={TEXT} stroke="#14151a" strokeWidth={0.45} paintOrder="stroke" strokeLinejoin="round">{inst.properties.Value}</text>
    </g>
  );
}

// Pin hit-test data for the wiring tool.
export interface PinHandle { ref: string; pin: string; at: Point }

export function collectPins(inst: SymbolInstance, def: LibSymbol): PinHandle[] {
  const place: Placement = { at: inst.at, rotation: inst.rotation, mirror: inst.mirror };
  return def.pins.map((p) => ({ ref: inst.properties.Reference ?? "", pin: p.number, at: pinWorld(p, place) }));
}
