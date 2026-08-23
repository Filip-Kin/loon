import React from "react";
import type { SymbolInstance } from "@loon/shared/schematic";

interface Props {
  inst: SymbolInstance | null;
  onSetProp: (uuid: string, key: string, value: string) => void;
  onRotate: (uuid: string) => void;
  onDelete: (uuid: string) => void;
}

export function PropertiesPanel({ inst, onSetProp, onRotate, onDelete }: Props) {
  if (!inst) return <div className="hint">Select a component to edit its properties.</div>;
  const keys = ["Reference", "Value", "Footprint", "Datasheet"];
  return (
    <div>
      <div className="prop-grid">
        <label>Part</label>
        <div style={{ color: "var(--text-dim)" }}>{inst.libId}</div>
        {keys.map((k) => (
          <React.Fragment key={k}>
            <label>{k}</label>
            <input value={inst.properties[k] ?? ""} onChange={(e) => onSetProp(inst.uuid, k, e.target.value)} />
          </React.Fragment>
        ))}
        <label>Rotation</label>
        <div>{inst.rotation}&deg;</div>
        <div className="full" style={{ display: "flex", gap: 8 }}>
          <button onClick={() => onRotate(inst.uuid)}>Rotate 90&deg;</button>
          <button onClick={() => onDelete(inst.uuid)} style={{ borderColor: "var(--error)", color: "#ffb4b4" }}>Delete</button>
        </div>
      </div>
    </div>
  );
}
