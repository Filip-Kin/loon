import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./routers";
import { LOON_CONTRACT_VERSION, type LoonManifest } from "@loon/shared/contract";
import { probeHub, type ProbeSocketData } from "./services/probe-hub";
import { join } from "node:path";
import { existsSync } from "node:fs";

const PORT = parseInt(process.env.LOON_PORT ?? "8790", 10);
const WORKSPACE = process.env.LOON_WORKSPACE ?? join(process.cwd(), "data");
const WEB_DIST = join(import.meta.dir, "..", "..", "web", "dist");
const CLAUDE_BIN = process.env.LOON_CLAUDE_BIN || "claude";

function cors(headers: Headers = new Headers()): Headers {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "content-type,authorization");
  return headers;
}

async function aiAvailable(): Promise<boolean> {
  try {
    const p = Bun.spawn([CLAUDE_BIN, "--version"], { stdout: "pipe", stderr: "pipe" });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}

const manifest: LoonManifest = {
  contract: LOON_CONTRACT_VERSION,
  name: "loon",
  version: "0.1.0",
  workspace: WORKSPACE,
  user: process.env.LOON_USER,
  aiAvailable: false,
};
aiAvailable().then((ok) => (manifest.aiAvailable = ok));

const server = Bun.serve<ProbeSocketData, {}>({
  port: PORT,
  idleTimeout: 255,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });

    // Probe agents connect here over WebSocket.
    if (url.pathname === "/probe/ws") {
      if (server.upgrade(req, { data: {} as ProbeSocketData })) return undefined as unknown as Response;
      return new Response("expected websocket upgrade", { status: 426 });
    }

    // Discovery manifest for the claude-terminal / router contract.
    if (url.pathname === "/.well-known/loon") {
      return new Response(JSON.stringify(manifest), { headers: cors(new Headers({ "content-type": "application/json" })) });
    }

    // tRPC API.
    if (url.pathname.startsWith("/trpc")) {
      const res = await fetchRequestHandler({
        endpoint: "/trpc",
        req,
        router: appRouter,
        createContext: () => ({}),
      });
      cors(res.headers);
      return res;
    }

    // Static web build (prod). In dev, vite serves the UI and proxies /trpc.
    if (existsSync(WEB_DIST)) {
      let p = url.pathname === "/" ? "/index.html" : url.pathname;
      let file = Bun.file(join(WEB_DIST, p));
      if (!(await file.exists())) file = Bun.file(join(WEB_DIST, "index.html")); // SPA fallback
      if (await file.exists()) return new Response(file);
    }

    return new Response(
      "Loon server is up. Build the web UI (bun run build) or run the dev server (bun run dev).",
      { status: 200, headers: cors(new Headers({ "content-type": "text/plain" })) },
    );
  },
  websocket: {
    open() {},
    message(ws, message) {
      probeHub.onMessage(ws, typeof message === "string" ? message : message.toString());
    },
    close(ws) {
      probeHub.onClose(ws);
    },
  },
});

console.log(`loon server on http://localhost:${server.port}  workspace=${WORKSPACE}`);
