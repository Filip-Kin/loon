import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./routers";
import { storage } from "./services/storage";
import { LOON_CONTRACT_VERSION, type LoonManifest } from "@loon/shared/contract";
import { probeHub, type ProbeSocketData } from "./services/probe-hub";
import { exportProjectZip, importProjectZip } from "./services/archive";
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

    // The project as a KiCad project zip, and the way back in. Raw bytes both
    // ways; a zip through tRPC would be base64.
    if (url.pathname === "/project/export") {
      const name = url.searchParams.get("name");
      if (!name) return new Response("name required", { status: 400, headers: cors() });
      try {
        const z = await exportProjectZip(name, url.searchParams.get("board") ?? "");
        return new Response(z.bytes, {
          headers: cors(new Headers({ "content-type": "application/zip", "content-disposition": `attachment; filename="${z.name}"`, "cache-control": "no-store" })),
        });
      } catch (e) {
        return new Response(String((e as Error).message ?? e), { status: 500, headers: cors() });
      }
    }
    if (url.pathname === "/project/import" && req.method === "POST") {
      const name = url.searchParams.get("name");
      if (!name) return new Response("name required", { status: 400, headers: cors() });
      try {
        let bytes: Uint8Array;
        if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
          const file = (await req.formData()).get("file");
          if (!(file instanceof File)) return new Response("file field required", { status: 400, headers: cors() });
          bytes = new Uint8Array(await file.arrayBuffer());
        } else {
          bytes = new Uint8Array(await req.arrayBuffer());
        }
        const r = await importProjectZip(name, url.searchParams.get("board") ?? "", bytes);
        return new Response(JSON.stringify(r), { headers: cors(new Headers({ "content-type": "application/json" })) });
      } catch (e) {
        return new Response(String((e as Error).message ?? e), { status: 400, headers: cors() });
      }
    }

    // Firmware images for browser flashing. Raw bytes, because base64 through
    // tRPC would triple the size of every build artifact.
    if (url.pathname.startsWith("/artifact/")) {
      const rest = decodeURIComponent(url.pathname.slice("/artifact/".length));
      const slash = rest.indexOf("/");
      if (slash > 0) {
        const project = rest.slice(0, slash);
        const rel = rest.slice(slash + 1);
        try {
          const bytes = await storage.readBinary(project, rel);
          return new Response(bytes, {
            headers: cors(new Headers({ "content-type": "application/octet-stream", "cache-control": "no-store" })),
          });
        } catch {
          return new Response("not found", { status: 404, headers: cors(new Headers()) });
        }
      }
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
