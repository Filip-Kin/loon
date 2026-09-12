import React from "react";
import type { ErcIssue } from "@loon/shared/erc";

interface Props {
  issues: ErcIssue[];
  nets: { name: string; isPower: boolean; pins: string[] }[];
  busy: boolean;
  onRefresh: () => void;
  onSelectNet: (name: string) => void;
  highlight: string | null;
}

export function CheckPanel({ issues, nets, busy, onRefresh, onSelectNet, highlight }: Props) {
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return (
    <div className="check">
      <div className="check-head">
        <span className={"pill " + (errors.length ? "bad" : "good")}>{errors.length} errors</span>
        <span className="pill warn">{warnings.length} warnings</span>
        <span className="pill">{nets.length} nets</span>
        <button onClick={onRefresh} disabled={busy}>{busy ? "Checking..." : "Re-check"}</button>
      </div>
      <div className="scroll">
        {issues.length === 0 && <div className="hint">No rule violations. Nets look connected.</div>}
        {issues.map((i, n) => (
          <div key={n} className={"issue " + i.severity} onClick={() => i.net && onSelectNet(i.net)}>
            <div className="rule">{i.rule}</div>
            <div className="msg">{i.message}</div>
          </div>
        ))}
        <div className="nets-head">Nets</div>
        {nets.map((n) => (
          <div
            key={n.name}
            className={"net-row" + (highlight === n.name ? " on" : "") + (n.isPower ? " power" : "")}
            onClick={() => onSelectNet(n.name)}
          >
            <span className="name">{n.name}</span>
            <span className="count">{n.pins.length}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
