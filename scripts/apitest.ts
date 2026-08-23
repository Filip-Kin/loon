// End-to-end API test against a running server (LOON_PORT, default 8791).
// Exercises create -> save -> load -> ai.generate through the real tRPC client.
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "../server/src/routers";
import { emptySchematic } from "@loon/shared/schematic";

const port = process.env.LOON_PORT ?? "8791";
const trpc = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: `http://localhost:${port}/trpc` })] });

const name = "apitest-" + Math.floor(performance.now());

const lib = await trpc.library.all.query();
console.log("library parts:", lib.parts.length, "defs:", Object.keys(lib.defs).length);

await trpc.project.create.mutate({ name });
console.log("created", name);

const schem = emptySchematic(crypto.randomUUID());
schem.title = name;
await trpc.project.save.mutate({ name, schem });
const loaded = await trpc.project.load.query({ name });
console.log("saved+loaded, symbols:", loaded.schem.symbols.length);

const doAi = process.argv.includes("--ai");
if (doAi) {
  console.log("calling AI (real claude)...");
  const t0 = performance.now();
  const res = await trpc.ai.generate.mutate({ message: "Add a 330 ohm resistor and an LED in series from +5V to GND", schem: loaded.schem });
  console.log(`AI took ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  console.log("message:", res.message);
  console.log("ops:", JSON.stringify(res.ops, null, 2));
  console.log("results:", res.results.map((r: any) => (r.ok ? "ok" : `FAIL ${r.error}`)).join(", "));
  console.log("resulting symbols:", res.schem.symbols.map((s: any) => `${s.properties.Reference}=${s.libId}`).join(", "));
  console.log("wires:", res.schem.wires.length);
} else {
  console.log("(skip AI; pass --ai to test the claude bridge)");
}
console.log("\nAPITEST DONE");
