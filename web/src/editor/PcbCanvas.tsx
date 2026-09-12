import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Schematic, Point } from "@loon/shared/schematic";
import type { Footprint, FpPad } from "@loon/shared/footprint";
import type { Board, PlacedFootprint, Track } from "@loon/shared/board";
import { ratsnest, padWorld, type DrcIssue } from "@loon/shared/pcbgen";
import { trpc } from "../trpc";

interface Props {
  project: string;
  schem: Schematic | null;
  flash: (text: string, err?: boolean) => void;
  // Which board of the project this view is showing ("" is the main board).
  unit?: string;
  // Bumped by the assistant when it regenerates the board.
  rev?: number;
}

// #region layers
// The stack, in the order a fab talks about it. Every drawn thing belongs to one
// of these, and each can be turned off on its own - the point of a layout view
// is being able to look at one layer at a time.
interface LayerDef {
  id: string;
  label: string;
  color: string;
}

const LAYERS: LayerDef[] = [
  { id: "F.Cu", label: "F.Cu (front copper)", color: "#c83232" },
  { id: "B.Cu", label: "B.Cu (back copper)", color: "#3f7fd6" },
  { id: "F.SilkS", label: "F.Silkscreen", color: "#e8e8e8" },
  { id: "B.SilkS", label: "B.Silkscreen", color: "#9a9a9a" },
  { id: "F.Mask", label: "F.Mask openings", color: "#a05ad0" },
  { id: "B.Mask", label: "B.Mask openings", color: "#6a3a90" },
  { id: "F.Paste", label: "F.Paste", color: "#9aa0a6" },
  { id: "F.CrtYd", label: "F.Courtyard", color: "#7a5cff" },
  { id: "F.Fab", label: "F.Fab", color: "#5d5d5d" },
  { id: "Edge.Cuts", label: "Edge.Cuts", color: "#e6c84a" },
  { id: "Drill", label: "Drill holes", color: "#f0f0f0" },
  { id: "Refs", label: "Reference names", color: "#b9b9b9" },
  { id: "Ratsnest", label: "Ratsnest", color: "#7fd6a0" },
];

const LAYER_COLOR: Record<string, string> = Object.fromEntries(LAYERS.map((l) => [l.id, l.color]));

// What is on by default: the two copper layers, the front silkscreen, the
// outline and the holes. Mask, paste, courtyard and fab are there when you want
// them and in the way when you do not.
const DEFAULT_ON = ["F.Cu", "B.Cu", "F.SilkS", "Edge.Cuts", "Drill", "Refs", "Ratsnest"];

function rot(p: Point, deg: number): Point {
  const r = (deg * Math.PI) / 180;
  return { x: p.x * Math.cos(r) - p.y * Math.sin(r), y: p.x * Math.sin(r) + p.y * Math.cos(r) };
}

