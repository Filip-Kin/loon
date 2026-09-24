// #region Project archives
// A zip of the project as a KiCad project: <name>.kicad_pro / _sch / _pcb
// (renamed from loon's board.* so KiCad shows the project's name), the local
// 3D models, loon's own board model so the zip comes back in without loss,
// and the firmware. Scratch output (renders, DRC, router sessions, backups)
// stays out. The .kicad_pro carries the net classes, so trace widths and
// clearances are there when the board is opened for routing.
//
// Import is the reverse: a zip from here, or any KiCad project, lands in a
// project folder as board.*. With loon's model in the zip the layout view is
// synced from the board file straight away; without it the schematic opens
// and the board has to be generated once.

import { mkdir, mkdtemp, readdir, rm, cp, stat, readFile, writeFile } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { tmpdir } from "node:os";
import { storage } from "./storage";
import { writeNetClasses, defaultNetClassPlan, syncFromKicad } from "./route-render";
import type { Board } from "@loon/shared/board";

const KICAD_EXT = [".kicad_pro", ".kicad_sch", ".kicad_pcb", ".kicad_prl"];
const SKIP = /^(render-.*\.png|layers\.svg|drc.*\.json|route-progress\.json|board\.(ses|dsn|rules)|.*\.bak|.*\.(loon-)?before-.*|\.freerouting|\.pio|node_modules|fp-info-cache|.*-backups)$/;

function safe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function run(cmd: string[], cwd: string): Promise<Uint8Array> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd[0]} failed: ${err.slice(0, 300)}`);
  return new Uint8Array(out);
}

// #region export
export async function exportProjectZip(project: string, unit = ""): Promise<{ name: string; bytes: Uint8Array }> {
  const dir = storage.projectDir(project, unit);
  const name = safe(unit ? `${project}-${unit}` : project);

  // Net classes are what make the board routable by hand: make sure the
  // project file has them before it leaves.
  const proPath = join(dir, "board.kicad_pro");
  if (await exists(proPath)) {
    const pro = JSON.parse(await readFile(proPath, "utf8"));
    if ((pro.net_settings?.classes?.length ?? 0) <= 1) {
      try {
        const board = JSON.parse(await storage.readFile(project, "board.loon.json", unit)) as Board;
        await writeNetClasses(project, unit, defaultNetClassPlan(board));
      } catch {
        /* no loon model: the project file goes as it is */
      }
    }
  }

  const stage = await mkdtemp(join(tmpdir(), "loon-export-"));
  try {
    const root = join(stage, name);
    await mkdir(root);
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (SKIP.test(e.name)) continue;
      const src = join(dir, e.name);
      if (e.name.startsWith("board.") && KICAD_EXT.includes(extname(e.name))) {
        let text = await readFile(src, "utf8");
        if (e.name === "board.kicad_pro") {
          const pro = JSON.parse(text);
          pro.meta = { ...(pro.meta ?? {}), filename: `${name}.kicad_pro` };
          text = JSON.stringify(pro, null, 2);
        }
        if (e.name === "board.kicad_pcb") text = await localiseModels(text, dir, root);
        await writeFile(join(root, `${name}${extname(e.name)}`), text, "utf8");
      } else {
        await cp(src, join(root, e.name), { recursive: true });
      }
    }
    const bytes = await run(["zip", "-r", "-q", "-", name], stage);
    return { name: `${name}.zip`, bytes };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

// Footprints fetched from LCSC can point at a model by absolute path on this
// machine. Copy those into the project's model folder and reference them
// relative to the project, so the zip is complete on any machine.
async function localiseModels(pcb: string, dir: string, root: string): Promise<string> {
  const models = new Set<string>();
  for (const m of pcb.matchAll(/\(model "(\/[^"]+)"/g)) models.add(m[1]);
  if (!models.size) return pcb;
  const out = join(root, "lcsc.3dshapes");
  await mkdir(out, { recursive: true });
  for (const abs of models) {
    const file = basename(abs);
    if (await exists(abs)) await cp(abs, join(out, file));
    else if (await exists(join(dir, "lcsc.3dshapes", file))) { /* already local */ }
    pcb = pcb.replaceAll(`(model "${abs}"`, `(model "lcsc.3dshapes/${file}"`);
  }
  return pcb;
}

// #region import
export interface ImportResult {
  project: string;
  unit: string;
  files: string[];
  synced: boolean;
  note: string;
}

export async function importProjectZip(project: string, unit: string, bytes: Uint8Array): Promise<ImportResult> {
  const stage = await mkdtemp(join(tmpdir(), "loon-import-"));
  try {
    const zipPath = join(stage, "in.zip");
    await Bun.write(zipPath, bytes);
    const src = join(stage, "x");
    await mkdir(src);
    await run(["unzip", "-q", "-o", zipPath, "-d", src], stage);

    // The project may sit at the zip root or one folder down.
    let base = src;
    let entries = (await readdir(base, { withFileTypes: true })).filter((e) => !e.name.startsWith("__MACOSX"));
    if (entries.length === 1 && entries[0].isDirectory()) {
      base = join(base, entries[0].name);
      entries = await readdir(base, { withFileTypes: true });
    }
    const pcb = entries.find((e) => e.isFile() && e.name.endsWith(".kicad_pcb"));
    const sch = entries.find((e) => e.isFile() && e.name.endsWith(".kicad_sch"));
    if (!pcb && !sch) throw new Error("no .kicad_pcb or .kicad_sch in the zip");
    const stem = basename((pcb ?? sch)!.name, extname((pcb ?? sch)!.name));

    const dir = storage.projectDir(project, unit);
    await mkdir(dir, { recursive: true });
    const files: string[] = [];
    for (const e of entries) {
      const from = join(base, e.name);
      if (e.isFile() && KICAD_EXT.includes(extname(e.name))) {
        if (basename(e.name, extname(e.name)) !== stem) continue; // a stray second project
        let text = await readFile(from, "utf8");
        if (extname(e.name) === ".kicad_pro") {
          const pro = JSON.parse(text);
          pro.meta = { ...(pro.meta ?? {}), filename: "board.kicad_pro" };
          text = JSON.stringify(pro, null, 2);
        }
        const to = `board${extname(e.name)}`;
        await writeFile(join(dir, to), text, "utf8");
        files.push(to);
      } else if (!SKIP.test(e.name)) {
        await cp(from, join(dir, e.name), { recursive: true });
        files.push(e.name);
      }
    }
    if (!(await exists(join(dir, "board.kicad_sch")))) throw new Error("the zip has no schematic; loon needs one to open a project");

    let synced = false;
    let note = "";
    if (await exists(join(dir, "board.loon.json")) && pcb) {
      const r = await syncFromKicad(project, unit);
      synced = true;
      note = `layout synced from the board file: ${r.tracks} tracks, ${r.vias} vias, ${r.moved} parts placed`;
    } else if (pcb) {
      note = "no loon board model in the zip: generate the board once with Keep placement, then Re-sync to pull the routing in";
    } else {
      note = "schematic only";
    }
    return { project, unit, files, synced, note };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
