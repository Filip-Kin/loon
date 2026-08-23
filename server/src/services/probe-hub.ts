// #region Probe hub
// Manages probe agents that dial in over WebSocket. Keeps a registry of live
// probes, correlates command/response pairs, and holds each probe's assignment
// plan (which channel maps to which schematic net/pin). The Bun WebSocket
// handlers in index.ts delegate here.

import type { ServerWebSocket } from "bun";
import type { AgentToServer, ProbeCommand, ProbeResult, ProbeInfo, ProbeAssignment } from "@loon/shared/probe";

export interface ProbeSocketData {
  probeId?: string;
}

interface Pending {
  resolve: (r: ProbeResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

class ProbeHub {
  private byId = new Map<string, { ws: ServerWebSocket<ProbeSocketData>; info: ProbeInfo }>();
  private pending = new Map<string, Pending>();
  private assignments = new Map<string, ProbeAssignment[]>();
  private readonly token = process.env.LOON_PROBE_TOKEN || "loon-dev";

  onMessage(ws: ServerWebSocket<ProbeSocketData>, raw: string) {
    let msg: AgentToServer;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "register") {
      if (msg.token !== this.token) {
        ws.send(JSON.stringify({ type: "error", text: "bad token" }));
        ws.close();
        return;
      }
      const probeId = crypto.randomUUID();
      ws.data.probeId = probeId;
      const info: ProbeInfo = { id: probeId, name: msg.name, connectedAt: Date.now(), capabilities: msg.capabilities };
      this.byId.set(probeId, { ws, info });
      ws.send(JSON.stringify({ type: "registered", probeId }));
      console.log(`[probe] registered ${msg.name} (${info.capabilities.board}) as ${probeId}`);
    } else if (msg.type === "result") {
      const p = this.pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        p.resolve(msg.result);
      }
    } else if (msg.type === "event") {
      console.log(`[probe] ${msg.level}: ${msg.text}`);
    }
  }

  onClose(ws: ServerWebSocket<ProbeSocketData>) {
    const id = ws.data?.probeId;
    if (id) {
      this.byId.delete(id);
      console.log(`[probe] disconnected ${id}`);
    }
  }

  list(): ProbeInfo[] {
    return [...this.byId.values()].map((c) => c.info);
  }

  get(probeId: string): ProbeInfo | undefined {
    return this.byId.get(probeId)?.info;
  }

  execute(probeId: string, command: ProbeCommand, timeoutMs = 15000): Promise<ProbeResult> {
    const c = this.byId.get(probeId);
    if (!c) return Promise.resolve({ ok: false, error: "probe not connected" });
    const id = crypto.randomUUID();
    return new Promise<ProbeResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: "probe timed out" });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      c.ws.send(JSON.stringify({ type: "command", id, command }));
    });
  }

  getAssignments(probeId: string): ProbeAssignment[] {
    return this.assignments.get(probeId) ?? [];
  }

  setAssignments(probeId: string, a: ProbeAssignment[]) {
    this.assignments.set(probeId, a);
  }
}

export const probeHub = new ProbeHub();
