import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const API = process.env.LOON_API ?? "http://localhost:8790";
const sharedSrc = fileURLToPath(new URL("../shared/src", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // Compile the shared TS package as project source (Vite skips node_modules).
      { find: /^@loon\/shared$/, replacement: `${sharedSrc}/index.ts` },
      { find: /^@loon\/shared\/(.*)$/, replacement: `${sharedSrc}/$1.ts` },
    ],
  },
  server: {
    port: 5178,
    fs: { allow: [".", "..", "../.."] },
    proxy: {
      "/trpc": { target: API, changeOrigin: true },
      // Renders, fab output and firmware images; the built app is served by the
      // API itself, so the dev server has to forward them to match.
      "/artifact": { target: API, changeOrigin: true },
      "/project": { target: API, changeOrigin: true },
      "/.well-known/loon": { target: API, changeOrigin: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
