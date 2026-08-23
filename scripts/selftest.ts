// Core self-test: build a small circuit via ops, serialize to .kicad_sch,
// reparse, and check it round-trips. Run: bun run scripts/selftest.ts
import { library } from "../server/src/services/library";
import { emptySchematic } from "@loon/shared/schematic";
import { applyOps, type LibResolver } from "@loon/shared/apply-ops";
import { serializeSchematic, parseSchematic } from "@loon/shared/kicad-sch";

const resolve: LibResolver = (libId) => {
  const e = library.get(libId);
  return e ? { def: e.def, footprint: e.part.footprints[0] } : undefined;
};

const schem = emptySchematic(crypto.randomUUID());
const { results } = applyOps(schem, [
  { op: "add_symbol", libId: "power:+5V", at: { x: 100, y: 80 } },
  { op: "add_symbol", libId: "Device:R", value: "330", at: { x: 100, y: 100 } },
  { op: "add_symbol", libId: "Device:LED", at: { x: 100, y: 120 } },
  { op: "add_symbol", libId: "power:GND", at: { x: 100, y: 140 } },
  { op: "connect_pins", a: { ref: "PWR1", pin: "1" }, b: { ref: "R1", pin: "1" } },
  { op: "connect_pins", a: { ref: "R1", pin: "2" }, b: { ref: "D1", pin: "2" } },
  { op: "connect_pins", a: { ref: "D1", pin: "1" }, b: { ref: "PWR2", pin: "1" } },
], resolve);

console.log("apply results:", results.map((r) => (r.ok ? "ok" : `FAIL ${r.error}`)).join(", "));
console.log("refs:", schem.symbols.map((s) => `${s.properties.Reference}=${s.libId}`).join(", "));
console.log("wires:", schem.wires.length);

const libRaw = library.rawMap(Array.from(new Set(schem.symbols.map((s) => s.libId))));
const text = serializeSchematic(schem, libRaw);

const { schem: rt } = parseSchematic(text);
console.log("roundtrip symbols:", rt.symbols.length, "wires:", rt.wires.length, "libSymbols:", Object.keys(rt.libSymbols).length);

// Module expansion test.
const s2 = emptySchematic(crypto.randomUUID());
const mr = applyOps(s2, [{ op: "instantiate_module", moduleId: "led_indicator", params: { supply: "+5V", color: "green", current_ma: 10 }, at: { x: 120, y: 100 } }], resolve);
const rVal = s2.symbols.find((s) => s.libId === "Device:R")?.properties.Value;
console.log("\nmodule led_indicator ->", s2.symbols.map((s) => `${s.properties.Reference}=${s.libId.split(":")[1]}`).join(", "), "| R value:", rVal, "| wires:", s2.wires.length);
const modOk = mr.results.every((r) => r.ok) && s2.symbols.length === 4 && s2.wires.length === 3;

const ok = modOk && rt.symbols.length === schem.symbols.length && rt.wires.length === schem.wires.length && results.every((r) => r.ok);
console.log(ok ? "\nSELFTEST PASS" : "\nSELFTEST FAIL");
console.log("\n--- .kicad_sch head ---\n" + text.split("\n").slice(0, 40).join("\n"));
if (!ok) process.exit(1);
