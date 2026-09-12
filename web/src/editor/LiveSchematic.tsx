import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Schematic, LibSymbol, Point } from "@loon/shared/schematic";
import type { Netlist } from "@loon/shared/netlist";
import type { Level, SimInput } from "@loon/shared/logicsim";
import { instanceBBox, pinWorld } from "@loon/shared/geometry";
import { SymbolView } from "../lib/render";

interface Props {
  schem: Schematic;
  defs: Record<string, LibSymbol>;
  nl: Netlist;
  inputs: SimInput[];
  levelOf: (net: string) => Level;
  onToggle: (input: SimInput) => void;
  onPulse: (input: SimInput) => void;
  probes: string[];
  onProbe: (net: string) => void;
}

const HIGH = "#34d399";
const LOW = "#3f4855";
const FLOAT = "#d8b24a";

function colorOf(level: Level): string {
  return level === 1 ? HIGH : level === 0 ? LOW : FLOAT;
}

// The board under test, drawn as the schematic it is, in the state it is in.
// Wires carry their net's live level, and the parts a person would physically
// press - e-stops, buttons - are pressable where they sit on the sheet.
export function LiveSchematic(props: Props) {
  const { schem, defs, nl, inputs, levelOf } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ x: 40, y: 40, scale: 2.4 });
  const fitted = useRef(false);
  const panning = useRef<{ mx: number; my: number; vx: number; vy: number } | null>(null);
  const [hover, setHover] = useState<{ net: string; at: Point } | null>(null);

  // Where each interactive part sits, so its control lands on top of it.
  const hotspots = useMemo(() => {
    const out: { input: SimInput; at: Point; box: { min: Point; max: Point } }[] = [];
    for (const inst of schem.symbols) {
      const ref = inst.properties.Reference ?? "";
      const input = inputs.find((i) => i.id === ref);
      if (!input) continue;
      const def = defs[inst.libId];
      if (!def) continue;
      const box = instanceBBox(def, { at: inst.at, rotation: inst.rotation, mirror: inst.mirror });
      out.push({ input, at: inst.at, box });
    }
    return out;
  }, [schem, defs, inputs]);

  // The MCU gets its own overlay: the firmware is a part of this board too.
  const mcuSpot = useMemo(() => {
    const inst = schem.symbols.find((s) => s.libId.includes("ESP32"));
    if (!inst) return null;
    const def = defs[inst.libId];
    if (!def) return null;
    return { at: inst.at, box: instanceBBox(def, { at: inst.at, rotation: inst.rotation, mirror: inst.mirror }) };
  }, [schem, defs]);

  // Open on the board, not on empty sheet: fit everything the first time.
  useEffect(() => {
    if (fitted.current || !svgRef.current || schem.symbols.length === 0) return;
    let min = { x: Infinity, y: Infinity };
    let max = { x: -Infinity, y: -Infinity };
    for (const inst of schem.symbols) {
      const def = defs[inst.libId];
      if (!def) continue;
      const b = instanceBBox(def, { at: inst.at, rotation: inst.rotation, mirror: inst.mirror });
      min = { x: Math.min(min.x, b.min.x), y: Math.min(min.y, b.min.y) };
      max = { x: Math.max(max.x, b.max.x), y: Math.max(max.y, b.max.y) };
    }
    if (!isFinite(min.x)) return;
    const r = svgRef.current.getBoundingClientRect();
    const pad = 20;
    const scale = Math.min(12, Math.max(0.4, Math.min(r.width / (max.x - min.x + pad), r.height / (max.y - min.y + pad))));
    setView({ scale, x: r.width / 2 - ((min.x + max.x) / 2) * scale, y: r.height / 2 - ((min.y + max.y) / 2) * scale });
    fitted.current = true;
  }, [schem, defs]);

  function toWorld(e: { clientX: number; clientY: number }): Point {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.scale, y: (e.clientY - r.top - view.y) / view.scale };
  }

  function onWheel(e: React.WheelEvent) {
    const w = toWorld(e);
    const scale = Math.min(24, Math.max(0.5, view.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    const r = svgRef.current!.getBoundingClientRect();
    setView({ scale, x: e.clientX - r.left - w.x * scale, y: e.clientY - r.top - w.y * scale });
  }

  const kick = inputs.find((i) => i.kind === "kick");

  return (
    <div className="liveschem">
      <svg
        ref={svgRef}
        className="livecanvas"
        onWheel={onWheel}
        onMouseDown={(e) => { panning.current = { mx: e.clientX, my: e.clientY, vx: view.x, vy: view.y }; }}
        onMouseMove={(e) => {
          if (panning.current) {
            setView({ ...view, x: panning.current.vx + (e.clientX - panning.current.mx), y: panning.current.vy + (e.clientY - panning.current.my) });
          }
        }}
        onMouseUp={() => { panning.current = null; }}
        onMouseLeave={() => { panning.current = null; setHover(null); }}
      >
        <g transform={`translate(${view.x},${view.y}) scale(${view.scale})`}>
          {/* wires, coloured by what the net is doing right now */}
          {schem.wires.map((w) => {
            const net = nl.netOfWire[w.uuid];
            const lvl = net ? levelOf(net) : "z";
            const lit = net && props.probes.includes(net);
            return (
              <polyline
                key={w.uuid}
                points={w.pts.map((p) => `${p.x},${p.y}`).join(" ")}
                fill="none"
                stroke={colorOf(lvl)}
                strokeWidth={lit ? 0.55 : 0.32}
                opacity={lvl === 1 ? 1 : 0.85}
                vectorEffect="non-scaling-stroke"
                style={{ cursor: "pointer" }}
                onClick={(e) => { e.stopPropagation(); if (net) props.onProbe(net); }}
                onMouseEnter={() => net && setHover({ net, at: w.pts[0] })}
              />
            );
          })}

          {/* net labels double as live readouts */}
          {schem.labels.map((l) => {
            const net = nl.netOfLabel[l.uuid] ?? l.text;
            const lvl = levelOf(net);
            return (
              <g key={l.uuid} style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); props.onProbe(net); }}>
                <circle cx={l.at.x} cy={l.at.y} r={0.62} fill={colorOf(lvl)} />
                <text
                  x={l.at.x + 1}
                  y={l.at.y - 0.6}
                  fontSize={1.5}
                  fill={colorOf(lvl)}
                  stroke="#14151a"
                  strokeWidth={0.5}
                  paintOrder="stroke"
                  strokeLinejoin="round"
                >
                  {l.text}
                </text>
              </g>
            );
          })}

          {schem.symbols.map((inst) => {
            const def = defs[inst.libId];
            if (!def) return null;
            return <SymbolView key={inst.uuid} inst={inst} def={def} selected={false} />;
          })}

          {/* pin dots show their own level, so a part reads at a glance */}
          {schem.symbols.map((inst) => {
            const def = defs[inst.libId];
            if (!def) return null;
            const ref = inst.properties.Reference ?? "";
            return def.pins.map((pin) => {
              const net = nl.netOfPin[`${ref}:${pin.number}`];
              if (!net) return null;
              const at = pinWorld(pin, inst);
              return <circle key={`${inst.uuid}-${pin.number}`} cx={at.x} cy={at.y} r={0.45} fill={colorOf(levelOf(net))} />;
            });
          })}

          {/* the things you can actually press, on top of the part they are */}
          {hotspots.map(({ input, box }) => {
            const on = input.kind === "kick" ? input.alive !== false : !!input.pressed;
            const w = box.max.x - box.min.x;
            const h = box.max.y - box.min.y;
            return (
              <g
                key={input.id}
                style={{ cursor: "pointer" }}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  input.kind === "pin" ? props.onPulse(input) : props.onToggle(input);
                }}
              >
                <rect
                  x={box.min.x - 1.4}
                  y={box.min.y - 1.4}
                  width={w + 2.8}
                  height={h + 2.8}
                  rx={1.2}
                  fill={on ? "rgba(239,68,68,0.22)" : "rgba(16,185,129,0.12)"}
                  stroke={on ? "#ef4444" : "#10b981"}
                  strokeWidth={0.25}
                  vectorEffect="non-scaling-stroke"
                />
                <text
                  x={box.min.x - 1.4}
                  y={box.min.y - 2.2}
                  fontSize={1.5}
                  fill={on ? "#ff9a9a" : "#7fe3bd"}
                  stroke="#14151a"
                  strokeWidth={0.5}
                  paintOrder="stroke"
                  strokeLinejoin="round"
                >
                  {input.kind === "estop" ? (on ? "PRESSED - click to release" : "click to press") : on ? "held" : "click"}
                </text>
              </g>
            );
          })}

          {/* the firmware, shown as part of the board */}
          {mcuSpot && kick && (
            <g style={{ cursor: "pointer" }} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); props.onToggle(kick); }}>
              <rect
                x={mcuSpot.box.min.x - 2}
                y={mcuSpot.box.min.y - 2}
                width={mcuSpot.box.max.x - mcuSpot.box.min.x + 4}
                height={mcuSpot.box.max.y - mcuSpot.box.min.y + 4}
                rx={1.5}
                fill={kick.alive !== false ? "rgba(16,185,129,0.08)" : "rgba(239,68,68,0.2)"}
                stroke={kick.alive !== false ? "#10b981" : "#ef4444"}
                strokeWidth={0.3}
                strokeDasharray="1.5 1"
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={mcuSpot.box.min.x - 2}
                y={mcuSpot.box.min.y - 3}
                fontSize={1.8}
                fill={kick.alive !== false ? "#7fe3bd" : "#ff9a9a"}
                stroke="#14151a"
                strokeWidth={0.6}
                paintOrder="stroke"
                strokeLinejoin="round"
              >
                {kick.alive !== false ? "firmware running - click to kill it" : "FIRMWARE DEAD - click to restart"}
              </text>
            </g>
          )}
        </g>
      </svg>
      {hover && (
        <div className="livehover">
          {hover.net}: {levelOf(hover.net) === "z" ? "floating" : levelOf(hover.net) === 1 ? "HIGH" : "LOW"} · click a wire to scope it
        </div>
      )}
    </div>
  );
}
