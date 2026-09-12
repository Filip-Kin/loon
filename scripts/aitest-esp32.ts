// End-to-end check of the two things this board needed from the assistant:
// an ESP32 built onto the board (not a placeholder), and a costed answer to a
// design question. Run: bun run scripts/aitest-esp32.ts
import { library } from "../server/src/services/library";
import { emptySchematic } from "@loon/shared/schematic";
import { applyOps, type LibResolver } from "@loon/shared/apply-ops";
import { generateOps } from "../server/src/services/ai";
import { buildBom, formatBom } from "@loon/shared/bom";

const resolve: LibResolver = (libId) => {
  const e = library.get(libId);
  return e ? { def: e.def, footprint: e.part.footprints[0] } : undefined;
};

const schem = emptySchematic(crypto.randomUUID());
schem.title = "Power distribution + e-stop controller";

const p1 = "This is a 24V robot power distribution board. Put the circuitry required to make an ESP32 work directly on this board - I do not want to plug a dev board in, I want the ESP32 built into the PCB and programmable over USB-C.";
console.log("PROMPT 1:", p1, "\n");
const r1 = await generateOps(p1, schem);
console.log("message:", r1.message);
console.log("ops:", r1.ops.map((o: any) => o.op + (o.moduleId ? `:${o.moduleId}` : o.libId ? `:${o.libId}` : "")).join(", "));
const res1 = applyOps(schem, r1.ops, resolve);
console.log("failed ops:", res1.results.filter((r) => !r.ok).map((r) => r.error).join("; ") || "none");
console.log("symbols now:", schem.symbols.map((s) => `${s.properties.Reference}=${s.libId}`).join(", "));

const p2 = "How expensive would it be to add current monitoring to eight of the 24V channels? Do I have enough channels on the ESP32 for it, or do I need to multiplex somehow?";
console.log("\nPROMPT 2:", p2, "\n");
const r2 = await generateOps(p2, schem);
console.log("message:\n" + r2.message);
console.log("ops:", r2.ops.length);

console.log("\n" + formatBom(buildBom(schem, (libId) => {
  const part = library.get(libId)?.part;
  return part ? { priceUsd: part.priceUsd, mpn: part.mpn, note: part.priceNote } : undefined;
})));
