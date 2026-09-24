import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Schematic, Point } from "@loon/shared/schematic";
import type { Footprint, FpPad } from "@loon/shared/footprint";
import type { Board, BoardText, PlacedFootprint, Track, Via } from "@loon/shared/board";
import { ratsnest, padWorld, type DrcIssue } from "@loon/shared/pcbgen";
import { trpc } from "../trpc";
import type { RouteProgress } from "../../../server/src/services/route-render";

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
  { id: "F.Cu", label: "F.Cu", color: "#c83232" },
  { id: "B.Cu", label: "B.Cu", color: "#3f7fd6" },
  { id: "F.SilkS", label: "F.SilkS", color: "#e8e8e8" },
  { id: "B.SilkS", label: "B.SilkS", color: "#9a9a9a" },
  { id: "F.Mask", label: "F.Mask", color: "#a05ad0" },
  { id: "B.Mask", label: "B.Mask", color: "#6a3a90" },
  { id: "F.Paste", label: "F.Paste", color: "#9aa0a6" },
  { id: "F.CrtYd", label: "F.CrtYd", color: "#7a5cff" },
  { id: "F.Fab", label: "F.Fab", color: "#5d5d5d" },
  { id: "Edge.Cuts", label: "Edge.Cuts", color: "#e6c84a" },
  { id: "Drill", label: "Drill", color: "#f0f0f0" },
  { id: "Refs", label: "References", color: "#b9b9b9" },
  { id: "Ratsnest", label: "Ratsnest", color: "#7fd6a0" },
];

const LAYER_COLOR: Record<string, string> = Object.fromEntries(LAYERS.map((l) => [l.id, l.color]));

// What is on by default: the two copper layers, the front silkscreen, the
// outline and the holes. Mask, paste, courtyard and fab are there when you want
// them and in the way when you do not.
const DEFAULT_ON = ["F.Cu", "B.Cu", "F.SilkS", "Edge.Cuts", "Drill", "Refs", "Ratsnest"];

const COPPER = ["F.Cu", "B.Cu"];
const SILK = ["F.SilkS", "B.SilkS"];

// Track widths offered while routing, matching the net classes loon writes
// into the project before an autoroute.
const WIDTHS = [0.25, 0.4, 0.6, 1.2, 1.5];

type Tool = "move" | "track" | "text";
type Sel = { kind: "fp" | "track" | "via" | "text"; id: string } | null;

