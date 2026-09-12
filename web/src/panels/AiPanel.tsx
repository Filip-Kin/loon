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
        {!aiAvailable && <div className="msg err">The local claude binary was not found, so the AI assistant is offline. Set LOON_CLAUDE_BIN or install claude.</div>}
        {messages.length === 0 && aiAvailable && (
          <div className="msg bot">Ask for anything on this board: "add a 5V buck off the 24V bus", "write the e-stop firmware and build it", "lay out the PCB and run DRC", "boot the firmware and tell me if the watchdog keeps the latch armed". I edit the schematic, write the code, place the board and run the simulators from here.</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={"msg " + m.role}>{m.text}</div>
        ))}
        {busy && (
          <div className="msg bot">
            {progress ?? "Working..."} {elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}
            {elapsed > 90 && <div style={{ opacity: 0.7, marginTop: 4 }}>A whole-board prompt takes several minutes. This keeps running even if you switch tabs.</div>}
          </div>
        )}
      </div>
      <div className="composer">
        <textarea
          placeholder="Describe what to add or change..."
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
