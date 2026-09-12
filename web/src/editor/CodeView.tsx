import React, { useEffect, useMemo, useRef, useState } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { cpp } from "@codemirror/lang-cpp";
import { oneDark } from "@codemirror/theme-one-dark";
import { trpc } from "../trpc";
import type { Schematic } from "@loon/shared/schematic";
import { flashBoard, type FlashProgress } from "../lib/flash";

interface Props {
  project: string;
  schem: Schematic | null;
  flash: (text: string, err?: boolean) => void;
}

interface FileMeta { path: string; size: number; updated: number }

// The code view: files on the left, editor in the middle, and the two buttons
// that matter - build in a container on the server, then flash over USB from
// the browser. The pin header is generated from the schematic, never typed.
export function CodeView({ project, schem, flash }: Props) {
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState("");
  const [artifacts, setArtifacts] = useState<{ path: string; offset: number }[] | null>(null);
  const [progress, setProgress] = useState<FlashProgress | null>(null);
  const [ask, setAsk] = useState("");
  const [askLog, setAskLog] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  const canFlash = typeof navigator !== "undefined" && "serial" in navigator;

  async function refreshFiles() {
    try {
      const list = await trpc.firmware.files.query({ project });
      setFiles(list);
      if (!path && list.length) openFile(list.find((f) => f.path.endsWith("main.cpp"))?.path ?? list[0].path);
      return list;
    } catch (e: any) {
      flash(String(e?.message ?? e), true);
      return [];
    }
  }

  // Opening the code view on a board with no firmware scaffolds it: the pin
  // header, platformio.ini and a starter main.cpp, all from the schematic.
  useEffect(() => {
    (async () => {
      const list = await refreshFiles();
      if (list.length === 0 && schem && schem.symbols.length > 0) await sync();
    })();
  }, [project, schem]);

  async function openFile(p: string) {
    try {
      const { text } = await trpc.firmware.read.query({ project, path: p });
      setPath(p);
      setDirty(false);
      if (viewRef.current) {
        viewRef.current.dispatch({ changes: { from: 0, to: viewRef.current.state.doc.length, insert: text } });
      }
    } catch (e: any) {
      flash(String(e?.message ?? e), true);
    }
  }

  useEffect(() => {
    if (!host.current || viewRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: "",
        extensions: [
          basicSetup,
          cpp(),
          oneDark,
          EditorView.updateListener.of((u) => { if (u.docChanged) setDirty(true); }),
          EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { fontFamily: "ui-monospace, monospace", fontSize: "12.5px" } }),
        ],
      }),
      parent: host.current,
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
  }, []);

  async function save() {
    if (!path || !viewRef.current) return;
    await trpc.firmware.write.mutate({ project, path, text: viewRef.current.state.doc.toString() });
    setDirty(false);
    flash(`Saved ${path}`);
  }

  // Regenerate board_pins.h from the sheet, scaffolding the project if new.
  async function sync() {
    if (!schem) return;
    setBusy("sync");
    try {
      const res = await trpc.firmware.sync.mutate({ project, schem });
      flash(res.message ?? "Synced");
      await refreshFiles();
      if (path) await openFile(path);
    } catch (e: any) {
      flash(String(e?.message ?? e), true);
    }
    setBusy(null);
  }

  async function build() {
    if (dirty) await save();
    setBusy("build");
    setLog("");
    setArtifacts(null);
    try {
      const { id } = await trpc.firmware.build.mutate({ project });
      for (;;) {
        await new Promise((r) => setTimeout(r, 1200));
        const st: any = await trpc.firmware.buildStatus.query({ id });
        setLog(st.log ?? "");
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
        if (st.state === "running") continue;
        if (st.state === "error") { flash(st.error ?? "Build failed", true); break; }
        setArtifacts(st.artifacts ?? []);
        flash("Build finished");
        break;
      }
    } catch (e: any) {
      flash(String(e?.message ?? e), true);
    }
    setBusy(null);
  }

  async function doFlash() {
    if (!artifacts?.length) return;
    setBusy("flash");
    try {
      await flashBoard(project, artifacts, setProgress);
      flash("Flashed. The board is running your firmware.");
    } catch (e: any) {
      flash(String(e?.message ?? e), true);
    }
    setBusy(null);
    setProgress(null);
  }

  // Ask the assistant to write firmware. It gets the pin map and the netlist,
  // so it writes against the board that exists rather than a guessed pinout.
  async function askAi() {
    const text = ask.trim();
    if (!text || !schem) return;
    setBusy("ai");
    setAskLog("Working...");
    setAsk("");
    try {
      const { id } = await trpc.firmware.aiStart.mutate({ project, message: text, schem });
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const st: any = await trpc.ai.status.query({ id });
        if (st.state === "running") continue;
        if (st.state === "error") throw new Error(st.error ?? "failed");
        setAskLog(st.message ?? "done");
        await refreshFiles();
        if (path) await openFile(path);
        break;
      }
    } catch (e: any) {
      setAskLog(String(e?.message ?? e));
      flash(String(e?.message ?? e), true);
    }
    setBusy(null);
  }

  const tree = useMemo(() => files.slice().sort((a, b) => a.path.localeCompare(b.path)), [files]);

  return (
    <div className="codeview">
      <div className="codebar">
        <button onClick={sync} disabled={!!busy || !schem}>{busy === "sync" ? "Syncing..." : "Sync pins from schematic"}</button>
        <button onClick={save} disabled={!dirty || !path}>Save{dirty ? " *" : ""}</button>
        <button className="primary" onClick={build} disabled={!!busy}>{busy === "build" ? "Building..." : "Build"}</button>
        <button onClick={doFlash} disabled={!!busy || !artifacts?.length || !canFlash}>
          {busy === "flash" ? `Flashing ${progress ? Math.round(progress.percent) : 0}%` : "Flash over USB"}
        </button>
        {!canFlash && <span className="status">Flashing needs WebSerial: Chrome or Edge, not Safari or Firefox.</span>}
        <span className="spacer" />
        <span className="status">{path ?? "no file"}</span>
      </div>
      <div className="codebody">
        <div className="filetree">
          {tree.length === 0 && <div className="hint">No firmware yet. Press "Sync pins from schematic" to scaffold it.</div>}
          {tree.map((f) => (
            <div key={f.path} className={"file-row" + (f.path === path ? " on" : "")} onClick={() => openFile(f.path)}>
              {f.path}
            </div>
          ))}
        </div>
        <div className="editorhost" ref={host} />
      </div>
      <div className="askbar">
        <input
          placeholder="Ask for firmware: 'write the e-stop logic with the watchdog kick'"
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") askAi(); }}
          disabled={busy === "ai"}
        />
        <button onClick={askAi} disabled={!!busy || !schem}>{busy === "ai" ? "Writing..." : "Write it"}</button>
        {askLog && <span className="status">{askLog}</span>}
      </div>
      {(log || busy === "build") && (
        <pre className="buildlog" ref={logRef}>{log || "starting build..."}</pre>
      )}
    </div>
  );
}
