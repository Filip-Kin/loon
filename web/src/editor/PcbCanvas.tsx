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
}

const LAYER_COLOR: Record<string, string> = {
  "F.Cu": "#c83232",
  "B.Cu": "#3f7fd6",
  "F.SilkS": "#e8e8e8",
  "B.SilkS": "#9a9a9a",
  "Edge.Cuts": "#e6c84a",
  "F.CrtYd": "#7a5cff",
  "F.Fab": "#5d5d5d",
};

function rot(p: Point, deg: number): Point {
  const r = (deg * Math.PI) / 180;
  return { x: p.x * Math.cos(r) - p.y * Math.sin(r), y: p.x * Math.sin(r) + p.y * Math.cos(r) };
}

// The layout view. Pads and silkscreen are KiCad's own land patterns; loon owns
// placement, tracks and the outline. The board file this writes is what gets
// uploaded, so what is drawn here is what gets fabricated.
export function PcbCanvas({ project, schem, flash }: Props) {
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
  const [showRats, setShowRats] = useState(true);
  const svgRef = useRef<SVGSVGElement>(null);
  const panning = useRef<{ mx: number; my: number; vx: number; vy: number } | null>(null);

  useEffect(() => {
    (async () => {
      const res = await trpc.pcb.load.query({ project });
      if (res.board) setBoard(res.board as Board);
      if (schem) setFps(await trpc.pcb.footprints.query({ schem }));
    })().catch((e) => flash(String(e?.message ?? e), true));
  }, [project]);

  const rats = useMemo(() => (board ? ratsnest(board, fps) : []), [board, fps]);

  async function generate(keepPlacement: boolean) {
    if (!schem) return;
    setBusy("gen");
    try {
      const res = await trpc.pcb.generate.mutate({ project, schem, keepPlacement });
      setBoard(res.board as Board);
      setFps(await trpc.pcb.footprints.query({ schem }));
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
      const res = await trpc.pcb.save.mutate({ project, board, schem });
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
        <button onClick={() => setShowRats((s) => !s)}>{showRats ? "Hide" : "Show"} ratsnest</button>
        <button onClick={() => generate(true)} disabled={!!busy}>Re-sync from schematic</button>
        <button className="primary" onClick={save} disabled={!!busy}>Save board</button>
        <a className="linkbtn" href={`/artifact/${encodeURIComponent(project)}/board.kicad_pcb`} download>
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
        <g transform={`translate(${view.x},${view.y}) scale(${view.scale})`}>
          {/* board outline */}
          {board.outline.length > 2 && (
            <polygon
              points={board.outline.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="rgba(40,60,40,0.35)"
              stroke={LAYER_COLOR["Edge.Cuts"]}
              strokeWidth={0.15}
              vectorEffect="non-scaling-stroke"
            />
          )}

          {/* ratsnest */}
          {showRats &&
            rats.map((r, i) => (
              <line key={i} x1={r.a.x} y1={r.a.y} x2={r.b.x} y2={r.b.y} stroke="#7fd6a0" strokeWidth={0.06} opacity={0.6} vectorEffect="non-scaling-stroke" />
            ))}

          {/* tracks */}
          {board.tracks.map((t) => (
            <line key={t.uuid} x1={t.start.x} y1={t.start.y} x2={t.end.x} y2={t.end.y} stroke={LAYER_COLOR[t.layer] ?? "#888"} strokeWidth={t.width} strokeLinecap="round" opacity={0.9} />
          ))}
          {trackStart && (
            <line x1={trackStart.at.x} y1={trackStart.at.y} x2={cursor.x} y2={cursor.y} stroke={LAYER_COLOR[layer]} strokeWidth={0.2} strokeDasharray="0.5 0.4" />
          )}

          {/* footprints */}
          {board.footprints.map((f) => {
            const fp = fps[f.libId];
            if (!fp) return null;
            const selected = f.uuid === sel;
            return (
              <g key={f.uuid} transform={`translate(${f.at.x},${f.at.y}) rotate(${f.rotation}) ${f.side === "B" ? "scale(-1,1)" : ""}`}>
                {fp.graphics
                  .filter((g) => g.layer.endsWith("SilkS") || g.layer.endsWith("Fab"))
                  .map((g, i) => {
                    const color = g.layer.endsWith("SilkS") ? "#d8d8d8" : "#4a4a4a";
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
                  const isThru = pad.type !== "smd";
                  const color = isThru ? "#c8a032" : f.side === "F" ? LAYER_COLOR["F.Cu"] : LAYER_COLOR["B.Cu"];
                  return (
                    <g key={i} transform={`translate(${p.x},${p.y}) rotate(${pad.rotation})`}>
                      {pad.shape === "circle" ? (
                        <circle r={pad.size.w / 2} fill={color} opacity={0.92} />
                      ) : (
                        <rect
                          x={-pad.size.w / 2}
                          y={-pad.size.h / 2}
                          width={pad.size.w}
                          height={pad.size.h}
                          rx={pad.shape === "roundrect" || pad.shape === "oval" ? Math.min(pad.size.w, pad.size.h) * (pad.shape === "oval" ? 0.5 : 0.25) : 0}
                          fill={color}
                          opacity={0.92}
                        />
                      )}
                      {pad.drill ? <circle r={pad.drill / 2} fill="#101216" /> : null}
                    </g>
                  );
                })}
                <text x={0} y={-((fp.bbox.max.y - fp.bbox.min.y) / 2 + 0.4)} fontSize={0.9} fill={selected ? "#fff" : "#b9b9b9"} textAnchor="middle">
                  {f.ref}
                </text>
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
