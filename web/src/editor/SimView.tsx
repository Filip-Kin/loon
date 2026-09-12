import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Schematic } from "@loon/shared/schematic";
import { buildNetlist } from "@loon/shared/netlist";
import { buildModels, deriveInputs, LogicSim, suggestedWatches, type SimInput, type Level } from "@loon/shared/logicsim";
import { trpc } from "../trpc";

interface Props {
  project: string;
  schem: Schematic | null;
  defs: Record<string, any>;
  flash: (text: string, err?: boolean) => void;
}

const LEVEL_COLOR: Record<string, string> = { "1": "#34d399", "0": "#5b6472", z: "#d8b24a" };

// Three engines, one panel. Logic runs in the browser and is interactive:
// press the e-stop, watch the channels drop. SPICE and QEMU run on the server.
export function SimView({ project, schem, flash }: Props) {
  const [tab, setTab] = useState<"logic" | "spice" | "firmware">("logic");

  return (
    <div className="simwrap">
      <div className="simbar">
        <div className="viewswitch">
          <button className={tab === "logic" ? "on" : ""} onClick={() => setTab("logic")}>Logic</button>
          <button className={tab === "spice" ? "on" : ""} onClick={() => setTab("spice")}>SPICE</button>
          <button className={tab === "firmware" ? "on" : ""} onClick={() => setTab("firmware")}>Firmware</button>
        </div>
        <span className="status">
          {tab === "logic" && "Press the buttons. Nets update as the board would."}
          {tab === "spice" && "ngspice on the real netlist: what the volts do."}
          {tab === "firmware" && "The built binary running on an emulated ESP32-S3."}
        </span>
      </div>
      {tab === "logic" && <LogicPanel schem={schem} />}
      {tab === "spice" && <SpicePanel project={project} schem={schem} flash={flash} />}
      {tab === "firmware" && <FirmwarePanel project={project} flash={flash} />}
    </div>
  );
}

function LogicPanel({ schem }: { schem: Schematic | null }) {
  const [tick, setTick] = useState(0);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<{ t: number; levels: Record<string, Level> }[]>([]);
  const simRef = useRef<LogicSim | null>(null);
  const inputsRef = useRef<SimInput[]>([]);

  const { watches, ready } = useMemo(() => {
    if (!schem) return { watches: [] as string[], ready: false };
    const nl = buildNetlist(schem, (id) => schem.libSymbols[id]);
    const { models } = buildModels(schem, (id) => schem.libSymbols[id], nl);
    const inputs = deriveInputs(models);
    inputsRef.current = inputs;
    simRef.current = new LogicSim(models, inputs);
    return { watches: suggestedWatches(nl), ready: models.length > 0 };
  }, [schem]);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      simRef.current?.step(5);
      setTick((t) => t + 1);
    }, 120);
    return () => clearInterval(id);
  }, [running]);

  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    const snap = sim.snapshot(watches);
    setHistory((h) => [...h.slice(-160), { t: snap.t, levels: snap.levels }]);
  }, [tick, watches]);

  const sim = simRef.current;
  if (!sim || !ready) return <div className="hint">Nothing to simulate yet. Build a circuit first.</div>;
  const snap = sim.snapshot(watches);

  function toggle(input: SimInput) {
    if (input.kind === "kick") input.alive = !input.alive;
    else input.pressed = !input.pressed;
    sim!.step(5);
    setTick((t) => t + 1);
  }

  function pulse(input: SimInput) {
    input.pressed = true;
    sim!.step(5);
    input.pressed = false;
    sim!.step(5);
    setTick((t) => t + 1);
  }

  return (
    <div className="simbody">
      <div className="simcontrols">
        <div className="simhead">Controls</div>
        {inputsRef.current.map((i) => {
          const on = i.kind === "kick" ? i.alive !== false : !!i.pressed;
          const label = i.kind === "kick" ? (on ? "firmware alive" : "firmware dead") : on ? "pressed" : "released";
          return (
            <div key={i.id} className="simctl">
              <div className="lbl">{i.label}</div>
              {i.kind === "pin" ? (
                <button onClick={() => pulse(i)}>Pulse</button>
              ) : (
                <button className={on && i.kind !== "kick" ? "primary" : on ? "" : "primary"} onClick={() => toggle(i)}>
                  {label}
                </button>
              )}
            </div>
          );
        })}
        <div className="simctl">
          <div className="lbl">Time {snap.t}ms</div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => { sim.step(10); setTick((t) => t + 1); }}>Step</button>
            <button className={running ? "primary" : ""} onClick={() => setRunning((r) => !r)}>{running ? "Pause" : "Run"}</button>
            <button onClick={() => { sim.reset(); setHistory([]); setTick((t) => t + 1); }}>Reset</button>
          </div>
        </div>
      </div>

      <div className="simnets">
        <div className="simhead">Nets</div>
        {watches.map((w) => (
          <div key={w} className="netline">
            <span className="name">{w}</span>
            <span className="lvl" style={{ color: LEVEL_COLOR[String(snap.levels[w])] }}>
              {snap.levels[w] === "z" ? "floating" : snap.levels[w] === 1 ? "HIGH" : "LOW"}
            </span>
            <svg className="trace" viewBox={`0 0 ${Math.max(40, history.length)} 10`} preserveAspectRatio="none">
              <polyline
                fill="none"
                stroke={LEVEL_COLOR[String(snap.levels[w])]}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                points={history
                  .map((h, i) => `${i},${h.levels[w] === 1 ? 2 : h.levels[w] === 0 ? 8 : 5}`)
                  .join(" ")}
              />
            </svg>
          </div>
        ))}
      </div>
    </div>
  );
}