function rot(p: Point, deg: number): Point {
  const r = (deg * Math.PI) / 180;
  return { x: p.x * Math.cos(r) - p.y * Math.sin(r), y: p.x * Math.sin(r) + p.y * Math.cos(r) };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

// KiCad routes on 45s, and a board full of arbitrary angles is one no
// reviewer can read. The cursor is projected onto the nearest eighth turn.
function to45(a: Point, b: Point): Point {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (dx === 0 && dy === 0) return { ...b };
  const step = Math.PI / 4;
  const k = Math.round(Math.atan2(dy, dx) / step) * step;
  const len = dx * Math.cos(k) + dy * Math.sin(k);
  if (len <= 0) return { ...a };
  return { x: r3(a.x + Math.cos(k) * len), y: r3(a.y + Math.sin(k) * len) };
}

// Distance from a point to a segment, for picking a track out of the canvas.
function distToSeg(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// The layout view. Pads and silkscreen are KiCad's own land patterns; loon owns
// placement, tracks and the outline. The board file this writes is what gets
// uploaded, so what is drawn here is what gets fabricated.
export function PcbCanvas({ project, schem, flash, rev, unit }: Props) {
  const [board, setBoard] = useState<Board | null>(null);
  const [fps, setFps] = useState<Record<string, Footprint>>({});
  const [view, setView] = useState({ x: 60, y: 60, scale: 4 });
  const [sel, setSel] = useState<Sel>(null);
  const [drag, setDrag] = useState<{ sel: Sel; from: Point; at: Point } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [drc, setDrc] = useState<DrcIssue[]>([]);
  const [unrouted, setUnrouted] = useState(0);
  const [routeNote, setRouteNote] = useState<string>("");
  const [progress, setProgress] = useState<RouteProgress | null>(null);
  const [tool, setTool] = useState<Tool>("move");
  const [layer, setLayer] = useState("F.Cu");
  const [silkLayer, setSilkLayer] = useState("F.SilkS");
  const [width, setWidth] = useState(0.25);
  const [run, setRun] = useState<{ pts: Point[]; net: string } | null>(null);
  const [cursor, setCursor] = useState<Point>({ x: 0, y: 0 });
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(LAYERS.map((l) => [l.id, DEFAULT_ON.includes(l.id)])));
  const [flip, setFlip] = useState(false);
  // #region renders
  // Renders are a separate pane, entered by asking for one. The layout view is
  // for laying out; a strip of raytraced pictures over it was in the way and
  // reloaded itself on every repaint.
  const [pane, setPane] = useState<"layout" | "renders">("layout");
  const [renders, setRenders] = useState<string[]>([]);
  // Cache buster, bumped once per render run - never per repaint, which is what
  // made the images flash.
  const [stamp, setStamp] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);

  const vis = (id: string) => on[id] === true;
  const solo = (id: string) => setOn(Object.fromEntries(LAYERS.map((l) => [l.id, l.id === id || l.id === "Edge.Cuts"])));
  const svgRef = useRef<SVGSVGElement>(null);
  const panning = useRef<{ mx: number; my: number; vx: number; vy: number } | null>(null);
  const fittedFor = useRef("");

  // Frame the whole board. A layout that opens off-screen reads as an empty
  // canvas, and the canvas changes width when a sidebar folds away.
  const fit = useCallback((b: Board | null) => {
    const el = svgRef.current;
    if (!b || !el) return;
    const pts = b.outline.length ? b.outline : b.footprints.map((f) => f.at);
    if (pts.length < 2) return;
    const min = { x: Math.min(...pts.map((p) => p.x)), y: Math.min(...pts.map((p) => p.y)) };
    const max = { x: Math.max(...pts.map((p) => p.x)), y: Math.max(...pts.map((p) => p.y)) };
    const r = el.getBoundingClientRect();
    const pad = 24;
    const scale = Math.max(0.5, Math.min(60, Math.min((r.width - pad) / (max.x - min.x || 1), (r.height - pad) / (max.y - min.y || 1))));
    setView({ scale, x: r.width / 2 - ((min.x + max.x) / 2) * scale, y: r.height / 2 - ((min.y + max.y) / 2) * scale });
  }, []);

  // A board written before silkscreen was editable has texts with no id, and
  // an id is what selecting and dragging one is keyed on.
  function withTextIds(b: Board): Board {
    return { ...b, texts: (b.texts ?? []).map((t) => (t.uuid ? t : { ...t, uuid: crypto.randomUUID() })) };
  }

  useEffect(() => {
    (async () => {
      const res = await trpc.pcb.load.query({ project, board: unit });
      if (res.board) {
        setBoard(withTextIds(res.board as Board));
        if (schem) setFps(await trpc.pcb.footprints.mutate({ schem, libIds: (res.board as Board).footprints.map((f) => f.libId) }));
        return;
      }
      // No board yet: opening this view is the request for one.
      if (schem && schem.symbols.length > 0) await generate(false);
    })().catch((e) => flash(String(e?.message ?? e), true));
  }, [project, schem, rev, unit]);

  const rats = useMemo(() => (board ? ratsnest(board, fps) : []), [board, fps]);

  useEffect(() => {
    const key = `${project}/${unit}`;
    if (!board || pane !== "layout" || fittedFor.current === key) return;
    fittedFor.current = key;
    fit(board);
  }, [board, pane, project, unit, fit]);

  // #region disk watch
  // KiCad has the same file open. Poll its mtime, and either pull it in or,
  // when there are unsaved edits here, offer the choice rather than making it.
  const diskBase = useRef({ pcb: 0, loon: 0 });
  const [diskAhead, setDiskAhead] = useState(false);
  const [dirty, setDirty] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rebase = useCallback(async () => {
    try { diskBase.current = await trpc.pcb.diskState.query({ project, board: unit }); } catch { /* offline */ }
    setDiskAhead(false);
  }, [project, unit]);

  useEffect(() => { rebase(); }, [rebase, rev]);

  const pull = useCallback(async () => {
    try {
      const res = await trpc.pcb.syncFromDisk.mutate({ project, board: unit });
      setBoard(withTextIds(res.board as Board));
      if (schem) setFps(await trpc.pcb.footprints.mutate({ schem, libIds: (res.board as Board).footprints.map((f) => f.libId) }));
      setDirty(false);
      const n = res.note;
      setRouteNote(`From disk: ${n.tracks} tracks, ${n.vias} vias, ${n.moved} moved, ${n.texts} texts`);
      await rebase();
    } catch (e: any) {
      flash(String(e?.message ?? e), true);
    }
  }, [project, unit, rebase, schem]);

  useEffect(() => {
    if (!board) return;
    let stop = false;
    const id = setInterval(async () => {
      if (stop || busy || drag) return;
      try {
        const d = await trpc.pcb.diskState.query({ project, board: unit });
        // A whole millisecond of slack: same-second writes are ours.
        if (d.pcb <= diskBase.current.pcb) return;
        if (dirty) setDiskAhead(true);
        else await pull();
      } catch { /* offline */ }
    }, 2500);
    return () => { stop = true; clearInterval(id); };
  }, [board, project, unit, busy, drag, dirty, pull]);

  // #region board edits
  // Every edit funnels through here, so nothing the user draws is lost to a
  // forgotten Save.
  const latest = useRef<Board | null>(null);
  latest.current = board;
  function edit(next: Board) {
    setBoard(next);
    setDirty(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { save(true); }, 1200);
  }
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  // A closed tab must not take the last second of routing with it. The pending
  // save goes out with keepalive, which the browser finishes as the page goes.
  useEffect(() => {
    function flush() {
      if (!dirty || !latest.current || !schem) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const body = JSON.stringify({ 0: { project, board: latest.current, schem, unit } });
      fetch("/trpc/pcb.save?batch=1", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
    }
    function onHide() { if (document.visibilityState === "hidden") flush(); }
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [dirty, project, unit, schem]);

  async function generate(keepPlacement: boolean) {
    if (!schem) return;
    setBusy("gen");
    try {
      const res = await trpc.pcb.generate.mutate({ project, schem, keepPlacement, board: unit });
      setBoard(withTextIds(res.board as Board));
      setDirty(false);
      setFps(await trpc.pcb.footprints.mutate({ schem }));
      const notes: string[] = [`Placed ${res.placed} parts.`];
      if (res.missingFootprints.length) notes.push(`${res.missingFootprints.length} parts have no footprint.`);
      if (res.approximate.length) notes.push(`${res.approximate.length} land patterns are generated, not KiCad's.`);
      flash(notes.join(" "), res.missingFootprints.length > 0);
      await rebase();
    } catch (e: any) {
      flash(String(e?.message ?? e), true);
    }
    setBusy(null);
  }

  async function save(auto = false) {
    const cur = latest.current;
    if (!cur || !schem) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (!auto) setBusy("save");
    try {
      const res = await trpc.pcb.save.mutate({ project, board: cur, schem, unit });
      setDrc(res.drc as DrcIssue[]);
      setUnrouted(res.unrouted);
      setDirty(false);
      await rebase();
      if (!auto) flash("Saved");
    } catch (e: any) {
      flash(String(e?.message ?? e), true);
    }
    if (!auto) setBusy(null);
  }

  // While a route runs, poll the server's progress file. A run started from
  // the CLI shows up here too, since it writes the same file.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const p = await trpc.pcb.routeProgress.query({ project, board: unit });
        if (!stop) setProgress(p);
      } catch {}
    };
    tick();
    const id = setInterval(tick, busy === "route" || progress?.running ? 3000 : 30000);
    return () => { stop = true; clearInterval(id); };
  }, [project, unit, busy, progress?.running]);

  // Freerouting through KiCad, in containers on the server. Minutes, not seconds.
  async function autoroute() {
    if (!board) return;
    setBusy("route");
    setRouteNote("Routing…");
    try {
      await save();
      const res = await trpc.pcb.autoroute.mutate({ project, board: unit, passes: 30 });
      setBoard(withTextIds(res.board as Board));
      setDirty(false);
      const r = res.report;
      setRouteNote(`${r.tracks} tracks, ${r.vias} vias, ${r.open} open, DRC ${r.drcViolations} violations / ${r.drcUnconnected} unconnected, ${r.seconds.toFixed(0)} s${r.notes.length ? " · " + r.notes.join(" · ") : ""}`);
      await rebase();
    } catch (e) {
      setRouteNote(`Routing failed: ${String(e).slice(0, 160)}`);
    } finally {
      setBusy(null);
    }
  }

  async function render() {
    setBusy("render");
    setPane("renders");
    setRouteNote("Rendering…");
    try {
      await save();
      const res = await trpc.pcb.render.mutate({ project, board: unit });
      setRenders(res.images);
      setStamp(Date.now());
      setRouteNote(res.missingModels.length ? `Rendered. ${res.missingModels.length} parts have no 3D model.` : "Rendered");
      await rebase();
    } catch (e) {
      setRouteNote(`Render failed: ${String(e).slice(0, 160)}`);
    } finally {
      setBusy(null);
    }
  }

  // Opening the renders pane shows whatever KiCad left there last time, with
  // one cache buster for the whole visit.
  async function openRenders() {
    setPane("renders");
    try {
      const list = await trpc.pcb.renders.query({ project, board: unit });
      setRenders(list);
      setStamp(Date.now());
    } catch { /* none yet */ }
  }

  function toWorld(e: { clientX: number; clientY: number }): Point {
    const r = svgRef.current!.getBoundingClientRect();
    const x = (e.clientX - r.left - view.x) / view.scale;
    const y = (e.clientY - r.top - view.y) / view.scale;
    // Viewing from the back mirrors the canvas, so un-mirror the pointer.
    return flip ? { x: boardW - x, y } : { x, y };
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

  // What the pointer is over, nearest first: text, via, track, part.
  function pick(w: Point): Sel {
    if (!board) return null;
    const grab = 1.2 / view.scale;
    for (const t of [...(board.texts ?? [])].reverse()) {
      if (!vis(t.layer)) continue;
      const w2 = t.text.length * t.size * 0.62;
      if (w.x >= t.at.x - grab && w.x <= t.at.x + w2 + grab && w.y >= t.at.y - t.size - grab && w.y <= t.at.y + grab)
        return { kind: "text", id: t.uuid ?? "" };
    }
    for (const v of board.vias ?? []) {
      if (Math.hypot(v.at.x - w.x, v.at.y - w.y) <= v.size / 2 + grab) return { kind: "via", id: v.uuid };
    }
    for (const t of board.tracks) {
      if (!vis(t.layer)) continue;
      if (distToSeg(w, t.start, t.end) <= t.width / 2 + grab) return { kind: "track", id: t.uuid };
    }
    const hit = [...board.footprints].reverse().find((f) => {
      const fp = fps[f.libId];
      if (!fp) return false;
      const half = { w: (fp.bbox.max.x - fp.bbox.min.x) / 2, h: (fp.bbox.max.y - fp.bbox.min.y) / 2 };
      return Math.abs(w.x - f.at.x) <= half.w && Math.abs(w.y - f.at.y) <= half.h;
    });
    return hit ? { kind: "fp", id: hit.uuid } : null;
  }

  const selText = useMemo(
    () => (sel?.kind === "text" ? (board?.texts ?? []).find((t) => t.uuid === sel.id) ?? null : null),
    [sel, board],
  );

  // #region routing
  function runTracks(pts: Point[], net: string): Track[] {
    const out: Track[] = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      if (pts[i].x === pts[i + 1].x && pts[i].y === pts[i + 1].y) continue;
      out.push({ uuid: crypto.randomUUID(), layer, width, start: pts[i], end: pts[i + 1], net });
    }
    return out;
  }

  function commitRun(pts: Point[], net: string) {
    const b = latest.current;
    if (!b) return;
    const added = runTracks(pts, net);
    if (added.length) edit({ ...b, tracks: [...b.tracks, ...added] });
  }

  function endRun() {
    if (run && run.pts.length > 1) commitRun(run.pts, run.net);
    setRun(null);
  }

  // A via ends the run on this layer and starts it again on the other side at
  // the same point - which is the whole reason for a via. Both go in with one
  // edit, so neither reads a board the other has already replaced.
  function dropVia() {
    const b = latest.current;
    if (!b || !run) return;
    const at = run.pts[run.pts.length - 1];
    const v: Via = { uuid: crypto.randomUUID(), at, size: 0.6, drill: 0.3, net: run.net };
    edit({ ...b, tracks: [...b.tracks, ...runTracks(run.pts, run.net)], vias: [...(b.vias ?? []), v] });
    setLayer((l) => (l === "F.Cu" ? "B.Cu" : "F.Cu"));
    setRun({ pts: [at], net: run.net });
  }

  function onMouseDown(e: React.MouseEvent) {
    if (!board) return;
    const w = toWorld(e);
    if (e.button === 2) { endRun(); return; }

    if (tool === "track") {
      const hit = padAt(w);
      const snapped = hit ? hit.at : run ? to45(run.pts[run.pts.length - 1], w) : { x: r3(w.x), y: r3(w.y) };
      if (!run) {
        setRun({ pts: [snapped], net: hit ? hit.fp.padNets[hit.pad.number] ?? "" : "" });
      } else {
        const pts = [...run.pts, snapped];
        // Landing on a pad of the same net completes the connection; the run
        // ends there rather than carrying on through the pad.
        if (hit) { commitRun(pts, run.net || (hit.fp.padNets[hit.pad.number] ?? "")); setRun(null); }
        else setRun({ ...run, pts });
      }
      return;
    }

    if (tool === "text") {
      const t: BoardText = { uuid: crypto.randomUUID(), at: { x: r3(w.x), y: r3(w.y) }, text: "TEXT", layer: silkLayer, size: 1, rotation: 0 };
      edit({ ...board, texts: [...(board.texts ?? []), t] });
      setSel({ kind: "text", id: t.uuid! });
      setTool("move");
      return;
    }

    const got = pick(w);
    setSel(got);
    if (got && (got.kind === "fp" || got.kind === "text")) {
      const at = got.kind === "fp"
        ? board.footprints.find((f) => f.uuid === got.id)!.at
        : (board.texts ?? []).find((t) => t.uuid === got.id)!.at;
      setDrag({ sel: got, from: w, at });
      return;
    }
    if (!got) panning.current = { mx: e.clientX, my: e.clientY, vx: view.x, vy: view.y };
  }

  function onMouseMove(e: React.MouseEvent) {
    const w = toWorld(e);
    setCursor(w);
    if (drag && board) {
      const at = { x: r3(drag.at.x + (w.x - drag.from.x)), y: r3(drag.at.y + (w.y - drag.from.y)) };
      if (drag.sel!.kind === "fp") {
        setBoard({ ...board, footprints: board.footprints.map((f) => (f.uuid === drag.sel!.id ? { ...f, at } : f)) });
      } else {
        setBoard({ ...board, texts: (board.texts ?? []).map((t) => (t.uuid === drag.sel!.id ? { ...t, at } : t)) });
      }
      return;
    }
    if (panning.current) {
      setView({ ...view, x: panning.current.vx + (e.clientX - panning.current.mx), y: panning.current.vy + (e.clientY - panning.current.my) });
    }
  }

  function onMouseUp() {
    if (drag && latest.current) edit(latest.current);
    setDrag(null);
    panning.current = null;
  }

  function onWheel(e: React.WheelEvent) {
    const r = svgRef.current!.getBoundingClientRect();
    const before = toWorld(e);
    const scale = Math.min(60, Math.max(0.5, view.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    const sx = flip ? boardW - before.x : before.x;
    setView({ scale, x: e.clientX - r.left - sx * scale, y: e.clientY - r.top - before.y * scale });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const b = latest.current;
      if (!b) return;
      if (e.key === "Escape") { setRun(null); setSel(null); return; }
      if (e.key === "Enter" && run) { endRun(); return; }
      if (e.key.toLowerCase() === "v" && run) { dropVia(); return; }
      if (!sel) return;
      const k = e.key.toLowerCase();
      if (sel.kind === "fp") {
        if (k === "r") edit({ ...b, footprints: b.footprints.map((f) => (f.uuid === sel.id ? { ...f, rotation: (f.rotation + 90) % 360 } : f)) });
        if (k === "f") edit({ ...b, footprints: b.footprints.map((f) => (f.uuid === sel.id ? { ...f, side: f.side === "F" ? "B" : "F" } : f)) });
      }
      if (sel.kind === "text" && k === "r") {
        edit({ ...b, texts: (b.texts ?? []).map((t) => (t.uuid === sel.id ? { ...t, rotation: ((t.rotation ?? 0) + 90) % 360 } : t)) });
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (sel.kind === "track") edit({ ...b, tracks: b.tracks.filter((t) => t.uuid !== sel.id) });
        if (sel.kind === "via") edit({ ...b, vias: (b.vias ?? []).filter((v) => v.uuid !== sel.id) });
        if (sel.kind === "text") edit({ ...b, texts: (b.texts ?? []).filter((t) => t.uuid !== sel.id) });
        setSel(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, run, layer, width]);

  if (!board) {
    return (
      <div className="pcbwrap">
        <div className="pcbbar">
          <button className="primary" onClick={() => generate(false)} disabled={busy === "gen" || !schem}>
            {busy === "gen" ? "Placing…" : "Generate board"}
          </button>
          <span className="status">No board yet</span>
        </div>
      </div>
    );
  }

  const errors = drc.filter((d) => d.severity === "error").length;
  const boardW = board.outline.length ? Math.max(...board.outline.map((p) => p.x)) : 0;
  const preview45 = run ? to45(run.pts[run.pts.length - 1], cursor) : null;

  return (
    <div className="pcbwrap">
      <div className="pcbbar">
        <div className="viewswitch">
          <button className={pane === "layout" ? "on" : ""} onClick={() => setPane("layout")}>Layout</button>
          <button className={pane === "renders" ? "on" : ""} onClick={openRenders}>Renders</button>
        </div>
        {pane === "layout" && (
          <>
            <div className="viewswitch">
              <button className={tool === "move" ? "on" : ""} onClick={() => { setTool("move"); setRun(null); }}>Move</button>
              <button className={tool === "track" ? "on" : ""} onClick={() => setTool("track")}>Track</button>
              <button className={tool === "text" ? "on" : ""} onClick={() => { setTool("text"); setRun(null); }}>Text</button>
            </div>
            {tool === "text" ? (
              <select value={silkLayer} onChange={(e) => setSilkLayer(e.target.value)} aria-label="Silkscreen layer">
                {SILK.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            ) : (
              <>
                <select value={layer} onChange={(e) => setLayer(e.target.value)} aria-label="Copper layer">
                  {COPPER.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
                <select value={width} onChange={(e) => setWidth(Number(e.target.value))} aria-label="Track width">
                  {WIDTHS.map((w) => <option key={w} value={w}>{w} mm</option>)}
                </select>
              </>
            )}
            <button className={flip ? "on" : ""} onClick={() => setFlip((f) => !f)}>{flip ? "Back" : "Front"}</button>
            <button onClick={() => fit(board)}>Fit</button>
            <button onClick={() => generate(true)} disabled={!!busy}>Re-sync</button>
            <button className="primary" onClick={() => save()} disabled={!!busy}>{dirty ? "Save" : "Saved"}</button>
            <button onClick={autoroute} disabled={!!busy}>{busy === "route" ? "Routing…" : "Autoroute"}</button>
          </>
        )}
        <button onClick={render} disabled={!!busy}>{busy === "render" ? "Rendering…" : pane === "renders" && renders.length ? "Re-render" : "Render"}</button>
        <a className="linkbtn" href={`/artifact/${encodeURIComponent(project)}/${unit ? `boards/${unit}/` : ""}board.kicad_pcb`} download>
          board.kicad_pcb
        </a>
        <span className="spacer" />
        <span className="status">
          {board.footprints.length} parts · {rats.length} unrouted · {board.tracks.length} tracks
          {errors ? ` · ${errors} DRC errors` : unrouted || drc.length ? " · DRC clean" : ""}
        </span>
        <span className="status desktop-only">{board.rules.name}</span>
      </div>
      {progress?.running && Date.now() - progress.updatedAt < 60_000 && <RouteBar p={progress} />}
      {diskAhead && (
        <div className="pcbnote diskahead">
          <span>board.kicad_pcb changed on disk</span>
          <button onClick={pull}>Reload</button>
          <button onClick={() => { setDiskAhead(false); save(); }}>Keep mine</button>
        </div>
      )}
      {routeNote && <div className="pcbnote">{routeNote}</div>}
      {preview && (
        <div className="lightbox" onClick={() => setPreview(null)}>
          <img src={preview} alt="" />
          <a className="lightboxlink" href={preview} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Full size</a>
        </div>
      )}

      {pane === "renders" ? (
        <div className="renderpane">
          {renders.length === 0 ? (
            <div className="renderempty">
              <div>No renders yet</div>
              <button className="primary" onClick={render} disabled={!!busy}>{busy === "render" ? "Rendering…" : "Render"}</button>
            </div>
          ) : (
            renders.map((name) => {
              const href = `/artifact/${encodeURIComponent(project)}/${unit ? `boards/${unit}/` : ""}${name}?t=${stamp}`;
              return (
                <figure key={name}>
                  <img src={href} alt={name} onClick={() => setPreview(href)} />
                  <figcaption>{name}</figcaption>
                </figure>
              );
            })
          )}
        </div>
      ) : (
      <svg
        ref={svgRef}
        className="pcbcanvas"
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onDoubleClick={endRun}
        onContextMenu={(e) => { e.preventDefault(); endRun(); }}
      >
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
            <line
              key={t.uuid}
              x1={t.start.x} y1={t.start.y} x2={t.end.x} y2={t.end.y}
              stroke={sel?.kind === "track" && sel.id === t.uuid ? "#fff" : LAYER_COLOR[t.layer] ?? "#888"}
              strokeWidth={t.width}
              strokeLinecap="round"
              opacity={0.9}
            />
          ))}
          {/* vias */}
          {(board.vias ?? []).map((v) => (
            <g key={v.uuid}>
              {vis("F.Cu") && <circle cx={v.at.x} cy={v.at.y} r={v.size / 2} fill={sel?.kind === "via" && sel.id === v.uuid ? "#fff" : LAYER_COLOR["F.Cu"]} opacity={0.8} />}
              {vis("Drill") && <circle cx={v.at.x} cy={v.at.y} r={v.drill / 2} fill="#101216" />}
            </g>
          ))}

          {/* the run being drawn */}
          {run && (
            <>
              {run.pts.slice(0, -1).map((p, i) => (
                <line key={i} x1={p.x} y1={p.y} x2={run.pts[i + 1].x} y2={run.pts[i + 1].y} stroke={LAYER_COLOR[layer]} strokeWidth={width} strokeLinecap="round" opacity={0.75} />
              ))}
              {preview45 && (
                <line
                  x1={run.pts[run.pts.length - 1].x} y1={run.pts[run.pts.length - 1].y}
                  x2={preview45.x} y2={preview45.y}
                  stroke={LAYER_COLOR[layer]} strokeWidth={width} strokeLinecap="round" strokeDasharray="0.5 0.4" opacity={0.9}
                />
              )}
            </>
          )}

          {/* board silkscreen */}
          {(board.texts ?? []).filter((t) => vis(t.layer)).map((t, i) => (
            <text
              key={t.uuid ?? i}
              x={t.at.x}
              y={t.at.y}
              fontSize={t.size}
              fill={sel?.kind === "text" && sel.id === t.uuid ? "#fff" : LAYER_COLOR[t.layer] ?? "#d8d8d8"}
              transform={t.rotation ? `rotate(${-t.rotation},${t.at.x},${t.at.y})` : undefined}
              style={{ fontWeight: t.bold ? 700 : 400 }}
            >
              {t.text}
            </text>
          ))}

          {/* footprints */}
          {board.footprints.map((f) => {
            const fp = fps[f.libId];
            if (!fp) return null;
            const selected = sel?.kind === "fp" && sel.id === f.uuid;
            return (
              <g key={f.uuid} transform={`translate(${f.at.x},${f.at.y}) rotate(${-f.rotation}) ${f.side === "B" ? "scale(-1,1)" : ""}`}>
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
                    <g key={i} transform={`translate(${p.x},${p.y}) rotate(${-pad.rotation})`}>
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
      )}

      {pane === "layout" && <LayerBox on={on} setOn={setOn} vis={vis} solo={solo} />}

      {selText && (
        <TextBox
          text={selText}
          onChange={(patch) => edit({ ...board, texts: (board.texts ?? []).map((t) => (t.uuid === selText.uuid ? { ...t, ...patch } : t)) })}
          onDelete={() => { edit({ ...board, texts: (board.texts ?? []).filter((t) => t.uuid !== selText.uuid) }); setSel(null); }}
          onClose={() => setSel(null)}
        />
      )}

      {pane === "layout" && drc.length > 0 && (
        <div className="drclist">
          {drc.slice(0, 8).map((d, i) => (
            <div key={i} className={"issue " + d.severity}>
              <div className="rule">{d.rule}</div>
              <div className="msg">{d.message}</div>
            </div>
          ))}
        </div>
      )}
      {pane === "layout" && (
        <div className="pcbhint">
          <span>R rotate</span><span>F flip</span><span>V via</span><span>Enter finish</span><span>Del delete</span><span>Esc cancel</span>
        </div>
      )}
    </div>
  );
}

// #region layer box
// Movable and collapsible: it sits over the canvas, and a fixed panel over the
// corner of the board you are working on is a panel in the way. Where it was
// put and whether it was open survive a reload.
function LayerBox({ on, setOn, vis, solo }: {
  on: Record<string, boolean>;
  setOn: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  vis: (id: string) => boolean;
  solo: (id: string) => void;
}) {
  const [box, setBox] = useState<{ x: number; y: number; open: boolean }>(() => {
    try {
      const raw = localStorage.getItem("loon.layerbox");
      if (raw) return JSON.parse(raw);
    } catch { /* first run */ }
    // On a phone the box is most of the board, so it starts shut there.
    const narrow = typeof window !== "undefined" && window.matchMedia("(max-width: 860px)").matches;
    return { x: -1, y: 96, open: !narrow };
  });
  useEffect(() => { try { localStorage.setItem("loon.layerbox", JSON.stringify(box)); } catch {} }, [box]);
  const dragging = useRef<{ mx: number; my: number; x: number; y: number } | null>(null);

  useEffect(() => {
    function move(e: MouseEvent) {
      if (!dragging.current) return;
      const d = dragging.current;
      setBox((b) => ({ ...b, x: Math.max(4, d.x + (e.clientX - d.mx)), y: Math.max(4, d.y + (e.clientY - d.my)) }));
    }
    function up() { dragging.current = null; }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, []);

  // x < 0 means "never moved": stay pinned to the right edge. Only ever one of
  // left/right, or the box stretches the width of the canvas.
  const style: React.CSSProperties = box.x < 0
    ? { top: box.y, right: 12, left: "auto" }
    : { top: box.y, left: box.x, right: "auto" };

  return (
    <div className={"layerpanel" + (box.open ? "" : " shut")} style={style}>
      <div
        className="layerhead"
        onMouseDown={(e) => {
          // offsetLeft/Top are in the same frame as the left/top written back,
          // so the box does not jump on the first drag.
          const el = e.currentTarget.parentElement as HTMLElement;
          dragging.current = { mx: e.clientX, my: e.clientY, x: el.offsetLeft, y: el.offsetTop };
        }}
      >
        <span>Layers</span>
        <button
          className="collapse"
          aria-expanded={box.open}
          aria-label={box.open ? "Collapse layers" : "Expand layers"}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setBox((b) => ({ ...b, open: !b.open }))}
        >
          {box.open ? "−" : "+"}
        </button>
      </div>
      {box.open && (
        <div className="layerbody">
          {LAYERS.map((l) => (
            <div key={l.id} className={"layerrow" + (vis(l.id) ? " on" : "")}>
              <label>
                <input type="checkbox" checked={vis(l.id)} onChange={(e) => setOn((o) => ({ ...o, [l.id]: e.target.checked }))} />
                <span className="swatch" style={{ background: l.color }} />
                {l.label}
              </label>
              <button className="soloBtn" onClick={() => solo(l.id)}>only</button>
            </div>
          ))}
          <div className="layerrow">
            <button onClick={() => setOn(Object.fromEntries(LAYERS.map((l) => [l.id, true])))}>All</button>
            <button onClick={() => setOn(Object.fromEntries(LAYERS.map((l) => [l.id, DEFAULT_ON.includes(l.id)])))}>Reset</button>
          </div>
        </div>
      )}
    </div>
  );
}

// #region silkscreen text
function TextBox({ text, onChange, onDelete, onClose }: {
  text: BoardText;
  onChange: (patch: Partial<BoardText>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <div className="textbox">
      <div className="layerhead"><span>Silkscreen</span><button className="collapse" aria-label="Close" onClick={onClose}>×</button></div>
      <label>
        Text
        <input value={text.text} autoFocus onChange={(e) => onChange({ text: e.target.value })} />
      </label>
      <div className="row">
        <label>
          Size
          <input type="number" step={0.1} min={0.4} value={text.size} onChange={(e) => onChange({ size: Number(e.target.value) || 1 })} />
        </label>
        <label>
          Angle
          <input type="number" step={90} value={text.rotation ?? 0} onChange={(e) => onChange({ rotation: Number(e.target.value) || 0 })} />
        </label>
      </div>
      <div className="row">
        <label>
          Layer
          <select value={text.layer} onChange={(e) => onChange({ layer: e.target.value })}>
            {SILK.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <label className="checkrow">
          <input type="checkbox" checked={!!text.bold} onChange={(e) => onChange({ bold: e.target.checked })} />
          Bold
        </label>
      </div>
      <button onClick={onDelete}>Delete</button>
    </div>
  );
}

// #region route bar
// A run killed partway leaves route-progress.json saying it is still running,
// so the bar is shown only while the file is still being written to.
const STAGE_LABEL: Record<RouteProgress["stage"], string> = {
  export: "Export", fanout: "Fanout", route: "Routing", optimize: "Optimizer", import: "Import", drc: "DRC", done: "Done", failed: "Failed",
};
function fmtEta(s: number | null): string {
  if (s === null) return "ETA …";
  if (s < 60) return `ETA ${s} s`;
  return `ETA ${Math.round(s / 60)} min`;
}
function RouteBar({ p }: { p: RouteProgress }) {
  const elapsed = Math.round((Date.now() - p.startedAt) / 1000);
  const pass = p.stage === "route" ? `Pass ${p.pass}/${p.passes}` : p.pass ? `Pass ${p.pass}` : "";
  return (
    <div className="routebar" role="progressbar" aria-valuenow={Math.round(p.fraction * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className="routebar-fill" style={{ width: `${Math.round(p.fraction * 100)}%` }} />
      <span className="routebar-text">
        {STAGE_LABEL[p.stage]}{pass ? ` · ${pass}` : ""}{p.stage === "route" || p.stage === "optimize" || p.stage === "fanout" ? ` · ${p.unrouted} open` : ""}
        {p.violations ? ` · ${p.violations} violations` : ""} · {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")} · {fmtEta(p.etaSeconds)}
      </span>
    </div>
  );
}
// #endregion
