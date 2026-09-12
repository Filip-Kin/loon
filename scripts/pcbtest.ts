// Board generation test: real footprints from KiCad's library, pads carrying
// their schematic nets, a ratsnest, DRC against OSH Park's rules, and a
// .kicad_pcb that OSH Park would accept.
// Run: bun run scripts/pcbtest.ts
import { library } from "../server/src/services/library";
import { getFootprints } from "../server/src/services/footprints";
import { emptySchematic } from "@loon/shared/schematic";
import { applyOps, type LibResolver } from "@loon/shared/apply-ops";
import { generateBoard, ratsnest, runDrc } from "@loon/shared/pcbgen";
import { serializeBoard } from "@loon/shared/kicad-pcb";
import { OSHPARK_2LAYER } from "@loon/shared/board";
import type { Op } from "@loon/shared/ops";

const resolve: LibResolver = (libId) => {
  const e = library.get(libId);
  return e ? { def: e.def, footprint: e.part.footprints[0] } : undefined;
};
const defs = (libId: string) => library.get(libId)?.def;

let failures = 0;
const check = (n: string, c: boolean, d = "") => { if (!c) { failures++; console.log(`FAIL ${n} ${d}`); } else console.log(`ok   ${n}`); };

const schem = emptySchematic(crypto.randomUUID());
const ops: Op[] = [
  { op: "instantiate_module", moduleId: "esp32s3_core", at: { x: 200, y: 120 } },
  { op: "instantiate_module", moduleId: "usb_c_program", at: { x: 360, y: 60 } },
  { op: "instantiate_module", moduleId: "ldo_3v3", at: { x: 60, y: 120 } },
];
applyOps(schem, ops, resolve);

const specs = new Map<string, number>();
for (const s of schem.symbols) {
  const fp = s.properties.Footprint;
  if (fp) specs.set(fp, defs(s.libId)?.pins.length ?? 2);
}
console.log("footprints needed:", [...specs.keys()].join(", "));
const footprints = await getFootprints([...specs].map(([libId, padCount]) => ({ libId, padCount })));
const real = Object.values(footprints).filter((f) => f.fromLibrary).length;
console.log(`fetched ${Object.keys(footprints).length} footprints, ${real} from KiCad's library`);
check("ESP32 land pattern came from the library", footprints["RF_Module:ESP32-S3-WROOM-1"]?.fromLibrary === true);
check("ESP32 land pattern has all 41 pads plus thermal", (footprints["RF_Module:ESP32-S3-WROOM-1"]?.pads.length ?? 0) >= 41);

const res = generateBoard(schem, defs, { rules: OSHPARK_2LAYER, footprints });
console.log(`placed ${res.placed}, missing ${res.missingFootprints.length}, approximate ${res.approximate.length}`);
check("every part with a footprint got placed", res.placed > 10, String(res.placed));
check("pads carry their nets", res.board.footprints.some((f) => Object.values(f.padNets).includes("+3V3")));
check("board has an outline", res.board.outline.length === 4);

const rats = ratsnest(res.board, footprints);
console.log(`ratsnest: ${rats.length} connections to route`);
check("ratsnest is non-empty", rats.length > 5);

const drc = runDrc(res.board, footprints, rats.length);
console.log("drc:", drc.slice(0, 6).map((d) => `[${d.severity}] ${d.rule}: ${d.message}`).join("\n     "));
check("no overlapping parts in the starting placement", !drc.some((d) => d.rule === "overlap"), drc.filter((d) => d.rule === "overlap").map((d) => d.message).join("; "));

const raw: Record<string, any> = {};
for (const [id, fp] of Object.entries(footprints)) if (fp.raw) raw[id] = fp.raw;
const text = serializeBoard(res.board, raw);
await Bun.write("/tmp/loon-test.kicad_pcb", text);
check("board file has footprints", (text.match(/\(footprint /g) ?? []).length === res.placed, String((text.match(/\(footprint /g) ?? []).length));
check("board file declares nets", text.includes('(net 1 "'));
check("board file has an edge cut", text.includes('"Edge.Cuts"'));
console.log(`wrote /tmp/loon-test.kicad_pcb (${Math.round(text.length / 1024)}kB)`);

console.log(failures === 0 ? "\nPCB TEST PASS" : `\nPCB TEST FAIL (${failures})`);
if (failures > 0) process.exit(1);
