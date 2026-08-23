import React, { useRef, useState } from "react";
import type { Schematic, LibSymbol, Point } from "@loon/shared/schematic";
import type { PinRef } from "@loon/shared/ops";
import { instanceBBox, snapPoint, PLACE_GRID, dist, type Placement } from "@loon/shared/geometry";
import { deriveBlocks } from "@loon/shared/blocks";
import { SymbolView, collectPins, type PinHandle } from "../lib/render";

export type Tool = "select" | "place" | "wire";
export interface Viewport { x: number; y: number; scale: number }

interface Props {
  schem: Schematic;
  defs: Record<string, LibSymbol>;
  tool: Tool;
  placingLibId: string | null;
  selection: string | null;
  viewport: Viewport;
  setViewport: (v: Viewport) => void;
  onSelect: (uuid: string | null) => void;
  onPlace: (world: Point) => void;
  onMove: (uuid: string, world: Point) => void;
  onConnect: (a: PinRef, b: PinRef) => void;
  onAddWire: (from: Point, to: Point) => void;
}

const WIRE = "#4ea1ff";
const PIN_HIT = 1.6; // mm

export function Canvas(props: Props) {
  const { schem, defs, tool, viewport, setViewport } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const [cursor, setCursor] = useState<Point>({ x: 0, y: 0 });
  const [dragUuid, setDragUuid] = useState<string | null>(null);
  const [dragPos, setDragPos] = useState<Point | null>(null);
  const grabOffset = useRef<Point>({ x: 0, y: 0 });
  const panning = useRef<{ mx: number; my: number; vx: number; vy: number } | null>(null);
  const [wireStart, setWireStart] = useState<{ at: Point; pin?: PinRef } | null>(null);

  function toWorld(e: React.MouseEvent): Point {
    const rect = svgRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    return { x: (sx - viewport.x) / viewport.scale, y: (sy - viewport.y) / viewport.scale };
  }

  function allPins(): PinHandle[] {
    const out: PinHandle[] = [];
    for (const inst of schem.symbols) {
      const def = defs[inst.libId];
      if (def) out.push(...collectPins(inst, def));
    }
    return out;
  }

  function nearestPin(w: Point): PinHandle | null {
    let best: PinHandle | null = null;
    let bd = PIN_HIT;
    for (const p of allPins()) {
      const d = dist(p.at, w);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  function hitSymbol(w: Point): string | null {
    for (let i = schem.symbols.length - 1; i >= 0; i--) {
      const inst = schem.symbols[i];
      const def = defs[inst.libId];
      if (!def) continue;
      const place: Placement = { at: inst.at, rotation: inst.rotation, mirror: inst.mirror };
      const bb = instanceBBox(def, place);
      if (w.x >= bb.min.x - 1 && w.x <= bb.max.x + 1 && w.y >= bb.min.y - 1 && w.y <= bb.max.y + 1) {
        return inst.uuid;
      }
    }
    return null;
  }

  function onWheel(e: React.WheelEvent) {
    const rect = svgRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const newScale = Math.min(40, Math.max(1.5, viewport.scale * factor));
    // Keep the point under the cursor fixed.
    const wx = (sx - viewport.x) / viewport.scale;
    const wy = (sy - viewport.y) / viewport.scale;
    setViewport({ scale: newScale, x: sx - wx * newScale, y: sy - wy * newScale });
  }

  function onMouseDown(e: React.MouseEvent) {
    const w = toWorld(e);
    if (tool === "place") { props.onPlace(snapPoint(w, PLACE_GRID)); return; }
    if (tool === "wire") {
      const pin = nearestPin(w);
      const at = pin ? pin.at : snapPoint(w, PLACE_GRID);
      if (!wireStart) {
        setWireStart({ at, pin: pin ? { ref: pin.ref, pin: pin.pin } : undefined });
      } else {
        if (wireStart.pin && pin) props.onConnect(wireStart.pin, { ref: pin.ref, pin: pin.pin });
        else props.onAddWire(wireStart.at, at);
        setWireStart(null);
      }
      return;
    }
    // select tool
    const uuid = hitSymbol(w);
    if (uuid) {
      props.onSelect(uuid);
      const inst = schem.symbols.find((s) => s.uuid === uuid)!;
      grabOffset.current = { x: w.x - inst.at.x, y: w.y - inst.at.y };
      setDragUuid(uuid);
      setDragPos(inst.at);
    } else {
      props.onSelect(null);
      panning.current = { mx: e.clientX, my: e.clientY, vx: viewport.x, vy: viewport.y };
    }
  }

  function onMouseMove(e: React.MouseEvent) {
    const w = toWorld(e);
    setCursor(w);
    if (panning.current) {
      setViewport({ ...viewport, x: panning.current.vx + (e.clientX - panning.current.mx), y: panning.current.vy + (e.clientY - panning.current.my) });
      return;
    }
    if (dragUuid) {
      setDragPos(snapPoint({ x: w.x - grabOffset.current.x, y: w.y - grabOffset.current.y }, PLACE_GRID));
    }
  }

  function onMouseUp() {
    if (dragUuid && dragPos) {
      const inst = schem.symbols.find((s) => s.uuid === dragUuid);
      if (inst && (inst.at.x !== dragPos.x || inst.at.y !== dragPos.y)) props.onMove(dragUuid, dragPos);
    }
    setDragUuid(null);
    setDragPos(null);
    panning.current = null;
  }

  const cls = ["canvas", panning.current ? "panning" : tool === "place" ? "placing" : tool === "wire" ? "wiring" : ""].join(" ");
  const selInst = props.selection ? schem.symbols.find((s) => s.uuid === props.selection) : null;

  return (
    <svg
      ref={svgRef}
      className={cls}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      <defs>
        <pattern id="grid" width={PLACE_GRID} height={PLACE_GRID} patternUnits="userSpaceOnUse">
          <circle cx={0} cy={0} r={0.12} fill="#333" />
        </pattern>
      </defs>
      <g transform={`translate(${viewport.x},${viewport.y}) scale(${viewport.scale})`}>
        <rect x={-2000} y={-2000} width={6000} height={6000} fill="url(#grid)" />

        {/* module blocks (derived from provenance): a labelled group box */}
        {deriveBlocks(schem).map((b) => {
          let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
          for (const uuid of b.memberUuids) {
            const inst = schem.symbols.find((s) => s.uuid === uuid);
            const def = inst && defs[inst.libId];
            if (!inst || !def) continue;
            const at = inst.uuid === dragUuid && dragPos ? dragPos : inst.at;
            const bb = instanceBBox(def, { at, rotation: inst.rotation, mirror: inst.mirror });
            minx = Math.min(minx, bb.min.x); miny = Math.min(miny, bb.min.y);
            maxx = Math.max(maxx, bb.max.x); maxy = Math.max(maxy, bb.max.y);
          }
          if (!isFinite(minx)) return null;
          const pad = 2.5;
          const label = `${b.moduleId}${Object.keys(b.params).length ? " " + Object.entries(b.params).map(([k, v]) => `${k}=${v}`).join(" ") : ""}`;
          return (
            <g key={b.id}>
              <rect x={minx - pad} y={miny - pad} width={maxx - minx + pad * 2} height={maxy - miny + pad * 2}
                rx={1.5} fill="rgba(124,58,237,0.05)" stroke="rgba(124,58,237,0.5)" strokeWidth={0.25} strokeDasharray="1.5 1" vectorEffect="non-scaling-stroke" />
              <text x={minx - pad + 0.5} y={miny - pad - 0.8} fontSize={1.6} fill="#9a6bff">{label}</text>
            </g>
          );
        })}

        {/* wires */}
        {schem.wires.map((w) => (
          <polyline key={w.uuid} points={w.pts.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={WIRE} strokeWidth={0.3} vectorEffect="non-scaling-stroke" />
        ))}

        {/* junctions */}
        {schem.junctions.map((j) => (
          <circle key={j.uuid} cx={j.at.x} cy={j.at.y} r={0.6} fill={WIRE} />
        ))}

        {/* no-connects */}
        {schem.noConnects.map((n) => (
          <g key={n.uuid} stroke="#888" strokeWidth={0.3} vectorEffect="non-scaling-stroke">
            <line x1={n.at.x - 0.9} y1={n.at.y - 0.9} x2={n.at.x + 0.9} y2={n.at.y + 0.9} />
            <line x1={n.at.x - 0.9} y1={n.at.y + 0.9} x2={n.at.x + 0.9} y2={n.at.y - 0.9} />
          </g>
        ))}

        {/* labels */}
        {schem.labels.map((l) => (
          <g key={l.uuid}>
            <circle cx={l.at.x} cy={l.at.y} r={0.5} fill="#10b981" />
            <text x={l.at.x + 1} y={l.at.y - 0.6} fontSize={1.6} fill="#10b981">{l.text}</text>
          </g>
        ))}

        {/* symbols */}
        {schem.symbols.map((inst) => {
          const def = defs[inst.libId];
          if (!def) return null;
          const drawInst = inst.uuid === dragUuid && dragPos ? { ...inst, at: dragPos } : inst;
          return <SymbolView key={inst.uuid} inst={drawInst} def={def} selected={inst.uuid === props.selection} />;
        })}

        {/* selection box */}
        {selInst && defs[selInst.libId] && (() => {
          const at = selInst.uuid === dragUuid && dragPos ? dragPos : selInst.at;
          const bb = instanceBBox(defs[selInst.libId], { at, rotation: selInst.rotation, mirror: selInst.mirror });
          return <rect x={bb.min.x - 1} y={bb.min.y - 1} width={bb.max.x - bb.min.x + 2} height={bb.max.y - bb.min.y + 2} fill="none" stroke="#7c3aed" strokeWidth={0.3} strokeDasharray="1 0.8" vectorEffect="non-scaling-stroke" />;
        })()}

        {/* wire preview */}
        {tool === "wire" && wireStart && (
          <line x1={wireStart.at.x} y1={wireStart.at.y} x2={cursor.x} y2={cursor.y} stroke={WIRE} strokeWidth={0.3} strokeDasharray="1 1" vectorEffect="non-scaling-stroke" />
        )}
      </g>
    </svg>
  );
}
