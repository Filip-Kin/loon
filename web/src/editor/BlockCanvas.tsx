import React, { useMemo, useRef, useState } from "react";
import type { Schematic, Point, LibSymbol } from "@loon/shared/schematic";
import type { Op } from "@loon/shared/ops";
import { buildBlockGraph, type GraphBlock } from "@loon/shared/blockgraph";
import { moduleSummaries } from "@loon/shared/modules";
import type { Viewport } from "./Canvas";

interface Props {
  schem: Schematic;
  defs: Record<string, LibSymbol>;
  viewport: Viewport;
  setViewport: (v: Viewport) => void;
  selection: string | null;
  onSelect: (blockId: string | null) => void;
  onOps: (ops: Op[]) => void;
  onDrillIn: (block: GraphBlock) => void;
}

const PAD = 6; // mm of breathing room around a block's parts

// The block view is the schematic seen from above: a block sits where its parts
// sit, so moving it here moves them there. Ports are the nets that leave.
export function BlockCanvas(props: Props) {
  const { schem, defs, viewport, setViewport } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragDelta, setDragDelta] = useState<Point>({ x: 0, y: 0 });
  const dragStart = useRef<Point>({ x: 0, y: 0 });
  const panning = useRef<{ mx: number; my: number; vx: number; vy: number } | null>(null);
  const [adding, setAdding] = useState(false);

  const graph = useMemo(() => buildBlockGraph(schem, (id) => defs[id] ?? schem.libSymbols[id]), [schem, defs]);
  const modules = useMemo(() => moduleSummaries(), []);

  function toWorld(e: { clientX: number; clientY: number }): Point {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - viewport.x) / viewport.scale,
      y: (e.clientY - rect.top - viewport.y) / viewport.scale,
    };
  }

  function onWheel(e: React.WheelEvent) {
    const w = toWorld(e);
    const scale = Math.min(8, Math.max(0.4, viewport.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    const rect = svgRef.current!.getBoundingClientRect();
    setViewport({ scale, x: e.clientX - rect.left - w.x * scale, y: e.clientY - rect.top - w.y * scale });
  }

  function onMouseDown(e: React.MouseEvent) {
    const w = toWorld(e);
    if (adding) return;
    const hit = graph.blocks.find(
      (b) => w.x >= b.box.min.x - PAD && w.x <= b.box.max.x + PAD && w.y >= b.box.min.y - PAD && w.y <= b.box.max.y + PAD,
    );
    if (hit && e.button === 0) {
      props.onSelect(hit.id);
      setDragId(hit.id);
      dragStart.current = w;
      setDragDelta({ x: 0, y: 0 });
      return;
    }
    if (!hit) props.onSelect(null);
    panning.current = { mx: e.clientX, my: e.clientY, vx: viewport.x, vy: viewport.y };
  }

  function onMouseMove(e: React.MouseEvent) {
    if (dragId) {
      const w = toWorld(e);
      setDragDelta({ x: w.x - dragStart.current.x, y: w.y - dragStart.current.y });
      return;
    }
    if (panning.current) {
      setViewport({
        ...viewport,
        x: panning.current.vx + (e.clientX - panning.current.mx),
        y: panning.current.vy + (e.clientY - panning.current.my),
      });
    }
  }

  function onMouseUp() {
    if (dragId) {
      if (Math.abs(dragDelta.x) > 1 || Math.abs(dragDelta.y) > 1) {
        props.onOps([{ op: "move_block", blockId: dragId, by: { dx: dragDelta.x, dy: dragDelta.y } }]);
      }
      setDragId(null);
      setDragDelta({ x: 0, y: 0 });
    }
    panning.current = null;
  }

  function placeModule(moduleId: string, e: React.MouseEvent) {
    const at = toWorld(e);
    props.onOps([{ op: "instantiate_module", moduleId, at: { x: Math.round(at.x), y: Math.round(at.y) } }]);
    setAdding(false);
  }

  const offset = (b: GraphBlock) => (dragId === b.id ? dragDelta : { x: 0, y: 0 });
  const center = (b: GraphBlock) => {
    const o = offset(b);
    return { x: (b.box.min.x + b.box.max.x) / 2 + o.x, y: (b.box.min.y + b.box.max.y) / 2 + o.y };
  };

  return (
    <div className="blockwrap">
      <div className="blockbar">
        <button className={adding ? "primary" : ""} onClick={() => setAdding((a) => !a)}>
          {adding ? "Click the canvas to drop a block" : "Add block"}
        </button>
        <span className="status">{graph.blocks.length} blocks, {graph.links.length} links{graph.looseRefs.length ? `, ${graph.looseRefs.length} loose parts` : ""}</span>
      </div>
      {adding && (
        <div className="modulepick">
          {modules.map((m) => (
            <div key={m.id} className="mod-row" onMouseDown={(e) => { e.stopPropagation(); (e.currentTarget as any).dataset.pick = m.id; }} onClick={(e) => placeModule(m.id, e)}>
              <div className="name">{m.name}</div>
              <div className="desc">{m.description.split(". ")[0]}.</div>
            </div>
          ))}
        </div>
      )}
      <svg ref={svgRef} className="blockcanvas" onWheel={onWheel} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>
        <g transform={`translate(${viewport.x},${viewport.y}) scale(${viewport.scale})`}>
          {/* links first, so blocks sit on top */}
          {graph.links.map((l, i) => {
            const a = graph.blocks.find((b) => b.id === l.from);
            const b = graph.blocks.find((x) => x.id === l.to);
            if (!a || !b) return null;
            const pa = center(a);
            const pb = center(b);
            const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
            return (
              <g key={`${l.net}-${i}`}>
                <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke="#4ea1ff" strokeWidth={0.6} opacity={0.55} vectorEffect="non-scaling-stroke" />
                <text x={mid.x} y={mid.y - 1} fontSize={3} fill="#4ea1ff" textAnchor="middle">{l.net}</text>
              </g>
            );
          })}

          {graph.blocks.map((b) => {
            const o = offset(b);
            const x = b.box.min.x - PAD + o.x;
            const y = b.box.min.y - PAD + o.y;
            const w = b.box.max.x - b.box.min.x + PAD * 2;
            const h = b.box.max.y - b.box.min.y + PAD * 2;
            const sel = props.selection === b.id;
            const signals = b.ports.filter((p) => !p.isPower);
            const rails = b.ports.filter((p) => p.isPower);
            return (
              <g key={b.id} onDoubleClick={() => props.onDrillIn(b)} style={{ cursor: "grab" }}>
                <rect x={x} y={y} width={w} height={h} rx={3}
                  fill={sel ? "rgba(124,58,237,0.16)" : "rgba(124,58,237,0.07)"}
                  stroke={sel ? "#a78bfa" : "rgba(124,58,237,0.6)"} strokeWidth={sel ? 1 : 0.5} vectorEffect="non-scaling-stroke" />
                <text x={x + 2} y={y + 6} fontSize={4.5} fill="#cbb6ff" fontWeight={600}>{b.moduleId}</text>
                <text x={x + 2} y={y + 11} fontSize={3} fill="#9a9a9a">
                  {b.partCount} parts{Object.keys(b.params).length ? " · " + Object.entries(b.params).map(([k, v]) => `${k}=${v}`).join(" ") : ""}
                </text>
                {rails.length > 0 && (
                  <text x={x + 2} y={y + h - 2} fontSize={3} fill="#d8b24a">{rails.map((r) => r.net).join("  ")}</text>
                )}
                {signals.slice(0, 12).map((p, i) => (
                  <g key={p.net}>
                    <circle cx={x + w} cy={y + 16 + i * 4.2} r={0.9} fill="#10b981" />
                    <text x={x + w + 2} y={y + 17 + i * 4.2} fontSize={3.2} fill="#10b981">{p.net}</text>
                  </g>
                ))}
                {signals.length > 12 && (
                  <text x={x + w + 2} y={y + 17 + 12 * 4.2} fontSize={3} fill="#666">+{signals.length - 12} more</text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
