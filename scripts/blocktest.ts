// Block graph test: blocks, ports and links are derived from the schematic, so
// the two views cannot disagree. Also exercises the block-level ops, and the
// segment graph the Blocks view draws.
// Run: bun run scripts/blocktest.ts
import { library } from "../server/src/services/library";
import { emptySchematic } from "@loon/shared/schematic";
import { applyOps, type LibResolver } from "@loon/shared/apply-ops";
import { buildBlockGraph } from "@loon/shared/blockgraph";
import { buildSegmentGraph } from "@loon/shared/segments";
import type { Op } from "@loon/shared/ops";

const resolve: LibResolver = (libId) => {
  const e = library.get(libId);
  return e ? { def: e.def, footprint: e.part.footprints[0] } : undefined;
};
const defs = (libId: string) => library.get(libId)?.def;

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (!cond) { failures++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`);
};

const schem = emptySchematic(crypto.randomUUID());
const ops: Op[] = [
  { op: "instantiate_module", moduleId: "esp32s3_core", at: { x: 200, y: 120 } },
  { op: "instantiate_module", moduleId: "usb_c_program", at: { x: 360, y: 60 } },
  { op: "instantiate_module", moduleId: "estop_latch", params: { inputs: 2 }, at: { x: 620, y: 120 } },
  { op: "instantiate_module", moduleId: "ldo_3v3", at: { x: 60, y: 120 } },
];
applyOps(schem, ops, resolve);

let g = buildBlockGraph(schem, defs);
console.log(g.blocks.map((b) => `${b.moduleId}: ${b.partCount} parts, ports ${b.ports.map((p) => p.net).join(",")}`).join("\n"));
check("four blocks derived", g.blocks.length === 4, String(g.blocks.length));
check("USB block links to the MCU block", g.links.some((l) => l.net.startsWith("USB_D")));
check("blocks expose power ports", g.blocks.every((b) => b.ports.some((p) => p.isPower)));
check("no loose parts", g.looseRefs.length === 0, g.looseRefs.join(","));

// Moving a block moves its parts on the sheet.
const mcu = g.blocks.find((b) => b.moduleId === "esp32s3_core")!;
const beforeX = schem.symbols.find((s) => s.uuid === mcu.memberUuids[0])!.at.x;
applyOps(schem, [{ op: "move_block", blockId: mcu.id, by: { dx: 50, dy: 0 } }], resolve);
const afterX = schem.symbols.find((s) => s.uuid === mcu.memberUuids[0])!.at.x;
check("move_block moved the parts", Math.abs(afterX - beforeX - 50) < 2.6, `${beforeX} -> ${afterX}`);

// Re-parametrising rebuilds the block from its module.
const latch = buildBlockGraph(schem, defs).blocks.find((b) => b.moduleId === "estop_latch")!;
const before = schem.symbols.filter((s) => s.properties.LoonBlock === latch.id).length;
const r = applyOps(schem, [{ op: "set_block_params", blockId: latch.id, params: { inputs: 4 } }], resolve);
check("set_block_params applied", r.results.every((x) => x.ok), r.results.map((x) => x.error).join(";"));
g = buildBlockGraph(schem, defs);
const latch2 = g.blocks.find((b) => b.moduleId === "estop_latch")!;
check("rebuilt latch has more parts with 4 inputs", latch2.partCount > before, `${before} -> ${latch2.partCount}`);
check("params updated on the block", String(latch2.params.inputs) === "4", JSON.stringify(latch2.params));

// Joining two nets by name is how ports connect.
const rn = applyOps(schem, [{ op: "rename_net", from: "ARM", to: "IO21_ARM" }], resolve);
check("rename_net worked", rn.results.every((x) => x.ok));
check("net renamed in the graph", buildBlockGraph(schem, defs).blocks.some((b) => b.ports.some((p) => p.net === "IO21_ARM")) || schem.labels.some((l) => l.text === "IO21_ARM"));

// Deleting a block takes its parts with it.
const del = applyOps(schem, [{ op: "delete_block", blockId: latch2.id }], resolve);
check("delete_block worked", del.results.every((x) => x.ok));
check("latch parts gone", !schem.symbols.some((s) => s.properties.LoonBlock === latch2.id));

// #region segments
// The Blocks view groups the whole sheet, including parts that were never
// placed by a module, and lays it out by signal flow rather than by where the
// parts sit.
const seg = buildSegmentGraph(schem, defs);
console.log(`\nsegments: ${seg.segments.length} from ${schem.symbols.length} symbols, ${seg.links.length} links, ${seg.cols} columns`);
for (const x of [...seg.segments].sort((a, b) => a.col - b.col || a.row - b.row)) {
  console.log(`  c${x.col}r${x.row} [${x.kind}] ${x.name} (${x.partCount} parts) rails ${x.rails.join(",") || "-"}`);
}
check("segments are fewer than parts", seg.segments.length > 0 && seg.segments.length < schem.symbols.length, `${seg.segments.length} vs ${schem.symbols.length}`);
check("every part belongs to exactly one segment", (() => {
  const seen = new Set<string>();
  for (const x of seg.segments) for (const u of x.memberUuids) { if (seen.has(u)) return false; seen.add(u); }
  const parts = schem.symbols.filter((y) => !y.libId.startsWith("power:") && !(y.properties.Reference ?? "").startsWith("#PWR"));
  return seen.size === parts.length;
})());
check("the MCU is found and named", seg.segments.some((x) => x.kind === "mcu"), seg.segments.map((x) => `${x.name}:${x.kind}`).join(", "));
check("a regulator is found", seg.segments.some((x) => x.kind === "regulator"));
check("no link points at a segment that is gone", seg.links.every((l) => seg.segments.some((x) => x.id === l.from) && seg.segments.some((x) => x.id === l.to)));
check("power rails are listed, not drawn as links", seg.links.every((l) => l.nets.every((n) => !/^(GND|\+\d)/.test(n))));

console.log(failures === 0 ? "\nBLOCK TEST PASS" : `\nBLOCK TEST FAIL (${failures})`);
if (failures > 0) process.exit(1);
