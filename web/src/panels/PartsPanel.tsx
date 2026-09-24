import React, { useMemo, useState } from "react";
import { partMatches, SOURCE_LABELS, ALL_SOURCES, type PartSummary, type PartSource } from "@loon/shared/parts";

interface Props {
  parts: PartSummary[];
  placingLibId: string | null;
  onPick: (libId: string) => void;
}

const SHORT: Record<PartSource, string> = { kicad: "KiCad", digikey: "DigiKey", mouser: "Mouser", oshpark: "OSH Park" };

export function PartsPanel({ parts, placingLibId, onPick }: Props) {
  const [text, setText] = useState("");
  const [require, setRequire] = useState<Set<PartSource>>(new Set());

  const filtered = useMemo(() => {
    const q = { text, requireSources: Array.from(require) };
    return parts.filter((p) => partMatches(p, q));
  }, [parts, text, require]);

  function toggle(src: PartSource) {
    const next = new Set(require);
    next.has(src) ? next.delete(src) : next.add(src);
    setRequire(next);
  }

  return (
    <div className="panel">
      <h3>Parts</h3>
      <div className="search-box">
        <input placeholder="Search parts..." value={text} onChange={(e) => setText(e.target.value)} />
        <div className="filters" title="Show only parts available from every selected source">
          {ALL_SOURCES.map((s) => (
            <span key={s} className={"filter-chip" + (require.has(s) ? " on" : "")} onClick={() => toggle(s)}>
              {SHORT[s]}
            </span>
          ))}
        </div>
      </div>
      <div className="scroll">
        {filtered.length === 0 && <div className="hint">No matches</div>}
        {filtered.map((p) => (
          <div key={p.id} className={"part-row" + (placingLibId === p.libId ? " active" : "")} onClick={() => onPick(p.libId)}>
            <div className="name">{p.name}{p.priceUsd !== undefined && <span className="price">${p.priceUsd.toFixed(2)}</span>}</div>
            <div className="desc">{p.description || p.libId}</div>
            <div className="srcs">
              {ALL_SOURCES.map((s) => {
                const on = p.sources.find((x) => x.source === s)?.available;
                return <span key={s} className={"src-chip" + (on ? " on" : "")}>{SHORT[s]}</span>;
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="hint keys"><span>W wire</span><span>V select</span><span>R rotate</span><span>Del delete</span></div>
    </div>
  );
}
