import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Schematic, LibSymbol } from "@loon/shared/schematic";
import { buildNetlist } from "@loon/shared/netlist";
import { buildModels, deriveInputs, LogicSim, suggestedWatches, type SimInput, type Level } from "@loon/shared/logicsim";
import { LiveSchematic } from "./LiveSchematic";
import { trpc } from "../trpc";

interface Props {
  project: string;
  schem: Schematic | null;
  defs: Record<string, LibSymbol>;
  flash: (text: string, err?: boolean) => void;
}

const LEVEL_COLOR: Record<string, string> = { "1": "#34d399", "0": "#5b6472", z: "#d8b24a" };
// How long the emulated firmware can go quiet before the watchdog gives up on
// it. The hardware latch uses its own RC; this is the serial-side equivalent.
const SERIAL_TIMEOUT_MS = 2500;

// One bench, not three. The board is drawn live, the buttons are on the parts,
// the emulated firmware is wired into the same watchdog the hardware watches,
// and SPICE plots whatever net you clicked. Killing the firmware in the console
// trips the latch on the schematic, which is the whole point.
export function SimView({ project, schem, defs, flash }: Props) {
  const [tick, setTick] = useState(0);
  const [running, setRunning] = useState(true);
  const [probes, setProbes] = useState<string[]>([]);
  const [history, setHistory] = useState<{ t: number; levels: Record<string, Level> }[]>([]);
  const [serial, setSerial] = useState("");
  const [qemuState, setQemuState] = useState<"idle" | "running" | "stopped">("idle");
  const [coupled, setCoupled] = useState(true);
  const [spice, setSpice] = useState<{ name: string; points: { t: number; v: number }[] }[]>([]);
  const [spiceBusy, setSpiceBusy] = useState(false);
  const [spiceNote, setSpiceNote] = useState("");
  const simRef = useRef<LogicSim | null>(null);
  const inputsRef = useRef<SimInput[]>([]);
  const lastSerial = useRef<{ len: number; at: number; kickAt: number; sawKick: boolean; panicked: boolean }>({
    len: 0,
    at: 0,
    kickAt: 0,
    sawKick: false,
    panicked: false,
  });
  const serialRef = useRef<HTMLPreElement>(null);

  const { nl, watches, ready } = useMemo(() => {
    if (!schem) return { nl: null, watches: [] as string[], ready: false };
    const resolver = (id: string) => defs[id] ?? schem.libSymbols[id];
    const netlist = buildNetlist(schem, resolver);
    const { models } = buildModels(schem, resolver, netlist);
    const inputs = deriveInputs(models);
    inputsRef.current = inputs;
    simRef.current = new LogicSim(models, inputs);
    return { nl: netlist, watches: suggestedWatches(netlist), ready: models.length > 0 };
  }, [schem, defs]);

  useEffect(() => {
    if (probes.length === 0 && watches.length) setProbes(watches.slice(0, 5));
  }, [watches]);

  // The clock. Everything else reacts to it.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      simRef.current?.step(5);
      setTick((t) => t + 1);
    }, 100);
    return () => clearInterval(id);
  }, [running]);

  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    const snap = sim.snapshot([...new Set([...watches, ...probes])]);
    setHistory((h) => [...h.slice(-240), { t: snap.t, levels: snap.levels }]);
  }, [tick]);

  // #region firmware in the loop
  // While the emulated firmware keeps printing, the watchdog stays fed. When it
  // crashes or stops, the kick stops with it and the hardware latch trips - the
  // same chain the real board has, with the real binary driving it.
  async function startFirmware() {
    setSerial("");
    setQemuState("running");
    lastSerial.current = { len: 0, at: Date.now(), kickAt: Date.now(), sawKick: false, panicked: false };
    try {
      const { id } = await trpc.sim.qemu.mutate({ project, seconds: 45 });
      for (;;) {
        await new Promise((r) => setTimeout(r, 900));
        const st: any = await trpc.sim.status.query({ id });
        const log: string = st.log ?? "";
        if (log.length !== lastSerial.current.len) {
          // A crash loop prints plenty, so output alone is not liveness. The
          // watchdog is fed by the firmware's own heartbeat line, and a panic
          // kills it outright.
          const fresh = log.slice(lastSerial.current.len);
          lastSerial.current.len = log.length;
          lastSerial.current.at = Date.now();
          if (/\bKICK\b/i.test(fresh)) {
            lastSerial.current.kickAt = Date.now();
            lastSerial.current.sawKick = true;
          }
          if (/assert failed|Guru Meditation|Rebooting\.\.\.|panic'ed/i.test(fresh)) lastSerial.current.panicked = true;
        }
        setSerial(log);
        if (serialRef.current) serialRef.current.scrollTop = serialRef.current.scrollHeight;
        if (st.state === "running") continue;
        setQemuState("stopped");
        if (st.state === "error") flash(st.error ?? "emulation failed", true);
        break;
      }
    } catch (e: any) {
      setQemuState("stopped");
      flash(String(e?.message ?? e), true);
    }
  }

  useEffect(() => {
    if (!coupled) return;
    const kick = inputsRef.current.find((i) => i.kind === "kick");
    if (!kick) return;
    if (qemuState === "idle") return;
    const s = lastSerial.current;
    // Prefer the explicit heartbeat; fall back to any output only while the
    // firmware has never printed one.
    const since = s.sawKick ? Date.now() - s.kickAt : Date.now() - s.at;
    const aliveNow = qemuState === "running" && !s.panicked && since <= SERIAL_TIMEOUT_MS;
    if (kick.alive !== aliveNow) {
      kick.alive = aliveNow;
      simRef.current?.step(5);
      setTick((t) => t + 1);
    }
  }, [tick, qemuState, coupled]);

  async function runSpice() {
    if (!schem || probes.length === 0) return;
    setSpiceBusy(true);
    setSpice([]);
    try {
      const bench = {
        name: "bench",
        analysis: "tran" as const,
        tranStop: 0.1,
        tranStep: 0.0001,
        sources: [
          { net: "+3V3", kind: "pulse" as const, pulse: { v1: 0, v2: 3.3, delay: 0, rise: 1e-4, fall: 1e-4, width: 10, period: 20 } },
          { net: "+5V", kind: "dc" as const, dc: 5 },
          { net: "+24V", kind: "dc" as const, dc: 24 },
        ],
        probes,
      };
      const res = await trpc.sim.spice.mutate({ project, schem, bench });
      setSpiceNote(res.unmodelled?.length ? `${res.unmodelled.length} parts have no SPICE model and were left out` : "");
      for (;;) {
        await new Promise((r) => setTimeout(r, 1100));
        const st: any = await trpc.sim.status.query({ id: res.id, probes });
        if (st.state === "running") continue;
        if (st.state === "error") { flash(st.error ?? "ngspice failed", true); break; }
        setSpice(st.series ?? []);
        break;
      }
    } catch (e: any) {
      flash(String(e?.message ?? e), true);
    }
    setSpiceBusy(false);
  }

  const sim = simRef.current;
  if (!schem || !sim || !ready || !nl) {
    return <div className="simwrap"><div className="hint">Nothing to simulate yet. Build a circuit first.</div></div>;
  }
  const snap = sim.snapshot([...new Set([...watches, ...probes])]);

  function toggle(input: SimInput) {
    if (input.kind === "kick") {
      // Killing the firmware by hand takes it out of the emulator's control,
      // otherwise the next poll would just bring it back.
      setCoupled(false);
      input.alive = input.alive === false;
    } else input.pressed = !input.pressed;
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

  const armInput = inputsRef.current.find((i) => i.id === "ARM");
  const kick = inputsRef.current.find((i) => i.kind === "kick");
  const allPoints = spice.flatMap((s) => s.points);
  const maxT = Math.max(...allPoints.map((p) => p.t), 1e-6);
  const maxV = Math.max(...allPoints.map((p) => p.v), 1);
  const minV = Math.min(...allPoints.map((p) => p.v), 0);

  return (
    <div className="simwrap">
      <div className="simbar">
        <button className={running ? "primary" : ""} onClick={() => setRunning((r) => !r)}>{running ? "Pause" : "Run"}</button>
        <button onClick={() => { sim.step(10); setTick((t) => t + 1); }}>Step</button>
        <button onClick={() => { sim.reset(); setHistory([]); setCoupled(true); setTick((t) => t + 1); }}>Reset board</button>
        {armInput && <button onClick={() => pulse(armInput)}>Arm latch</button>}
        <div className="sep" />
        <button className={qemuState === "running" ? "primary" : ""} onClick={startFirmware} disabled={qemuState === "running"}>
          {qemuState === "running" ? "Firmware running" : "Start firmware (QEMU)"}
        </button>
        <button onClick={runSpice} disabled={spiceBusy || probes.length === 0}>{spiceBusy ? "SPICE running..." : `Run SPICE on ${probes.length} net(s)`}</button>
        <div className="spacer" />
        <span className="status">
          t={snap.t}ms · firmware {kick?.alive !== false ? "alive" : "dead"}
          {coupled && qemuState !== "idle" ? " (driven by the emulator)" : ""}
        </span>
      </div>

      <div className="simsplit">
        <LiveSchematic
          schem={schem}
          defs={defs}
          nl={nl}
          inputs={inputsRef.current}
          levelOf={(net) => sim.level(net)}
          onToggle={toggle}
          onPulse={pulse}
          probes={probes}
          onProbe={(net) => setProbes((p) => (p.includes(net) ? p.filter((x) => x !== net) : [...p, net]))}
        />

        <div className="simdock">
          <div className="dockpane">
            <div className="simhead">
              Firmware console
              <span className={"pill " + (qemuState === "running" ? "good" : qemuState === "stopped" ? "bad" : "")}>
                {qemuState === "idle" ? "not started" : qemuState}
              </span>
              {!coupled && <button onClick={() => { setCoupled(true); setTick((t) => t + 1); }}>Re-couple</button>}
              {coupled && qemuState !== "idle" && (
                <span className="status">
                  {lastSerial.current.panicked
                    ? "panic seen - watchdog starved"
                    : lastSerial.current.sawKick
                      ? "heartbeat: KICK"
                      : "no KICK line yet, using any output"}
                </span>
              )}
            </div>
            <pre className="buildlog" ref={serialRef}>
              {serial ||
                "Press Start firmware. The emulated chip's serial appears here, and every KICK line it prints feeds the board's watchdog. Stop the firmware and the latch trips on the schematic. The emulator runs the classic ESP32: the S3's Arduino console is USB-only and QEMU has no USB."}
            </pre>
          </div>

          <div className="dockpane">
            <div className="simhead">
              Scope
              <span className="status">{probes.join(", ") || "click a wire to probe it"}</span>
            </div>
            <div className="scopebody">
              {probes.map((w) => (
                <div key={w} className="netline">
                  <span className="name">{w}</span>
                  <span className="lvl" style={{ color: LEVEL_COLOR[String(snap.levels[w])] }}>
                    {snap.levels[w] === "z" ? "float" : snap.levels[w] === 1 ? "HIGH" : "LOW"}
                  </span>
                  <svg className="trace" viewBox={`0 0 ${Math.max(60, history.length)} 10`} preserveAspectRatio="none">
                    <polyline
                      fill="none"
                      stroke={LEVEL_COLOR[String(snap.levels[w])]}
                      strokeWidth={1}
                      vectorEffect="non-scaling-stroke"
                      points={history.map((h, i) => `${i},${h.levels[w] === 1 ? 2 : h.levels[w] === 0 ? 8 : 5}`).join(" ")}
                    />
                  </svg>
                </div>
              ))}
              {spice.length > 0 && (
                <>
                  <div className="simhead">SPICE (analog)</div>
                  <svg className="plot" viewBox="0 0 100 40" preserveAspectRatio="none">
                    {spice.map((s, i) => (
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
                  <div className="hint">
                    {spice.map((s) => `${s.name} ends at ${(s.points[s.points.length - 1]?.v ?? 0).toFixed(2)}V`).join(" · ")}
                    {spiceNote ? ` · ${spiceNote}` : ""}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
