import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Schematic, LibSymbol } from "@loon/shared/schematic";
import type { Op } from "@loon/shared/ops";
import { buildSegmentGraph, type Segment, type SegmentKind } from "@loon/shared/segments";
import { moduleSummaries } from "@loon/shared/modules";
import type { Viewport } from "./Canvas";

interface Props {
  schem: Schematic;
  defs: Record<string, LibSymbol>;
  viewport: Viewport;
  setViewport: (v: Viewport) => void;
  selection: string | null;
  onSelect: (segmentId: string | null) => void;
  onOps: (ops: Op[]) => void;
  // Jump to these parts on the schematic.
  onDrillIn: (memberUuids: string[]) => void;
}

// #region geometry
// The block view has its own coordinate space. It is not the sheet seen from
// above - that was the old view, and it was the schematic with the symbols
// rubbed out. Columns are signal flow, rows are just stacking.
const BOX_W = 210;
const BOX_H = 96;
const COL_GAP = 120;
const ROW_GAP = 28;
const COL_PITCH = BOX_W + COL_GAP;
const ROW_PITCH = BOX_H + ROW_GAP;

const KIND_COLOR: Record<SegmentKind, string> = {
  input: "#e0a13a",
  protection: "#e06b6b",
  regulator: "#5ec27a",
  mcu: "#8b7bf0",
  driver: "#4ea1ff",
  sense: "#39b8b0",
  interface: "#c07bd8",
  indicator: "#d8c14a",
  other: "#8a8a8a",
};

const KIND_ORDER: SegmentKind[] = ["input", "protection", "regulator", "mcu", "driver", "sense", "interface", "indicator", "other"];

// Columns are centred against the tallest one, so a column of three does not
// hang off the top of a column of eleven.
function boxPlacer(segments: Segment[]) {
  const height = new Map<number, number>();
  for (const s of segments) height.set(s.col, Math.max(height.get(s.col) ?? 0, (s.row + 1) * ROW_PITCH));
  const tallest = Math.max(0, ...height.values());
  return (s: Segment) => ({
    x: s.col * COL_PITCH,
    y: s.row * ROW_PITCH + (tallest - (height.get(s.col) ?? 0)) / 2,
  });
}

// Two or three words fit on a line at this size; break the rest.
function wrap(text: string, perLine: number, lines: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > perLine) { out.push(cur); cur = w; } else cur = cur ? cur + " " + w : w;
    if (out.length === lines) break;
  }
  if (cur && out.length < lines) out.push(cur);
  const last = out.length - 1;
  if (out.length === lines && words.join(" ").length > out.join(" ").length) out[last] = out[last].slice(0, perLine - 1) + "…";
  return out;
}

