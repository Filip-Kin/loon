import React, { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "./trpc";
import { Canvas, type Tool, type Viewport } from "./editor/Canvas";
import { BlockCanvas } from "./editor/BlockCanvas";
import { CodeView } from "./editor/CodeView";
import { PcbCanvas } from "./editor/PcbCanvas";
import { SimView } from "./editor/SimView";
import type { GraphBlock } from "@loon/shared/blockgraph";
import { PartsPanel } from "./panels/PartsPanel";
import { PropertiesPanel } from "./panels/PropertiesPanel";
import { AiPanel, type ChatMsg } from "./panels/AiPanel";
import { DebugPanel } from "./panels/DebugPanel";
import { CheckPanel } from "./panels/CheckPanel";
import type { ErcIssue } from "@loon/shared/erc";
import { makeClientResolver } from "./lib/resolver";
import { applyOps } from "@loon/shared/apply-ops";
import type { Schematic, LibSymbol, Point } from "@loon/shared/schematic";
import type { Op, PinRef } from "@loon/shared/ops";
import type { PartSummary } from "@loon/shared/parts";
import type { ProjectMeta } from "../../server/src/services/storage";

export function App() {
  const [parts, setParts] = useState<PartSummary[]>([]);
  const [defs, setDefs] = useState<Record<string, LibSymbol>>({});
  const [schem, setSchem] = useState<Schematic | null>(null);
  const [projectName, setProjectName] = useState<string>("untitled");
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [selection, setSelection] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [placingLibId, setPlacingLibId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: -320, y: -260, scale: 5 });
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [aiAvailable, setAiAvailable] = useState(true);
  const [rightTab, setRightTab] = useState<"props" | "ai" | "debug" | "check">("ai");
  const [issues, setIssues] = useState<ErcIssue[]>([]);
  const [nets, setNets] = useState<{ name: string; isPower: boolean; pins: string[] }[]>([]);
  const [checking, setChecking] = useState(false);
  const [highlightNet, setHighlightNet] = useState<string | null>(null);
  const [view, setView] = useState<"schematic" | "blocks" | "pcb" | "code" | "sim">("schematic");
  const [blockSel, setBlockSel] = useState<string | null>(null);
  const [blockViewport, setBlockViewport] = useState<Viewport>({ x: 40, y: 40, scale: 1.6 });
  const [toast, setToast] = useState<{ text: string; err?: boolean } | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 820px)").matches);
  const [mobileView, setMobileView] = useState<"design" | "parts" | "panel">("design");

  const past = useRef<Schematic[]>([]);
  const future = useRef<Schematic[]>([]);
  // Autosave bookkeeping. skipAutosave suppresses the save that would
  // otherwise fire the moment a project is opened, which would rewrite the
  // file with what we just read.
  const skipAutosave = useRef(true);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(false);
  const pendingSave = useRef(false);
  const latest = useRef<{ name: string; schem: Schematic | null }>({ name: "untitled", schem: null });

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

  async function openProject(name: string) {
    const res = await trpc.project.load.query({ name });
    past.current = []; future.current = [];
    skipAutosave.current = true;
    setSaveState("saved");
    localStorage.setItem("loon.lastProject", name);
    setSchem(res.schem);
    setProjectName(name);
    setSelection(null);
  }

  async function save() {
    if (!schem) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    try {
      setSaveState("saving");
      await trpc.project.save.mutate({ name: projectName, schem });
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
      const { id } = await trpc.ai.start.mutate({ message: text, schem });
      let res: any = null;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const st: any = await trpc.ai.status.query({ id });
        if (st.state === "running") continue;
        if (st.state === "error") throw new Error(st.error ?? "generation failed");
        res = st;
        break;
      }
      if (schem) { past.current.push(schem); future.current = []; }
      setSchem(res.schem as Schematic);
      const failed = (res.results ?? []).filter((r: any) => !r.ok);
      let note = res.message || `Applied ${(res.ops ?? []).length} operation(s).`;
      if (failed.length) note += `\n(${failed.length} failed: ${failed.map((f: any) => f.error).join("; ")})`;
      setMessages((m) => [...m, { role: "bot", text: note }]);
    } catch (e: any) {
      setMessages((m) => [...m, { role: "err", text: String(e?.message ?? e) }]);
    }
    clearInterval(tick);
    setBusy(false);
  }

  // #region checks
  async function runCheck() {
    if (!schem) return;
    setChecking(true);
    try {
      const res = await trpc.design.check.query({ schem });
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
    latest.current = { name: projectName, schem };
    if (!schem) return;
    if (skipAutosave.current) { skipAutosave.current = false; return; }
    setSaveState("dirty");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { autosave(); }, 900);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [schem, projectName]);

  async function autosave() {
    const { name, schem: cur } = latest.current;
    if (!cur) return;
    if (saving.current) { pendingSave.current = true; return; }
    saving.current = true;
    setSaveState("saving");
    try {
      await trpc.project.save.mutate({ name, schem: cur });
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
      const body = JSON.stringify({ 0: { name: latest.current.name, schem: latest.current.schem } });
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
      if (e.key === "Escape") { setTool("select"); setPlacingLibId(null); return; }
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
    const mq = window.matchMedia("(max-width: 820px)");
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  function pickPart(libId: string) {
    setPlacingLibId(libId);
    setTool("place");
    if (isMobile) setMobileView("design"); // jump to the sheet to drop the part
  }

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">loon<span>.</span></div>
        <select value={projectName} onChange={(e) => openProject(e.target.value)}>
          {projects.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          {!projects.find((p) => p.name === projectName) && <option value={projectName}>{projectName}</option>}
        </select>
        <button onClick={() => { const n = prompt("New project name", "untitled"); if (n) newProject(n); }}>New</button>
        <button onClick={save}>Save</button>
        <span className={"savestate " + saveState} title={savedAt ? `Last saved ${new Date(savedAt).toLocaleTimeString()}` : "Not saved yet"}>
          {saveState === "saving" ? "Saving..." : saveState === "dirty" ? "Unsaved" : saveState === "error" ? "Save failed" : savedAt ? `Saved ${new Date(savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Saved"}
        </span>
        <div className="desktop-only" style={{ width: 1, height: 22, background: "var(--line)" }} />
        <div className="viewswitch">
          <button className={view === "blocks" ? "on" : ""} onClick={() => setView("blocks")}>Blocks</button>
          <button className={view === "schematic" ? "on" : ""} onClick={() => setView("schematic")}>Schematic</button>
          <button className={view === "pcb" ? "on" : ""} onClick={() => setView("pcb")}>PCB</button>
          <button className={view === "code" ? "on" : ""} onClick={() => setView("code")}>Code</button>
          <button className={view === "sim" ? "on" : ""} onClick={() => setView("sim")}>Simulate</button>
        </div>
        {view === "schematic" && <button className={"desktop-only " + (tool === "select" ? "primary" : "")} onClick={() => { setTool("select"); setPlacingLibId(null); }}>Select</button>}
        {view === "schematic" && <button className={"desktop-only " + (tool === "wire" ? "primary" : "")} onClick={() => setTool("wire")}>Wire</button>}
        {placingLibId && <span className="status">Placing {placingLibId}{isMobile ? " - tap sheet" : " - click sheet (Esc to stop)"}</span>}
        <div className="spacer" />
        <button className="desktop-only" onClick={undo}>Undo</button>
        <button className="desktop-only" onClick={redo}>Redo</button>
        <span className="status desktop-only">{schem ? `${schem.symbols.length} parts, ${schem.wires.length} wires` : "loading..."}</span>
      </div>

      <div className={"workspace" + (isMobile ? " mobile" : "")} data-view={mobileView}>
        <PartsPanel parts={parts} placingLibId={placingLibId} onPick={pickPart} />

        <div className="canvas-wrap">
          {view === "code" && <CodeView project={projectName} schem={schem} flash={flash} />}
          {view === "pcb" && <PcbCanvas project={projectName} schem={schem} flash={flash} />}
          {view === "sim" && <SimView project={projectName} schem={schem} defs={renderDefs} flash={flash} />}
          {schem && view === "blocks" && (
            <BlockCanvas
              schem={schem}
              defs={renderDefs}
              viewport={blockViewport}
              setViewport={setBlockViewport}
              selection={blockSel}
              onSelect={setBlockSel}
              onOps={(ops) => applyLocal(ops)}
              onDrillIn={(b: GraphBlock) => {
                // Drill in: jump to the schematic centred on the block.
                setView("schematic");
                const cx = (b.box.min.x + b.box.max.x) / 2;
                const cy = (b.box.min.y + b.box.max.y) / 2;
                const scale = 4;
                setViewport({ scale, x: window.innerWidth / 2 - cx * scale, y: window.innerHeight / 2 - cy * scale });
                setSelection(b.memberUuids[0] ?? null);
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
            <AiPanel messages={messages} busy={busy} elapsed={elapsed} aiAvailable={aiAvailable} onSend={aiSend} />
          ) : (
            <PropertiesPanel
              inst={selInst}
              onSetProp={(uuid, key, value) => applyLocal([{ op: "set_property", uuid, key, value }])}
              onRotate={(uuid) => { const inst = schem?.symbols.find((s) => s.uuid === uuid); if (inst) applyLocal([{ op: "move_symbol", uuid, at: inst.at, rotation: (inst.rotation + 90) % 360 }]); }}
              onDelete={(uuid) => { applyLocal([{ op: "delete", uuid }]); setSelection(null); }}
            />
          )}
        </div>
      </div>

      {isMobile && (
        <div className="mobile-tabbar">
          <button className={mobileView === "design" ? "on" : ""} onClick={() => setMobileView("design")}>Design</button>
          <button className={mobileView === "parts" ? "on" : ""} onClick={() => setMobileView("parts")}>Parts</button>
          <button className={mobileView === "panel" ? "on" : ""} onClick={() => { setMobileView("panel"); if (rightTab === "props") setRightTab("ai"); }}>Assistant</button>
        </div>
      )}
    </div>
  );
}