// The layout view. Pads and silkscreen are KiCad's own land patterns; loon owns
// placement, tracks and the outline. The board file this writes is what gets
// uploaded, so what is drawn here is what gets fabricated.
export function PcbCanvas({ project, schem, flash, rev, unit }: Props) {
  const [board, setBoard] = useState<Board | null>(null);
  const [fps, setFps] = useState<Record<string, Footprint>>({});
  const [view, setView] = useState({ x: 60, y: 60, scale: 4 });
  const [sel, setSel] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ uuid: string; from: Point; at: Point } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [drc, setDrc] = useState<DrcIssue[]>([]);
  const [unrouted, setUnrouted] = useState(0);
  const [tool, setTool] = useState<"move" | "track">("move");
  const [layer, setLayer] = useState("F.Cu");
  const [trackStart, setTrackStart] = useState<{ at: Point; net: string } | null>(null);
  const [cursor, setCursor] = useState<Point>({ x: 0, y: 0 });
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(LAYERS.map((l) => [l.id, DEFAULT_ON.includes(l.id)])));
  const [flip, setFlip] = useState(false);
  const vis = (id: string) => on[id] === true;
  const solo = (id: string) => setOn(Object.fromEntries(LAYERS.map((l) => [l.id, l.id === id || l.id === "Edge.Cuts"])));
  const svgRef = useRef<SVGSVGElement>(null);
  const panning = useRef<{ mx: number; my: number; vx: number; vy: number } | null>(null);

  useEffect(() => {
    (async () => {
      const res = await trpc.pcb.load.query({ project, board: unit });
      if (res.board) {
        setBoard(res.board as Board);
        if (schem) setFps(await trpc.pcb.footprints.mutate({ schem }));
        return;
      }
      // No board yet: opening this view is the request for one.
      if (schem && schem.symbols.length > 0) await generate(false);
    })().catch((e) => flash(String(e?.message ?? e), true));
  }, [project, schem, rev, unit]);

  const rats = useMemo(() => (board ? ratsnest(board, fps) : []), [board, fps]);

  async function generate(keepPlacement: boolean) {
    if (!schem) return;
    setBusy("gen");
    try {
      const res = await trpc.pcb.generate.mutate({ project, schem, keepPlacement, board: unit });
      setBoard(res.board as Board);
      setFps(await trpc.pcb.footprints.mutate({ schem }));
      const notes: string[] = [`Placed ${res.placed} parts.`];
      if (res.missingFootprints.length) notes.push(`${res.missingFootprints.length} parts have no footprint set.`);
      if (res.approximate.length) notes.push(`${res.approximate.length} land patterns are generated, not KiCad's: check before ordering.`);
      flash(notes.join(" "), res.missingFootprints.length > 0);
    } catch (e: any) {
      flash(String(e?.message ?? e), true);
    }
    setBusy(null);
  }

  async function save() {
    if (!board || !schem) return;
    setBusy("save");
    try {
      const res = await trpc.pcb.save.mutate({ project, board, schem, unit });
      setDrc(res.drc as DrcIssue[]);
      setUnrouted(res.unrouted);
      flash("Board saved. board.kicad_pcb is what you upload to OSH Park.");
    } catch (e: any) {
      flash(String(e?.message ?? e), true);
    }
    setBusy(null);
  }

  function toWorld(e: { clientX: number; clientY: number }): Point {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.scale, y: (e.clientY - r.top - view.y) / view.scale };
  }

  function padAt(w: Point): { fp: PlacedFootprint; pad: FpPad; at: Point } | null {
    if (!board) return null;
    for (const f of board.footprints) {
      const fp = fps[f.libId];
      if (!fp) continue;
      for (const pad of fp.pads) {
        const at = padWorld(f, pad.at);
        if (Math.abs(at.x - w.x) <= pad.size.w / 2 && Math.abs(at.y - w.y) <= pad.size.h / 2) return { fp: f, pad, at };
      }
    }
    return null;
  }

  function onMouseDown(e: React.MouseEvent) {
    if (!board) return;
    const w = toWorld(e);
    if (tool === "track") {
      const hit = padAt(w);
      const at = hit ? hit.at : w;
      const net = hit ? hit.fp.padNets[hit.pad.number] ?? "" : trackStart?.net ?? "";
      if (!trackStart) setTrackStart({ at, net });
      else {
        const t: Track = {
          uuid: crypto.randomUUID(),
          layer,
          width: Math.max(board.rules.minTrackWidth, 0.25),
          start: trackStart.at,
          end: at,
          net: trackStart.net || net,
        };
        setBoard({ ...board, tracks: [...board.tracks, t] });
        setTrackStart(hit ? { at, net } : null);
      }
      return;
    }
    const hitFp = [...board.footprints].reverse().find((f) => {
      const fp = fps[f.libId];
      if (!fp) return false;
      const half = { w: (fp.bbox.max.x - fp.bbox.min.x) / 2, h: (fp.bbox.max.y - fp.bbox.min.y) / 2 };
      return Math.abs(w.x - f.at.x) <= half.w && Math.abs(w.y - f.at.y) <= half.h;
    });
    if (hitFp) {
      setSel(hitFp.uuid);
      setDrag({ uuid: hitFp.uuid, from: w, at: hitFp.at });
      return;
    }
    setSel(null);
    panning.current = { mx: e.clientX, my: e.clientY, vx: view.x, vy: view.y };
  }

  function onMouseMove(e: React.MouseEvent) {
    const w = toWorld(e);
    setCursor(w);
    if (drag && board) {
      const dx = w.x - drag.from.x;
      const dy = w.y - drag.from.y;
      setBoard({
        ...board,
        footprints: board.footprints.map((f) =>
          f.uuid === drag.uuid ? { ...f, at: { x: +(drag.at.x + dx).toFixed(3), y: +(drag.at.y + dy).toFixed(3) } } : f,
        ),
      });
      return;
    }
    if (panning.current) {
      setView({ ...view, x: panning.current.vx + (e.clientX - panning.current.mx), y: panning.current.vy + (e.clientY - panning.current.my) });
    }
  }

  function onMouseUp() {
    setDrag(null);
    panning.current = null;
  }

  function onWheel(e: React.WheelEvent) {
    const w = toWorld(e);
    const scale = Math.min(40, Math.max(1, view.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    const r = svgRef.current!.getBoundingClientRect();
    setView({ scale, x: e.clientX - r.left - w.x * scale, y: e.clientY - r.top - w.y * scale });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!board || !sel) return;
      if (e.key.toLowerCase() === "r") {
        setBoard({ ...board, footprints: board.footprints.map((f) => (f.uuid === sel ? { ...f, rotation: (f.rotation + 90) % 360 } : f)) });
      }
      if (e.key.toLowerCase() === "f") {
        setBoard({ ...board, footprints: board.footprints.map((f) => (f.uuid === sel ? { ...f, side: f.side === "F" ? "B" : "F" } : f)) });
      }
      if (e.key === "Escape") setTrackStart(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [board, sel]);

  if (!board) {
    return (
      <div className="pcbwrap">
        <div className="pcbbar">
          <button className="primary" onClick={() => generate(false)} disabled={busy === "gen" || !schem}>
            {busy === "gen" ? "Placing..." : "Generate board from schematic"}
          </button>
          <span className="status">No board yet. This places every part with a footprint and wraps an outline around it.</span>
        </div>
      </div>
    );
  }

  const errors = drc.filter((d) => d.severity === "error").length;

  const boardW = board.outline.length ? Math.max(...board.outline.map((p) => p.x)) : 0;

  return (
    <div className="pcbwrap">
      <div className="pcbbar">
        <div className="viewswitch">
          <button className={tool === "move" ? "on" : ""} onClick={() => { setTool("move"); setTrackStart(null); }}>Move</button>
          <button className={tool === "track" ? "on" : ""} onClick={() => setTool("track")}>Route</button>
        </div>
        <select value={layer} onChange={(e) => setLayer(e.target.value)}>
          <option value="F.Cu">F.Cu (top)</option>
          <option value="B.Cu">B.Cu (bottom)</option>
        </select>
        <button className={flip ? "on" : ""} onClick={() => setFlip((f) => !f)}>{flip ? "Viewing from back" : "Viewing from front"}</button>
        <button onClick={() => generate(true)} disabled={!!busy}>Re-sync from schematic</button>
        <button className="primary" onClick={save} disabled={!!busy}>Save board</button>
        <a className="linkbtn" href={`/artifact/${encodeURIComponent(project)}/${unit ? `boards/${unit}/` : ""}board.kicad_pcb`} download>
          Download .kicad_pcb
        </a>
        <span className="spacer" />
        <span className="status">
          {board.footprints.length} parts · {rats.length} unrouted · {board.tracks.length} tracks
          {errors ? ` · ${errors} DRC errors` : unrouted || drc.length ? " · DRC clean" : ""}
        </span>
        <span className="status">{board.rules.name}</span>
      </div>

      <svg ref={svgRef} className="pcbcanvas" onWheel={onWheel} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>
        <g transform={`translate(${view.x},${view.y}) scale(${view.scale}) ${flip ? `translate(${boardW},0) scale(-1,1)` : ""}`}>
          {/* board outline */}
          {board.outline.length > 2 && vis("Edge.Cuts") && (
            <polygon
              points={board.outline.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="rgba(40,60,40,0.35)"
              stroke={LAYER_COLOR["Edge.Cuts"]}
              strokeWidth={0.15}
              vectorEffect="non-scaling-stroke"
            />
          )}

          {/* copper pours, as KiCad filled them */}
          {(board.zones ?? []).map((z, zi) =>
            vis(z.layer)
              ? (z.filled?.length ? z.filled : [z.polygon]).map((ring, ri) => (
                  <polygon
                    key={`${zi}-${ri}`}
                    points={ring.map((p) => `${p.x},${p.y}`).join(" ")}
                    fill={LAYER_COLOR[z.layer] ?? "#888"}
                    fillOpacity={z.filled?.length ? 0.28 : 0.08}
                    stroke={LAYER_COLOR[z.layer] ?? "#888"}
                    strokeWidth={0.1}
                    strokeDasharray={z.filled?.length ? undefined : "0.6 0.4"}
                    vectorEffect="non-scaling-stroke"
                  />
                ))
              : null,
          )}

          {/* ratsnest */}
          {vis("Ratsnest") &&
            rats.map((r, i) => (
              <line key={i} x1={r.a.x} y1={r.a.y} x2={r.b.x} y2={r.b.y} stroke="#7fd6a0" strokeWidth={0.06} opacity={0.6} vectorEffect="non-scaling-stroke" />
            ))}

          {/* tracks */}
          {board.tracks.filter((t) => vis(t.layer)).map((t) => (
            <line key={t.uuid} x1={t.start.x} y1={t.start.y} x2={t.end.x} y2={t.end.y} stroke={LAYER_COLOR[t.layer] ?? "#888"} strokeWidth={t.width} strokeLinecap="round" opacity={0.9} />
          ))}
          {/* vias */}
          {(board.vias ?? []).map((v) => (
            <g key={v.uuid}>
              {vis("F.Cu") && <circle cx={v.at.x} cy={v.at.y} r={v.size / 2} fill={LAYER_COLOR["F.Cu"]} opacity={0.8} />}
              {vis("Drill") && <circle cx={v.at.x} cy={v.at.y} r={v.drill / 2} fill="#101216" />}
            </g>
          ))}

          {trackStart && (
            <line x1={trackStart.at.x} y1={trackStart.at.y} x2={cursor.x} y2={cursor.y} stroke={LAYER_COLOR[layer]} strokeWidth={0.2} strokeDasharray="0.5 0.4" />
          )}

          {/* board silkscreen */}
          {(board.texts ?? []).filter((t) => vis(t.layer)).map((t, i) => (
            <text
              key={i}
              x={t.at.x}
              y={t.at.y}
              fontSize={t.size}
              fill={LAYER_COLOR[t.layer] ?? "#d8d8d8"}
              transform={t.rotation ? `rotate(${t.rotation},${t.at.x},${t.at.y})` : undefined}
              style={{ fontWeight: t.bold ? 700 : 400 }}
            >
              {t.text}
            </text>
          ))}

          {/* footprints */}
          {board.footprints.map((f) => {
            const fp = fps[f.libId];
            if (!fp) return null;
            const selected = f.uuid === sel;
            return (
              <g key={f.uuid} transform={`translate(${f.at.x},${f.at.y}) rotate(${f.rotation}) ${f.side === "B" ? "scale(-1,1)" : ""}`}>
                {fp.graphics
                  .filter((g) => vis(f.side === "B" ? g.layer.replace(/^F\./, "B.") : g.layer))
                  .map((g, i) => {
                    const color = LAYER_COLOR[f.side === "B" ? g.layer.replace(/^F\./, "B.") : g.layer] ?? "#4a4a4a";
                    if (g.type === "line") return <line key={i} x1={g.a.x} y1={g.a.y} x2={g.b.x} y2={g.b.y} stroke={color} strokeWidth={g.width} opacity={0.8} />;
                    if (g.type === "rect")
                      return (
                        <rect key={i} x={Math.min(g.a.x, g.b.x)} y={Math.min(g.a.y, g.b.y)} width={Math.abs(g.b.x - g.a.x)} height={Math.abs(g.b.y - g.a.y)} fill="none" stroke={color} strokeWidth={g.width} opacity={0.8} />
                      );
                    if (g.type === "circle")
                      return <circle key={i} cx={g.center.x} cy={g.center.y} r={Math.hypot(g.end.x - g.center.x, g.end.y - g.center.y)} fill="none" stroke={color} strokeWidth={g.width} opacity={0.8} />;
                    return null;
                  })}
                {fp.pads.map((pad, i) => {
                  const p = rot(pad.at, 0);
                  const thru = pad.type !== "smd";
                  // A through hole pad is copper on both sides; a surface mount
                  // pad only exists on the side the part is fitted to.
                  const padLayers = thru ? ["F.Cu", "B.Cu"] : [f.side === "F" ? "F.Cu" : "B.Cu"];
                  const shown = padLayers.filter((l) => vis(l));
                  const maskLayer = f.side === "F" ? "F.Mask" : "B.Mask";
                  const shape = (color: string, grow: number, opacity: number, key: string) =>
                    pad.shape === "circle" ? (
                      <circle key={key} r={pad.size.w / 2 + grow} fill={color} opacity={opacity} />
                    ) : (
                      <rect
                        key={key}
                        x={-pad.size.w / 2 - grow}
                        y={-pad.size.h / 2 - grow}
                        width={pad.size.w + grow * 2}
                        height={pad.size.h + grow * 2}
                        rx={pad.shape === "roundrect" || pad.shape === "oval" ? Math.min(pad.size.w, pad.size.h) * (pad.shape === "oval" ? 0.5 : 0.25) : 0}
                        fill={color}
                        opacity={opacity}
                      />
                    );
                  return (
                    <g key={i} transform={`translate(${p.x},${p.y}) rotate(${pad.rotation})`}>
                      {vis(maskLayer) && shape(LAYER_COLOR[maskLayer], 0.05, 0.35, "mask")}
                      {shown.map((l) => shape(thru ? "#c8a032" : LAYER_COLOR[l], 0, 0.92, l))}
                      {pad.drill && vis("Drill") ? <circle r={pad.drill / 2} fill="#101216" stroke="#f0f0f0" strokeWidth={0.05} /> : null}
                    </g>
                  );
                })}
                {vis("Refs") && (
                  <text x={0} y={-((fp.bbox.max.y - fp.bbox.min.y) / 2 + 0.4)} fontSize={0.9} fill={selected ? "#fff" : LAYER_COLOR["Refs"]} textAnchor="middle">
                    {f.ref}
                  </text>
                )}
                {selected && (
                  <rect
                    x={fp.bbox.min.x - 0.2}
                    y={fp.bbox.min.y - 0.2}
                    width={fp.bbox.max.x - fp.bbox.min.x + 0.4}
                    height={fp.bbox.max.y - fp.bbox.min.y + 0.4}
                    fill="none"
                    stroke="#a78bfa"
                    strokeWidth={0.12}
                    strokeDasharray="0.4 0.3"
                  />
                )}
              </g>
            );
          })}
        </g>
      </svg>

      <div className="layerpanel">
        <div className="layerhead">Layers</div>
        {LAYERS.map((l) => (
          <div key={l.id} className={"layerrow" + (vis(l.id) ? " on" : "")}>
            <label>
              <input type="checkbox" checked={vis(l.id)} onChange={(e) => setOn((o) => ({ ...o, [l.id]: e.target.checked }))} />
              <span className="swatch" style={{ background: l.color }} />
              {l.label}
            </label>
            <button className="soloBtn" title="Show only this layer" onClick={() => solo(l.id)}>
              only
            </button>
          </div>
        ))}
        <div className="layerrow">
          <button onClick={() => setOn(Object.fromEntries(LAYERS.map((l) => [l.id, true])))}>All</button>
          <button onClick={() => setOn(Object.fromEntries(LAYERS.map((l) => [l.id, DEFAULT_ON.includes(l.id)])))}>Reset</button>
        </div>
      </div>

      {drc.length > 0 && (
        <div className="drclist">
          {drc.slice(0, 8).map((d, i) => (
            <div key={i} className={"issue " + d.severity}>
              <div className="rule">{d.rule}</div>
              <div className="msg">{d.message}</div>
            </div>
          ))}
        </div>
      )}
      <div className="pcbhint">Drag to place. R rotates, F flips to the back. Route: click pad to pad. OSH Park takes board.kicad_pcb directly, so the download is the order.</div>
    </div>
  );
}
