import React, { useState } from "react";

export interface ChatMsg { role: "user" | "bot" | "err"; text: string }

interface Props {
  messages: ChatMsg[];
  busy: boolean;
  elapsed: number;
  progress: string | null;
  aiAvailable: boolean;
  onSend: (text: string) => void;
}

// The one chat box in the app. It edits the schematic, writes and builds the
// firmware, places the board and runs the simulators, so no other view needs
// its own.
const EXAMPLES = [
  "Add a 5V buck off the 24V bus",
  "Write the e-stop firmware and build it",
  "Lay out the PCB and run DRC",
];

export function AiPanel({ messages, busy, elapsed, progress, aiAvailable, onSend }: Props) {
  const [text, setText] = useState("");
  function send() {
    const t = text.trim();
    if (!t || busy) return;
    onSend(t);
    setText("");
  }
  return (
    <div className="ai">
      <div className="log">
        {!aiAvailable && <div className="msg err">Assistant offline — no claude binary. Set LOON_CLAUDE_BIN.</div>}
        {messages.length === 0 && aiAvailable && (
          <div className="examples">
            <div className="exhead">Examples</div>
            {EXAMPLES.map((e) => (
              <button key={e} onClick={() => setText(e)}>{e}</button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={"msg " + m.role}>{m.text}</div>
        ))}
        {busy && (
          <div className="msg bot">
            {progress ?? "Working…"} {elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}
            {elapsed > 90 && <div style={{ opacity: 0.7, marginTop: 4 }}>Runs in the background</div>}
          </div>
        )}
      </div>
      <div className="composer">
        <textarea
          placeholder="Describe what to add or change"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }}
          disabled={!aiAvailable}
        />
        <button className="primary" onClick={send} disabled={busy || !aiAvailable}>Send</button>
      </div>
    </div>
  );
}