// The block diagram: what the board is made of and how the parts of it talk,
// with the component count stripped out. Dragging a block is not a thing here -
// position is derived from signal flow, and the place to move a part is the
// schematic.
export function BlockCanvas(props: Props) {
  const { schem, defs, viewport, setViewport } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const panning = useRef<{ mx: number; my: number; vx: number; vy: number } | null>(null);
  const [adding, setAdding] = useState(false);
  const fittedFor = useRef("");

  const graph = useMemo(() => buildSegmentGraph(schem, (id) => defs[id] ?? schem.libSymbols[id]), [schem, defs]);
  const boxAt = useMemo(() => boxPlacer(graph.segments), [graph]);
  const modules = useMemo(() => moduleSummaries(), []);
  const byId = useMemo(() => new Map(graph.segments.map((s) => [s.id, s])), [graph]);
  const sel = props.selection ? byId.get(props.selection) ?? null : null;

  // Links touching the selected block, so its net names can be shown without
  // every other label on the page competing with them.
  const selLinks = useMemo(
    () => (sel ? graph.links.filter((l) => l.from === sel.id || l.to === sel.id) : []),
    [graph, sel],
  );
  const litIds = useMemo(() => {
    if (!sel) return null;
    const set = new Set<string>([sel.id]);
    for (const l of selLinks) { set.add(l.from); set.add(l.to); }
    return set;
  }, [sel, selLinks]);

  const bounds = useMemo(() => {
    let w = 0, h = 0;
    for (const s of graph.segments) {
      const b = boxAt(s);
      w = Math.max(w, b.x + BOX_W);
      h = Math.max(h, b.y + BOX_H);
    }
    return { w, h };
  }, [graph, boxAt]);

  // Frame the diagram when it first appears, and whenever the shape changes
  // enough that the old viewport is meaningless.
  useEffect(() => {
    const key = `${schem.uuid}:${graph.segments.length}:${graph.cols}`;
    if (fittedFor.current === key || !svgRef.current || bounds.w === 0) return;
    fittedFor.current = key;
    const r = svgRef.current.getBoundingClientRect();
    const scale = Math.max(0.1, Math.min(1.6, Math.min((r.width - 40) / bounds.w, (r.height - 40) / bounds.h)));
    setViewport({ scale, x: (r.width - bounds.w * scale) / 2, y: 20 });
  }, [schem.uuid, graph, bounds, setViewport]);

  function toWorld(e: { clientX: number; clientY: number }) {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - rect.left - viewport.x) / viewport.scale, y: (e.clientY - rect.top - viewport.y) / viewport.scale };
  }

  function onWheel(e: React.WheelEvent) {
    const w = toWorld(e);
    const scale = Math.min(4, Math.max(0.08, viewport.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    const rect = svgRef.current!.getBoundingClientRect();
    setViewport({ scale, x: e.clientX - rect.left - w.x * scale, y: e.clientY - rect.top - w.y * scale });
  }

  function hit(e: React.MouseEvent): Segment | null {
    const w = toWorld(e);
    return (
      graph.segments.find((s) => {
        const b = boxAt(s);
        return w.x >= b.x && w.x <= b.x + BOX_W && w.y >= b.y && w.y <= b.y + BOX_H;
      }) ?? null
    );
  }

  function onMouseDown(e: React.MouseEvent) {
    if (adding) return;
    const s = hit(e);
    props.onSelect(s ? s.id : null);
    if (!s) panning.current = { mx: e.clientX, my: e.clientY, vx: viewport.x, vy: viewport.y };
  }

  function onMouseMove(e: React.MouseEvent) {
    if (!panning.current) return;
    setViewport({ ...viewport, x: panning.current.vx + (e.clientX - panning.current.mx), y: panning.current.vy + (e.clientY - panning.current.my) });
  }

  function onMouseUp() { panning.current = null; }

  // A new block goes off the right edge of the sheet and the sheet is packed
  // afterwards, because the block view has no sheet coordinates to drop it at.
  function placeModule(moduleId: string) {
    const xs = schem.symbols.map((s) => s.at.x);
    const ys = schem.symbols.map((s) => s.at.y);
    const at = { x: (xs.length ? Math.max(...xs) : 0) + 60, y: ys.length ? Math.min(...ys) : 0 };
    props.onOps([{ op: "instantiate_module", moduleId, at }, { op: "compact_sheet" }]);
    setAdding(false);
  }

  return (
    <div className="blockwrap">
      <div className="blockbar">
        <button className={adding ? "primary" : ""} onClick={() => setAdding((a) => !a)}>
          {adding ? "Pick a block" : "Add block"}
        </button>
        <span className="status">
          {graph.segments.length} blocks · {graph.links.length} links
        </span>
        <span className="status desktop-only">{schem.symbols.length} parts</span>
        <span className="spacer" />
        <div className="kindkey">
          {KIND_ORDER.filter((k) => graph.segments.some((s) => s.kind === k)).map((k) => (
            <span key={k}><i style={{ background: KIND_COLOR[k] }} />{k}</span>
          ))}
        </div>
      </div>
      {adding && (
        <div className="modulepick">
          {modules.map((m) => (
            <div key={m.id} className="mod-row" onClick={() => placeModule(m.id)}>
              <div className="name">{m.name}</div>
              <div className="desc">{m.description.split(". ")[0]}.</div>
            </div>
          ))}
        </div>
      )}

      <svg ref={svgRef} className="blockcanvas" onWheel={onWheel} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>
        <g transform={`translate(${viewport.x},${viewport.y}) scale(${viewport.scale})`}>
          {/* links */}
          {graph.links.map((l, i) => {
            const a = byId.get(l.from), b = byId.get(l.to);
            if (!a || !b) return null;
            const ba = boxAt(a), bb = boxAt(b);
            // Leave from the right edge going forward, the left edge going back.
            const forward = b.col > a.col || (b.col === a.col && b.row > a.row);
            const p1 = { x: ba.x + (forward ? BOX_W : 0), y: ba.y + BOX_H / 2 };
            const p2 = { x: bb.x + (forward ? 0 : BOX_W), y: bb.y + BOX_H / 2 };
            const bow = Math.max(30, Math.abs(p2.x - p1.x) / 2);
            const d = `M ${p1.x} ${p1.y} C ${p1.x + (forward ? bow : -bow)} ${p1.y}, ${p2.x - (forward ? bow : -bow)} ${p2.y}, ${p2.x} ${p2.y}`;
            const lit = litIds ? litIds.has(l.from) && litIds.has(l.to) : false;
            return (
              <path
                key={`${l.from}-${l.to}-${i}`}
                d={d}
                fill="none"
                stroke={lit ? "#6fb2ff" : "#39404e"}
                strokeWidth={Math.min(3, 0.8 + l.nets.length * 0.35)}
                opacity={lit ? 0.9 : 0.45}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}

          {/* net names, only for the block you picked: all of them at once is the
              hairball the old view was */}
          {selLinks.map((l, i) => {
            const a = byId.get(l.from), b = byId.get(l.to);
            if (!a || !b) return null;
            const ba = boxAt(a), bb = boxAt(b);
            const mid = { x: (ba.x + bb.x) / 2 + BOX_W / 2, y: (ba.y + bb.y) / 2 + BOX_H / 2 };
            const text = l.nets.slice(0, 3).join(" ") + (l.nets.length > 3 ? ` +${l.nets.length - 3}` : "");
            return (
              <g key={`lbl-${i}`}>
                <rect x={mid.x - text.length * 2.5} y={mid.y - 9} width={text.length * 5} height={13} rx={3} fill="#12141a" opacity={0.92} />
                <text x={mid.x} y={mid.y} fontSize={9} fill="#9fd0ff" textAnchor="middle">{text}</text>
              </g>
            );
          })}

          {/* blocks */}
          {graph.segments.map((s) => {
            const b = boxAt(s);
            const on = sel?.id === s.id;
            const dim = litIds ? !litIds.has(s.id) : false;
            const color = KIND_COLOR[s.kind];
            const title = wrap(s.name, 24, 2);
            return (
              <g
                key={s.id}
                opacity={dim ? 0.35 : 1}
                style={{ cursor: "pointer" }}
                onDoubleClick={() => props.onDrillIn(s.memberUuids)}
              >
                <rect
                  x={b.x} y={b.y} width={BOX_W} height={BOX_H} rx={8}
                  fill={on ? "#1d2130" : "#161922"}
                  stroke={on ? color : "#2c3140"}
                  strokeWidth={on ? 2 : 1}
                  vectorEffect="non-scaling-stroke"
                />
                <rect x={b.x} y={b.y} width={BOX_W} height={4} rx={2} fill={color} />
                {title.map((line, i) => (
                  <text key={i} x={b.x + 12} y={b.y + 26 + i * 16} fontSize={13} fill="#e8e8e8" fontWeight={600}>{line}</text>
                ))}
                <text x={b.x + 12} y={b.y + BOX_H - 30} fontSize={10} fill={color}>
                  {s.kind} · {s.partCount} {s.partCount === 1 ? "part" : "parts"}
                </text>
                {s.rails.slice(0, 4).map((r, i) => (
                  <g key={r}>
                    <rect x={b.x + 12 + i * 46} y={b.y + BOX_H - 22} width={42} height={14} rx={3} fill="#22262f" />
                    <text x={b.x + 33 + i * 46} y={b.y + BOX_H - 12} fontSize={9} fill="#d8b24a" textAnchor="middle">{r.slice(0, 6)}</text>
                  </g>
                ))}
              </g>
            );
          })}
        </g>
      </svg>

      {sel && (
        <div className="blockdetail">
          <div className="layerhead">
            <span>{sel.name}</span>
            <button className="collapse" aria-label="Close" onClick={() => props.onSelect(null)}>×</button>
          </div>
          <div className="row"><span>Kind</span><b>{sel.kind}</b></div>
          <div className="row"><span>Parts</span><b>{sel.partCount}</b></div>
          <div className="row"><span>Rails</span><b>{sel.rails.join(" ") || "—"}</b></div>
          <div className="bd-head">Signals</div>
          <div className="bd-nets">{sel.ports.slice(0, 16).map((p) => <span key={p.net}>{p.net}</span>)}</div>
          <div className="bd-head">Parts</div>
          <div className="bd-nets refs">{sel.refs.slice(0, 40).map((r) => <span key={r}>{r}</span>)}</div>
          <button onClick={() => props.onDrillIn(sel.memberUuids)}>Open on the sheet</button>
        </div>
      )}
    </div>
  );
}
