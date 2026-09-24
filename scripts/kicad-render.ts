// Pictures of a loon board from KiCad's raytracer (see services/route-render).
// Run: bun run scripts/kicad-render.ts <project>
import { renderBoard } from "../server/src/services/route-render";

const project = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!project) { console.log("usage: kicad-render.ts <project>"); process.exit(1); }
const r = await renderBoard(project, "");
console.log(`images: ${r.images.join(", ") || "none"}`);
if (r.missingModels.length) console.log(`missing 3D models: ${r.missingModels.join(", ")}`);
for (const n of r.notes) console.log("  " + n);