function SpicePanel({ project, schem, flash }: { project: string; schem: Schematic | null; flash: (t: string, e?: boolean) => void }) {
  const [probes, setProbes] = useState("EN");
  const [stop, setStop] = useState(0.1);
  const [busy, setBusy] = useState(false);
  const [series, setSeries] = useState<{ name: string; points: { t: number; v: number }[] }[]>([]);
  const [log, setLog] = useState("");
  const [unmodelled, setUnmodelled] = useState<{ ref: string; libId: string }[]>([]);

  async function run() {
    if (!schem) return;
    setBusy(true);
    setSeries([]);
    const probeList = probes.split(",").map((p) => p.trim()).filter(Boolean);
    try {
      const bench = {
        name: "loon bench",
        analysis: "tran" as const,
        tranStop: stop,
        tranStep: stop / 1000,
        sources: [
          { net: "+3V3", kind: "pulse" as const, pulse: { v1: 0, v2: 3.3, delay: 0, rise: 1e-4, fall: 1e-4, width: 10, period: 20 } },
          { net: "+5V", kind: "dc" as const, dc: 5 },
          { net: "+24V", kind: "dc" as const, dc: 24 },
        ],
        probes: probeList,
      };
      const res = await trpc.sim.spice.mutate({ project, schem, bench });
      setUnmodelled(res.unmodelled ?? []);
      for (;;) {
        await new Promise((r) => setTimeout(r, 1200));
        const st: any = await trpc.sim.status.query({ id: res.id, probes: probeList });
        setLog(st.log ?? "");
        if (st.state === "running") continue;
        if (st.state === "error") { flash(st.error ?? "ngspice failed", true); break; }
        setSeries(st.series ?? []);
        break;
      }
    } catch (e: any) {
      flash(String(e?.message ?? e), true);
    }
    setBusy(false);
  }

  const all = series.flatMap((s) => s.points);
  const maxT = Math.max(...all.map((p) => p.t), 1e-6);
  const maxV = Math.max(...all.map((p) => p.v), 1);
  const minV = Math.min(...all.map((p) => p.v), 0);

  return (
    <div className="simbody column">
      <div className="simctlrow">
        <label>Probe nets</label>
        <input value={probes} onChange={(e) => setProbes(e.target.value)} placeholder="EN, WDT_DET" />
        <label>Stop (s)</label>
        <input type="number" step="0.01" value={stop} onChange={(e) => setStop(Number(e.target.value))} style={{ width: 90 }} />
        <button className="primary" onClick={run} disabled={busy || !schem}>{busy ? "Running..." : "Run SPICE"}</button>
      </div>
      {unmodelled.length > 0 && (
        <div className="hint">
          Not simulated (no SPICE model): {unmodelled.slice(0, 6).map((u) => `${u.ref}`).join(", ")}
          {unmodelled.length > 6 ? ` and ${unmodelled.length - 6} more` : ""}. Those parts are left out rather than guessed at.
        </div>
      )}
      {series.length > 0 && (
        <svg className="plot" viewBox="0 0 100 40" preserveAspectRatio="none">
          {series.map((s, i) => (
            <polyline
              key={s.name}
              fill="none"
              stroke={["#34d399", "#4ea1ff", "#d8b24a", "#ff7ab6"][i % 4]}
              strokeWidth={0.4}
              vectorEffect="non-scaling-stroke"
              points={s.points.map((p) => `${(p.t / maxT) * 100},${38 - ((p.v - minV) / (maxV - minV || 1)) * 36}`).join(" ")}
            />
          ))}
        </svg>
      )}
      {series.length > 0 && (
        <div className="hint">
          {series.map((s) => `${s.name}: ends at ${(s.points[s.points.length - 1]?.v ?? 0).toFixed(2)}V`).join(" · ")} · full scale {maxV.toFixed(1)}V over {maxT.toFixed(3)}s
        </div>
      )}
      {log && <pre className="buildlog">{log.slice(-4000)}</pre>}
    </div>
  );
}

function FirmwarePanel({ project, flash }: { project: string; flash: (t: string, e?: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");

  async function run() {
    setBusy(true);
    setLog("");
    try {
      const { id } = await trpc.sim.qemu.mutate({ project, seconds: 15 });
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const st: any = await trpc.sim.status.query({ id });
        setLog(st.log ?? "");
        if (st.state === "running") continue;
        if (st.state === "error") flash(st.error ?? "emulation failed", true);
        break;
      }
    } catch (e: any) {
      flash(String(e?.message ?? e), true);
    }
    setBusy(false);
  }

  return (
    <div className="simbody column">
      <div className="simctlrow">
        <button className="primary" onClick={run} disabled={busy}>{busy ? "Emulating..." : "Run firmware in QEMU"}</button>
        <span className="status">Boots the real ROM, bootloader and app image. Serial appears below.</span>
      </div>
      <div className="hint">
        Known gap: the prebuilt Arduino libraries for the ESP32-S3 send their console to USB-Serial-JTAG, which the
        emulator does not model, so an Arduino sketch asserts in startup after the bootloader runs. Board-level behaviour
        (e-stop, latch, channels) is what the Logic tab is for; this tab is honest about where emulation stops.
      </div>
      <pre className="buildlog tall">{log || "No run yet."}</pre>
    </div>
  );
}
