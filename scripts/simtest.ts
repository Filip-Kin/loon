// Simulation test: a SPICE deck from the real schematic, run in ngspice, and
// checked against what the circuit is supposed to do.
// Run: bun run scripts/simtest.ts
import { library } from "../server/src/services/library";
import { emptySchematic } from "@loon/shared/schematic";
import { applyOps, type LibResolver } from "@loon/shared/apply-ops";
import { buildSpiceDeck, parseWrdata, type SpiceBench } from "@loon/shared/spice";

const resolve: LibResolver = (libId) => {
  const e = library.get(libId);
  return e ? { def: e.def, footprint: e.part.footprints[0] } : undefined;
};
const defs = (libId: string) => library.get(libId)?.def;

let failures = 0;
const check = (n: string, c: boolean, d = "") => { if (!c) { failures++; console.log(`FAIL ${n} ${d}`); } else console.log(`ok   ${n}`); };

// The EN reset delay: 10k to 3V3 with 1uF to ground should take about 20ms to
// cross the ESP32's 2V enable threshold.
const schem = emptySchematic(crypto.randomUUID());
applyOps(schem, [{ op: "instantiate_module", moduleId: "esp32s3_core", at: { x: 100, y: 100 } }], resolve);

const bench: SpiceBench = {
  name: "EN power-up delay",
  analysis: "tran",
  tranStop: 0.1,
  tranStep: 0.0001,
  sources: [{ net: "+3V3", kind: "pulse", pulse: { v1: 0, v2: 3.3, delay: 0, rise: 0.0001, fall: 0.0001, width: 1, period: 2 } }],
  probes: ["EN"],
};

const deck = buildSpiceDeck(schem, bench, defs);
console.log(deck.text.split("\n").slice(0, 14).join("\n"));
console.log(`unmodelled: ${deck.unmodelled.map((u) => `${u.ref}(${u.libId})`).join(", ") || "none"}`);
check("deck has the EN pull-up resistor", /^RR\d+ /m.test(deck.text) || deck.text.includes("10k"));
check("deck has the EN capacitor", deck.text.includes("1u"));
check("the ESP32 module is reported as unmodelled, not silently dropped", deck.unmodelled.some((u) => u.libId.includes("ESP32")));

await Bun.write("/tmp/loon-sim/bench.cir", deck.text);
const proc = Bun.spawn(["sudo", "docker", "run", "--rm", "-v", "/tmp/loon-sim:/work", "-w", "/work", "loon-spice:latest", "ngspice", "-b", "bench.cir"], { stdout: "pipe", stderr: "pipe" });
const out = await new Response(proc.stdout).text();
const err = await new Response(proc.stderr).text();
await proc.exited;
let csv = "";
try { csv = await Bun.file("/tmp/loon-sim/out.csv").text(); } catch { /* none */ }
check("ngspice produced data", csv.length > 0, (out + err).slice(-400));

if (csv) {
  const series = parseWrdata(csv, ["EN"]);
  const pts = series[0].points;
  const final = pts[pts.length - 1]?.v ?? 0;
  const cross = pts.find((p) => p.v >= 2.0)?.t ?? -1;
  console.log(`EN settles at ${final.toFixed(3)}V, crosses 2V at ${(cross * 1000).toFixed(1)}ms`);
  check("EN ends up at the rail", Math.abs(final - 3.3) < 0.1, String(final));
  check("EN rises through 2V in 5-40ms, as an RC of 10k x 1uF should", cross > 0.005 && cross < 0.04, `${cross}s`);
}

console.log(failures === 0 ? "\nSIM TEST PASS" : `\nSIM TEST FAIL (${failures})`);
if (failures > 0) process.exit(1);
