// Route the ORA board and report honestly: how many connections joined, how
// many the router could not find a path for, and what it refused to touch.
import { library } from "../server/src/services/library";
import { getFootprints } from "../server/src/services/footprints";
import { buildOra } from "./build-ora";
import { buildNetlist } from "@loon/shared/netlist";
import { generateBoard, ratsnest } from "@loon/shared/pcbgen";
import { autoroute } from "@loon/shared/autoroute";
import { OSHPARK_2LAYER } from "@loon/shared/board";

const schem = buildOra();
const defs = (l: string) => library.get(l)?.def;
const specs = new Map<string, number>();
for (const s of schem.symbols) { const fp = s.properties.Footprint; if (fp) specs.set(fp, defs(s.libId)?.pins.length ?? 2); }
const footprints = await getFootprints([...specs].map(([libId, padCount]) => ({ libId, padCount })));
const nl = buildNetlist(schem, defs);
const gen = generateBoard(schem, defs, { rules: OSHPARK_2LAYER, footprints });
const before = ratsnest(gen.board, footprints).length;
const res = autoroute(gen.board, footprints, nl);
gen.board.tracks.push(...res.tracks);
gen.board.vias.push(...res.vias);
console.log(`ratsnest before: ${before}`);
console.log(`routed ${res.routed} hops, failed ${res.failed}, skipped ${res.skipped.length} power nets in ${res.seconds.toFixed(1)}s`);
console.log(`tracks: ${res.tracks.length}, vias: ${res.vias.length}`);
console.log(`skipped: ${[...new Set(res.skipped)].slice(0, 10).join(", ")}`);
