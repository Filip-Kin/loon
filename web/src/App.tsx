import React, { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "./trpc";
import { Canvas, type Tool, type Viewport } from "./editor/Canvas";
import { PartsPanel } from "./panels/PartsPanel";
import { PropertiesPanel } from "./panels/PropertiesPanel";
import { AiPanel, type ChatMsg } from "./panels/AiPanel";
import { DebugPanel } from "./panels/DebugPanel";
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
  const [aiAvailable, setAiAvailable] = useState(true);
  const [rightTab, setRightTab] = useState<"props" | "ai" | "debug">("ai");
  const [toast, setToast] = useState<{ text: string; err?: boolean } | null>(null);

  const past = useRef<Schematic[]>([]);
  const future = useRef<Schematic[]>([]);

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
      if (list.length > 0) {
        await openProject(list[0].name);
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
    setSchem(res.schem);
    setProjectName(name);
    setSelection(null);
    setProjects(await trpc.project.list.query());
  }

  async function openProject(name: string) {
    const res = await trpc.project.load.query({ name });
    past.current = []; future.current = [];
    setSchem(res.schem);
    setProjectName(name);
    setSelection(null);
  }

  async function save() {
    if (!schem) return;
    try {
      await trpc.project.save.mutate({ name: projectName, schem });
      setProjects(await trpc.project.list.query());
      flash(`Saved ${projectName}.kicad_sch`);
    } catch (e: any) {
      flash(String(e?.message ?? e), true);
    }
  }

  async function aiSend(text: string) {
    if (!schem) return;
    setMessages((m) => [...m, { role: "user", text }]);
    setBusy(true);
    try {
      const res = await trpc.ai.generate.mutate({ message: text, schem });
      if (schem) { past.current.push(schem); future.current = []; }
      setSchem(res.schem as Schematic);
      const failed = res.results.filter((r) => !r.ok);
      let note = res.message || `Applied ${res.ops.length} operation(s).`;
      if (failed.length) note += `\n(${failed.length} failed: ${failed.map((f) => f.error).join("; ")})`;
      setMessages((m) => [...m, { role: "bot", text: note }]);
    } catch (e: any) {
      setMessages((m) => [...m, { role: "err", text: String(e?.message ?? e) }]);
    }
    setBusy(false);
  }

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

  function pickPart(libId: string) {
    setPlacingLibId(libId);
    setTool("place");
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
        <div style={{ width: 1, height: 22, background: "var(--line)" }} />
        <button className={tool === "select" ? "primary" : ""} onClick={() => { setTool("select"); setPlacingLibId(null); }}>Select</button>
        <button className={tool === "wire" ? "primary" : ""} onClick={() => setTool("wire")}>Wire</button>
        {placingLibId && <span className="status">Placing {placingLibId} - click sheet (Esc to stop)</span>}
        <div className="spacer" />
        <button onClick={undo}>Undo</button>
        <button onClick={redo}>Redo</button>
        <span className="status">{schem ? `${schem.symbols.length} parts, ${schem.wires.length} wires` : "loading..."}</span>
      </div>

      <div className="workspace">
        <PartsPanel parts={parts} placingLibId={placingLibId} onPick={pickPart} />

        <div className="canvas-wrap">
          {schem && (
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
            />
          )}
          {toast && <div className={"toast" + (toast.err ? " err" : "")}>{toast.text}</div>}
        </div>

        <div className="panel right">
          <div className="tabs">
            <button className={rightTab === "ai" ? "on" : ""} onClick={() => setRightTab("ai")}>AI</button>
            <button className={rightTab === "props" ? "on" : ""} onClick={() => setRightTab("props")}>Properties</button>
            <button className={rightTab === "debug" ? "on" : ""} onClick={() => setRightTab("debug")}>Debug</button>
          </div>
          {rightTab === "debug" ? (
            <DebugPanel />
          ) : rightTab === "ai" ? (
            <AiPanel messages={messages} busy={busy} aiAvailable={aiAvailable} onSend={aiSend} />
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
    </div>
  );
}
