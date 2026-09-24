// Route a loon board with Freerouting through KiCad (see services/route-render).
// Run: bun run scripts/kicad-route.ts <project> [--passes N]
import { storage } from "../server/src/services/storage";
import { routeWithFreerouting, writeNetClasses, defaultNetClassPlan } from "../server/src/services/route-render";
import type { Board } from "@loon/shared/board";

const project = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!project) { console.log("usage: kicad-route.ts <project> [--passes N]"); process.exit(1); }
const pi = process.argv.indexOf("--passes");
const passes = pi > 0 ? Number(process.argv[pi + 1]) : 30;
const keepTracks = process.argv.includes("--keep-tracks");
const routeGnd = process.argv.includes("--route-gnd");
const di = process.argv.indexOf("--dirty");
const dirtyRefs = di > 0 ? process.argv[di + 1].split(",") : [];

const board = JSON.parse(await storage.readFile(project, "board.loon.json")) as Board;
const plan = defaultNetClassPlan(board);
await writeNetClasses(project, "", plan);
console.log(`net classes: Heavy ${plan.heavy?.length ?? 0} (2.5 mm), Wide ${plan.wide?.length ?? 0} (2.0), Power ${plan.power.length} (1.0), Ethernet ${plan.ethernet?.length ?? 0}`);
const r = await routeWithFreerouting(project, "", { passes, keepTracks, dirtyRefs, routeGnd });
console.log(`${r.ok ? "OK" : "NOT CLEAN"}: ${r.tracks} tracks, ${r.vias} vias, ${r.open} open, DRC ${r.drcViolations} violations / ${r.drcUnconnected} unconnected, ${r.seconds.toFixed(0)} s`);
for (const n of r.notes) console.log("  " + n);
for (const b of r.drcByRule.slice(0, 12)) console.log(`  ${String(b.count).padStart(4)}  ${b.rule}`);
