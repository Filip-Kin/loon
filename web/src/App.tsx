import React, { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "./trpc";
import { Canvas, clampScale, type Tool, type Viewport } from "./editor/Canvas";
import { BlockCanvas } from "./editor/BlockCanvas";
import { CodeView } from "./editor/CodeView";
import { PcbCanvas } from "./editor/PcbCanvas";
import { SimView } from "./editor/SimView";
import { PartsPanel } from "./panels/PartsPanel";
import { PropertiesPanel } from "./panels/PropertiesPanel";
import { AiPanel, type ChatMsg } from "./panels/AiPanel";
import { DebugPanel } from "./panels/DebugPanel";
import { CheckPanel } from "./panels/CheckPanel";
import type { ErcIssue } from "@loon/shared/erc";
import { makeClientResolver } from "./lib/resolver";
import { applyOps } from "@loon/shared/apply-ops";
import type { Schematic, LibSymbol, Point } from "@loon/shared/schematic";
import { instanceBBox } from "@loon/shared/geometry";
import type { Op, PinRef } from "@loon/shared/ops";
import type { PartSummary } from "@loon/shared/parts";
import type { ProjectMeta } from "../../server/src/services/storage";

type View = "schematic" | "blocks" | "pcb" | "code" | "sim";
const VIEWS: { id: View; label: string }[] = [
  { id: "blocks", label: "Blocks" },
  { id: "schematic", label: "Schematic" },
  { id: "pcb", label: "PCB" },
  { id: "code", label: "Code" },
  { id: "sim", label: "Simulate" },
];

export function App() {
  const [parts, setParts] = useState<PartSummary[]>([]);
  const [defs, setDefs] = useState<Record<string, LibSymbol>>({});
  const [schem, setSchem] = useState<Schematic | null>(null);
  const [projectName, setProjectName] = useState<string>("untitled");
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  // A project can hold more than one board: "" is the main board at its root.
  const [boards, setBoards] = useState<string[]>([""]);
  const [boardName, setBoardName] = useState<string>("");
  const [selection, setSelection] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [placingLibId, setPlacingLibId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: -320, y: -260, scale: 5 });
  const fittedFor = useRef<string>("");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [progress, setProgress] = useState<string | null>(null);
  const [aiAvailable, setAiAvailable] = useState(true);
  const [rightTab, setRightTab] = useState<"props" | "ai" | "debug" | "check">("ai");
  const [issues, setIssues] = useState<ErcIssue[]>([]);
  const [nets, setNets] = useState<{ name: string; isPower: boolean; pins: string[] }[]>([]);
  const [checking, setChecking] = useState(false);
  const [highlightNet, setHighlightNet] = useState<string | null>(null);
  const [view, setView] = useState<View>("schematic");
  // Which view is showing, chosen from the bottom bar on a phone and the top
  // bar on a desktop.
  const [viewMenu, setViewMenu] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [blockSel, setBlockSel] = useState<string | null>(null);
  const [blockViewport, setBlockViewport] = useState<Viewport>({ x: 40, y: 40, scale: 1.6 });
  // Bumped when the assistant touches the board or the firmware, so those views
  // reload without the user going to look.
  const [boardRev, setBoardRev] = useState(0);
  const [firmwareRev, setFirmwareRev] = useState(0);
  const [toast, setToast] = useState<{ text: string; err?: boolean } | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 860px)").matches);
  const [mobileView, setMobileView] = useState<"design" | "parts" | "panel">("design");
  // Sidebars fold away, because a board is wider than the gap between them.
  // Which ones were open is remembered, so the layout survives a reload.
  const [sidebars, setSidebars] = useState<{ left: boolean; right: boolean }>(() => {
    try {
      const raw = localStorage.getItem("loon.sidebars");
      if (raw) return JSON.parse(raw);
    } catch { /* first run */ }
    return { left: true, right: true };
  });
  useEffect(() => { try { localStorage.setItem("loon.sidebars", JSON.stringify(sidebars)); } catch {} }, [sidebars]);

  const past = useRef<Schematic[]>([]);
  const future = useRef<Schematic[]>([]);
  // Autosave bookkeeping. skipAutosave suppresses the save that would
  // otherwise fire the moment a project is opened, which would rewrite the
  // file with what we just read.
  const skipAutosave = useRef(true);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(false);
  const pendingSave = useRef(false);
  const latest = useRef<{ name: string; schem: Schematic | null; board: string }>({ name: "untitled", schem: null, board: "" });

  const resolver = useMemo(() => makeClientResolver(defs, parts), [defs, parts]);
  const renderDefs = useMemo(() => ({ ...defs, ...(schem?.libSymbols ?? {}) }), [defs, schem]);
  const selInst = useMemo(() => (schem && selection ? schem.symbols.find((s) => s.uuid === selection) ?? null : null), [schem, selection]);

  function flash(text: string, err = false) {
    setToast({ text, err });
    setTimeout(() => setToast(null), 2200);
  }

  // Initial load.
  useEffect(() => {
    (async () => {
      const lib = await trpc.library.all.query();
      setParts(lib.parts);
      setDefs(lib.defs);
      const list = await trpc.project.list.query();
      setProjects(list);
      const last = localStorage.getItem("loon.lastProject");
      const pick = list.find((p) => p.name === last)?.name ?? list[0]?.name;
      if (pick) {
        await openProject(pick);
      } else {
        await newProject("untitled");
      }
      try {
        const m = await fetch("/.well-known/loon").then((r) => r.json());
        setAiAvailable(!!m.aiAvailable);
      } catch { /* ignore */ }
    })().catch((e) => flash(String(e?.message ?? e), true));
  }, []);

  function commit(next: Schematic) {
    if (schem) {
      past.current.push(schem);
      if (past.current.length > 100) past.current.shift();
    }
    future.current = [];
    setSchem(next);
  }

  function applyLocal(ops: Op[]) {
    if (!schem) return;
    const next = structuredClone(schem);
    applyOps(next, ops, resolver);
    commit(next);
  }

  function undo() {
    const p = past.current.pop();
    if (!p || !schem) return;
    future.current.push(schem);
    setSchem(p);
  }
  function redo() {
    const f = future.current.pop();
    if (!f || !schem) return;
    past.current.push(schem);
    setSchem(f);
  }

  async function newProject(name: string) {
    const res = await trpc.project.create.mutate({ name });
    past.current = []; future.current = [];
    skipAutosave.current = true;
    setSaveState("saved");
    localStorage.setItem("loon.lastProject", name);
    setSchem(res.schem);
    setProjectName(name);
    setSelection(null);
    setProjects(await trpc.project.list.query());
  }

  async function openProject(name: string, board = "") {
    const res = await trpc.project.load.query({ name, board });
    past.current = []; future.current = [];
    skipAutosave.current = true;
    setSaveState("saved");
    localStorage.setItem("loon.lastProject", name);
    setSchem(res.schem);
    setProjectName(name);
    setBoardName(board);
    setSelection(null);
    setBoards(await trpc.project.boards.query({ name }));
  }

  // Add a board to this product: same shape as the main one, its own firmware.
  async function newBoard(board: string) {
    const res = await trpc.project.createBoard.mutate({ name: projectName, board });
    setBoards(res.boards);
    past.current = []; future.current = [];
    skipAutosave.current = true;
    setSaveState("saved");
    setSchem(res.schem as Schematic);
    setBoardName(board);
    setSelection(null);
  }

  async function save() {
    if (!schem) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    try {
      setSaveState("saving");
      await trpc.project.save.mutate({ name: projectName, schem, board: boardName });
      setSavedAt(Date.now());
      setSaveState("saved");
      setProjects(await trpc.project.list.query());
      flash(`Saved ${projectName}.kicad_sch`);
    } catch (e: any) {
      setSaveState("error");
      flash(String(e?.message ?? e), true);
    }
  }

  // The generation runs as a job on the server and we poll it, so a whole-board
  // prompt cannot be cut short by a proxy or a request timeout.
  async function aiSend(text: string) {
    if (!schem) return;
    setMessages((m) => [...m, { role: "user", text }]);
    setBusy(true);
    setElapsed(0);
    const started = Date.now();
    const tick = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    try {
      const { id } = await trpc.ai.start.mutate({ message: text, schem, project: projectName, board: boardName });
      let res: any = null;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const st: any = await trpc.ai.status.query({ id });
        if (st.state === "running") {
          // The assistant reports what it is doing while it does it.
          if (st.message) setProgress(st.message);
          continue;
        }
        if (st.state === "error") throw new Error(st.error ?? "generation failed");
        res = st;
        break;
      }
      setProgress(null);
      if (schem && res.schem) { past.current.push(schem); future.current = []; }
      if (res.schem) setSchem(res.schem as Schematic);
      // It may have worked on another board in this project; follow it there.
      if (res.editedBoard !== undefined && res.editedBoard !== boardName) {
        await openProject(projectName, res.editedBoard);
        setMessages((m) => [...m, { role: "bot", text: `Switched you to board "${res.editedBoard || "main"}".` }]);
      }
      const failed = (res.results ?? []).filter((r: any) => !r.ok);
      const lines: string[] = [res.message || `Applied ${(res.ops ?? []).length} operation(s).`];
      for (const st of res.steps ?? []) {
        lines.push(`${st.ok ? "done" : "failed"}: ${st.label}${st.detail ? ` - ${st.detail}` : ""}`);
      }
      if (failed.length) lines.push(`(${failed.length} op(s) failed: ${failed.map((f: any) => f.error).join("; ")})`);
      setMessages((m) => [...m, { role: "bot", text: lines.join("\n") }]);
      if (res.touched?.board) setBoardRev((r) => r + 1);
      if (res.touched?.firmware) setFirmwareRev((r) => r + 1);
    } catch (e: any) {
      setMessages((m) => [...m, { role: "err", text: String(e?.message ?? e) }]);
    }
    clearInterval(tick);
    setBusy(false);
  }

  // Fit the whole schematic when a board is opened. A design that starts
  // off-screen looks like an empty sheet.
  useEffect(() => {
    if (!schem || schem.symbols.length === 0) return;
    const key = `${projectName}/${boardName}/${schem.uuid}`;
    if (fittedFor.current === key) return;
    fittedFor.current = key;
    let min = { x: Infinity, y: Infinity };
    let max = { x: -Infinity, y: -Infinity };
    for (const inst of schem.symbols) {
      const def = renderDefs[inst.libId];
      if (!def) continue;
      const b = instanceBBox(def, { at: inst.at, rotation: inst.rotation, mirror: inst.mirror });
      min = { x: Math.min(min.x, b.min.x), y: Math.min(min.y, b.min.y) };
      max = { x: Math.max(max.x, b.max.x), y: Math.max(max.y, b.max.y) };
    }
    if (!isFinite(min.x)) return;
    const el = document.querySelector(".canvas-wrap");
    const w = el?.clientWidth ?? window.innerWidth - 600;
    const h = el?.clientHeight ?? window.innerHeight - 120;
    const pad = 24;
    // The same clamp the wheel uses, so whatever a sheet opens at can be got
    // back to.
    const scale = clampScale(Math.min(8, Math.min(w / (max.x - min.x + pad), h / (max.y - min.y + pad))));
    setViewport({ scale, x: w / 2 - ((min.x + max.x) / 2) * scale, y: h / 2 - ((min.y + max.y) / 2) * scale });
  }, [schem, renderDefs, projectName, boardName]);

  // #region checks
  async function runCheck() {
    if (!schem) return;
    setChecking(true);
    try {
      const res = await trpc.design.check.mutate({ schem });
      setIssues(res.issues as ErcIssue[]);
      setNets(res.nets);
    } catch (e: any) {
      flash(String(e?.message ?? e), true);
    }
    setChecking(false);
  }

  // Re-check whenever the design settles, so the error count is never stale.
  useEffect(() => {
    if (!schem) return;
    const t = setTimeout(() => { runCheck(); }, 1200);
    return () => clearTimeout(t);
  }, [schem]);

  const highlightRefs = useMemo(() => {
    if (!highlightNet) return null;
    const net = nets.find((n) => n.name === highlightNet);
    if (!net) return null;
    return new Set(net.pins.map((p) => p.split(".")[0]));
  }, [highlightNet, nets]);

  // #region autosave
  // Every mutation funnels through commit(), so watching `schem` catches edits,
  // AI ops and undo/redo alike. Debounced, because dragging a symbol produces a
  // new schematic on every mouse move.
  useEffect(() => {
    latest.current = { name: projectName, schem, board: boardName };
    if (!schem) return;
    if (skipAutosave.current) { skipAutosave.current = false; return; }
    setSaveState("dirty");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { autosave(); }, 900);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [schem, projectName, boardName]);

  async function autosave() {
    const { name, schem: cur, board } = latest.current;
    if (!cur) return;
    if (saving.current) { pendingSave.current = true; return; }
    saving.current = true;
    setSaveState("saving");
    try {
      await trpc.project.save.mutate({ name, schem: cur, board });
      setSavedAt(Date.now());
      setSaveState(pendingSave.current ? "dirty" : "saved");
    } catch (e: any) {
      setSaveState("error");
      flash(`Autosave failed: ${String(e?.message ?? e)}`, true);
    }
    saving.current = false;
    if (pendingSave.current) { pendingSave.current = false; autosave(); }
  }

  // A refresh or a closed tab must not lose the last few seconds of work, so
  // flush the pending save with a keepalive request the browser will finish
  // even as the page goes away.
  useEffect(() => {
    function flush() {
      if (saveState === "saved" || !latest.current.schem) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      // Batch-link wire format: ?batch=1 with the inputs keyed by index.
      const body = JSON.stringify({ 0: { name: latest.current.name, schem: latest.current.schem, board: latest.current.board } });
      fetch("/trpc/project.save?batch=1", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
    }
    function onHide() { if (document.visibilityState === "hidden") flush(); }
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [saveState]);

  // Keyboard shortcuts.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
      if (e.key === "Escape") { setNavOpen(false); setViewMenu(false); setTool("select"); setPlacingLibId(null); return; }
      if (e.key.toLowerCase() === "w") { setTool("wire"); return; }
      if (e.key.toLowerCase() === "v") { setTool("select"); return; }
      if (selection) {
        if (e.key.toLowerCase() === "r") {
          const inst = schem?.symbols.find((s) => s.uuid === selection);
          if (inst) applyLocal([{ op: "move_symbol", uuid: selection, at: inst.at, rotation: (inst.rotation + 90) % 360 }]);
        }
        if (e.key === "Delete" || e.key === "Backspace") { applyLocal([{ op: "delete", uuid: selection }]); setSelection(null); }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, schem, projectName, resolver]);

  // Track viewport size for the mobile layout.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 860px)");
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // The drawer and the view menu close whenever the view behind them changes,
  // so neither is ever left open over something the user already moved on from.
  useEffect(() => { setNavOpen(false); setViewMenu(false); }, [view, projectName, boardName]);

  function pickPart(libId: string) {
    setPlacingLibId(libId);
    setTool("place");
    if (isMobile) setMobileView("design"); // jump to the sheet to drop the part
  }

  return (
    <div className="app">
      <div className={"topbar" + (navOpen ? " navopen" : "")}>
        <div className="brand">loon<span>.</span></div>
        <button
          className="hamburger"
          aria-label="Menu"
          aria-expanded={navOpen}
          onClick={() => setNavOpen((o) => !o)}
        >
          <span /><span /><span />
        </button>
        <div className="barinner">
        <select value={projectName} onChange={(e) => openProject(e.target.value)}>
          {projects.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          {!projects.find((p) => p.name === projectName) && <option value={projectName}>{projectName}</option>}
        </select>
        <button onClick={() => { const n = prompt("New project name", "untitled"); if (n) newProject(n); }}>New</button>
        <select
          className="boardpick"
          value={boardName}
          onChange={(e) => {
            if (e.target.value === "__new") {
              const n = prompt("Name for the new board in this project", "remote_estop");
              if (n) newBoard(n.replace(/[^A-Za-z0-9._-]/g, "_"));
              return;
            }
            openProject(projectName, e.target.value);
          }}
          title="Boards in this project"
        >
          {boards.map((b) => <option key={b} value={b}>{b || "main board"}</option>)}
          <option value="__new">+ add board...</option>
        </select>
        <button onClick={save}>Save</button>
        <span className={"savestate " + saveState} title={savedAt ? `Last saved ${new Date(savedAt).toLocaleTimeString()}` : "Not saved yet"}>
          {saveState === "saving" ? "Saving..." : saveState === "dirty" ? "Unsaved" : saveState === "error" ? "Save failed" : savedAt ? `Saved ${new Date(savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Saved"}
        </span>
        <div className="desktop-only" style={{ width: 1, height: 22, background: "var(--line)" }} />
        <div className="viewswitch">
          {VIEWS.map((v) => (
            <button key={v.id} className={view === v.id ? "on" : ""} onClick={() => setView(v.id)}>{v.label}</button>
          ))}
        </div>
        {view === "schematic" && <button className={"desktop-only " + (tool === "select" ? "primary" : "")} onClick={() => { setTool("select"); setPlacingLibId(null); }}>Select</button>}
        {view === "schematic" && <button className={"desktop-only " + (tool === "wire" ? "primary" : "")} onClick={() => setTool("wire")}>Wire</button>}
        {placingLibId && <span className="status">Placing {placingLibId}{isMobile ? " - tap sheet" : " - click sheet (Esc to stop)"}</span>}
        <div className="spacer" />
        <button
          className={"desktop-only" + (sidebars.left ? " on" : "")}
          aria-pressed={sidebars.left}
          onClick={() => setSidebars((s) => ({ ...s, left: !s.left }))}
        >Parts</button>
        <button
          className={"desktop-only" + (sidebars.right ? " on" : "")}
          aria-pressed={sidebars.right}
          onClick={() => setSidebars((s) => ({ ...s, right: !s.right }))}
        >Assistant</button>
        <button className="desktop-only" onClick={() => { fittedFor.current = ""; setSchem((s) => (s ? { ...s } : s)); }} title="Fit the whole sheet">Fit</button>
        <button className="desktop-only" onClick={undo}>Undo</button>
        <button className="desktop-only" onClick={redo}>Redo</button>
        <span className="status desktop-only">{schem ? `${schem.symbols.length} parts, ${schem.wires.length} wires` : "Loading…"}</span>
        </div>
      </div>
      {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} />}

      <div
        className={"workspace" + (isMobile ? " mobile" : "") + (sidebars.left ? "" : " no-left") + (sidebars.right ? "" : " no-right")}
        data-view={mobileView}
      >
        {(sidebars.left || isMobile) && <PartsPanel parts={parts} placingLibId={placingLibId} onPick={pickPart} />}

        <div className="canvas-wrap">
          {view === "code" && <CodeView project={projectName} schem={schem} flash={flash} rev={firmwareRev} board={boardName} />}
          {view === "pcb" && <PcbCanvas project={projectName} schem={schem} flash={flash} rev={boardRev} unit={boardName} />}
          {view === "sim" && <SimView project={projectName} schem={schem} defs={renderDefs} flash={flash} board={boardName} />}
          {schem && view === "blocks" && (
            <BlockCanvas
              schem={schem}
              defs={renderDefs}
              viewport={blockViewport}
              setViewport={setBlockViewport}
              selection={blockSel}
              onSelect={setBlockSel}
              onOps={(ops) => applyLocal(ops)}
              onDrillIn={(memberUuids: string[]) => {
                // Drill in: jump to the schematic, framed on the block's parts.
                setView("schematic");
                const parts = schem.symbols.filter((s) => memberUuids.includes(s.uuid));
                if (parts.length === 0) return;
                const xs = parts.map((p) => p.at.x), ys = parts.map((p) => p.at.y);
                const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
                const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
                const el = document.querySelector(".canvas-wrap");
                const w = el?.clientWidth ?? window.innerWidth;
                const h = el?.clientHeight ?? window.innerHeight;
                const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 20);
                const scale = clampScale(Math.min(8, Math.min(w, h) / (span + 40)));
                fittedFor.current = `${projectName}/${boardName}/${schem.uuid}`;
                setViewport({ scale, x: w / 2 - cx * scale, y: h / 2 - cy * scale });
                setSelection(memberUuids[0] ?? null);
              }}
            />
          )}
          {schem && view === "schematic" && (
            <Canvas
              schem={schem}
              defs={renderDefs}
              tool={tool}
              placingLibId={placingLibId}
              selection={selection}
              viewport={viewport}
              setViewport={setViewport}
              onSelect={setSelection}
              onPlace={(w: Point) => placingLibId && applyLocal([{ op: "add_symbol", libId: placingLibId, at: w }])}
              onMove={(uuid, w) => applyLocal([{ op: "move_symbol", uuid, at: w }])}
              onConnect={(a: PinRef, b: PinRef) => applyLocal([{ op: "connect_pins", a, b }])}
              onAddWire={(from, to) => applyLocal([{ op: "add_wire", from, to }])}
              highlightRefs={highlightRefs}
            />
          )}
          {toast && <div className={"toast" + (toast.err ? " err" : "")}>{toast.text}</div>}
        </div>

        {(sidebars.right || isMobile) && (
        <div className="panel right">
          <div className="tabs">
            <button className={rightTab === "ai" ? "on" : ""} onClick={() => setRightTab("ai")}>AI</button>
            <button className={rightTab === "check" ? "on" : ""} onClick={() => { setRightTab("check"); runCheck(); }}>
              Check{issues.some((i) => i.severity === "error") ? ` (${issues.filter((i) => i.severity === "error").length})` : ""}
            </button>
            <button className={rightTab === "props" ? "on" : ""} onClick={() => setRightTab("props")}>Properties</button>
            <button className={rightTab === "debug" ? "on" : ""} onClick={() => setRightTab("debug")}>Debug</button>
          </div>
          {rightTab === "debug" ? (
            <DebugPanel />
          ) : rightTab === "check" ? (
            <CheckPanel
              issues={issues}
              nets={nets}
              busy={checking}
              onRefresh={runCheck}
              onSelectNet={(n) => setHighlightNet((cur) => (cur === n ? null : n))}
              highlight={highlightNet}
            />
          ) : rightTab === "ai" ? (
            <AiPanel messages={messages} busy={busy} elapsed={elapsed} progress={progress} aiAvailable={aiAvailable} onSend={aiSend} />
          ) : (
            <PropertiesPanel
              inst={selInst}
              onSetProp={(uuid, key, value) => applyLocal([{ op: "set_property", uuid, key, value }])}
              onRotate={(uuid) => { const inst = schem?.symbols.find((s) => s.uuid === uuid); if (inst) applyLocal([{ op: "move_symbol", uuid, at: inst.at, rotation: (inst.rotation + 90) % 360 }]); }}
              onDelete={(uuid) => { applyLocal([{ op: "delete", uuid }]); setSelection(null); }}
            />
          )}
        </div>
        )}
      </div>

      {isMobile && viewMenu && (
        <>
          <div className="scrim" onClick={() => setViewMenu(false)} />
          <div className="viewmenu" role="menu">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                role="menuitem"
                className={view === v.id ? "on" : ""}
                onClick={() => { setView(v.id); setViewMenu(false); setMobileView("design"); }}
              >
                {v.label}
              </button>
            ))}
          </div>
        </>
      )}

      {isMobile && (
        <div className="mobile-tabbar">
          <button
            className={mobileView === "design" ? "on" : ""}
            aria-haspopup="menu"
            aria-expanded={viewMenu}
            onClick={() => { if (mobileView !== "design") { setMobileView("design"); return; } setViewMenu((v) => !v); }}
          >
            {VIEWS.find((v) => v.id === view)?.label ?? "Design"} ▾
          </button>
          <button className={mobileView === "parts" ? "on" : ""} onClick={() => setMobileView("parts")}>Parts</button>
          <button className={mobileView === "panel" ? "on" : ""} onClick={() => { setMobileView("panel"); if (rightTab === "props") setRightTab("ai"); }}>Assistant</button>
        </div>
      )}
    </div>
  );
}
