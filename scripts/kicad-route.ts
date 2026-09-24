// Route a loon board with Freerouting through KiCad (see services/route-render).
// Run: bun run scripts/kicad-route.ts <project> [--passes N]
import { storage } from "../server/src/services/storage";
import { routeWithFreerouting, writeNetClasses, defaultNetClassPlan } from "../server/src/services/route-render";
import type { Board } from "@loon/shared/board";

const project = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!project) { console.log("usage: kicad-route.ts <project> [--passes N]"); process.exit(1); }
const pi = process.argv.indexOf("--passes");
const passes = pi > 0 ? Number(process.argv[pi + 1]) : 30;

const board = JSON.parse(await storage.readFile(project, "board.loon.json")) as Board;
const plan = defaultNetClassPlan(board);
await writeNetClasses(project, "", plan);
console.log(`net classes: Power ${plan.power.length} nets, Logic ${plan.logic?.length ?? 0}, Ethernet ${plan.ethernet?.length ?? 0}`);
const r = await routeWithFreerouting(project, "", passes);
console.log(`${r.ok ? "OK" : "NOT CLEAN"}: ${r.tracks} tracks, ${r.vias} vias, ${r.open} open, DRC ${r.drcViolations} violations / ${r.drcUnconnected} unconnected, ${r.seconds.toFixed(0)} s`);
for (const n of r.notes) console.log("  " + n);
for (const b of r.drcByRule.slice(0, 12)) console.log(`  ${String(b.count).padStart(4)}  ${b.rule}`);
