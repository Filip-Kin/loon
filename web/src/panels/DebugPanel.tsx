import React, { useEffect, useState } from "react";
import { trpc } from "../trpc";
import type { ProbeInfo, ProbeResult } from "@loon/shared/probe";

export function DebugPanel() {
  const [probes, setProbes] = useState<ProbeInfo[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [pin, setPin] = useState("GPIO17");
  const [chan, setChan] = useState("A0");

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const p = await trpc.probe.list.query();
        if (!alive) return;
        setProbes(p);
        if (!selId && p.length) setSelId(p[0].id);
      } catch { /* server may be busy */ }
    };
    poll();
    const t = setInterval(poll, 2500);
    return () => { alive = false; clearInterval(t); };
  }, [selId]);

  const sel = probes.find((p) => p.id === selId) ?? null;

  function note(s: string) {
    setLog((l) => [`${new Date().toLocaleTimeString()}  ${s}`, ...l].slice(0, 40));
  }

  async function run(cmd: any, label: string) {
    if (!selId) return;
    try {
      const r: ProbeResult = await trpc.probe.execute.mutate({ probeId: selId, command: cmd });
      note(`${label} -> ${r.ok ? JSON.stringify({ value: r.value, volts: r.volts, addrs: r.addrs, samples: r.samples?.length }) : "ERROR " + r.error}`);
    } catch (e: any) {
      note(`${label} -> ${String(e?.message ?? e)}`);
    }
  }

  return (
    <div className="ai">
      <div className="log" style={{ gap: 12 }}>
        {probes.length === 0 && (
          <div className="msg bot">
            No probes connected. Run a probe agent on your hardware and point it at this server:
            <div style={{ fontFamily: "monospace", fontSize: 12, marginTop: 6, color: "var(--text-dim)" }}>
              uv run probe/loon_probe.py --mock
            </div>
          </div>
        )}

        {probes.length > 0 && (
          <select value={selId ?? ""} onChange={(e) => setSelId(e.target.value)}>
            {probes.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.capabilities.board})</option>)}
          </select>
        )}

        {sel && (
          <div style={{ fontSize: 12, lineHeight: 1.6 }}>
            <div style={{ color: "var(--text-dim)" }}>
              logic {sel.capabilities.logicVoltage}V, ADC {sel.capabilities.adc.length}ch, GPIO {sel.capabilities.gpio.length}, I2C {sel.capabilities.i2c ? "yes" : "no"}
            </div>
            {!sel.capabilities.fiveVoltTolerant && (
              <div style={{ color: "var(--warning)", marginTop: 4 }}>
                Not 5V tolerant. Do not connect GPIO to nets above {sel.capabilities.logicVoltage}V without a divider or level shifter.
              </div>
            )}
            {sel.capabilities.notes && <div style={{ color: "var(--text-faint)", marginTop: 4 }}>{sel.capabilities.notes}</div>}

            <div style={{ marginTop: 12, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <input value={pin} onChange={(e) => setPin(e.target.value)} style={{ width: 90 }} />
              <button onClick={() => run({ cmd: "read_pin", pin }, `read ${pin}`)}>Read</button>
              <button onClick={() => run({ cmd: "write_pin", pin, value: 1 }, `${pin}=1`)}>Set 1</button>
              <button onClick={() => run({ cmd: "write_pin", pin, value: 0 }, `${pin}=0`)}>Set 0</button>
            </div>
            <div style={{ marginTop: 6, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <input value={chan} onChange={(e) => setChan(e.target.value)} style={{ width: 90 }} />
              <button onClick={() => run({ cmd: "read_adc", channel: chan }, `read ${chan}`)} disabled={sel.capabilities.adc.length === 0}>Read V</button>
              <button onClick={() => run({ cmd: "i2c_scan" }, "i2c scan")} disabled={!sel.capabilities.i2c}>I2C scan</button>
              <button onClick={() => run({ cmd: "identify" }, "identify")}>Identify</button>
            </div>
          </div>
        )}

        <div style={{ marginTop: 12, fontFamily: "monospace", fontSize: 11, color: "var(--text-dim)", whiteSpace: "pre-wrap" }}>
          {log.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </div>
      <div className="hint">Claude can drive these probes itself through the loon-probe MCP server, reading and sending signals while it reasons about your board.</div>
    </div>
  );
}
