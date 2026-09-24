// Checks loon against the KiCad container it pins. Re-serializes a real
// project through loon's codecs, then puts the result through every KiCad call
// loon makes: pcbnew load/save, the Specctra DSN export and SES import, the
// zone filler, Board.Tracks, and kicad-cli's drc, render and svg export. The
// schematic goes through kicad-cli too, because a sheet KiCad refuses to open
// is a sheet the user cannot check.
//
// The project is copied first; nothing writes into the source folder.
//
// Run: bun run scripts/kicadtest.ts [path/to/project]

import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KICAD_IMAGE, KICAD_PCB_VERSION, KICAD_SCH_VERSION } from "@loon/shared/kicad-version";
import { serializeBoard, serializeProject } from "@loon/shared/kicad-pcb";
import { parseSchematic, serializeSchematic } from "@loon/shared/kicad-sch";
import { getFootprints } from "../server/src/services/footprints";
import type { Board } from "@loon/shared/board";

const DOCKER = process.env.LOON_DOCKER_BIN ?? "docker";
const SRC = process.argv[2] ?? join(process.env.LOON_FS_DIR ?? "data/projects", "Radio_Kiosk_v2b");

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

async function sh(args: string[], timeoutMs = 900_000): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, out };
}

const inKicad = (dir: string, ...cmd: string[]) =>
  sh([DOCKER, "run", "--rm", "-v", `${dir}:/work`, "-w", "/work", KICAD_IMAGE, ...cmd]);

const py = (dir: string, script: string) => inKicad(dir, "python3", "-c", script);

if (!existsSync(SRC)) {
  console.log(`no project at ${SRC}. Pass one: bun run scripts/kicadtest.ts <dir>`);
  process.exit(1);
}

const dir = await mkdtemp(join(tmpdir(), "loon-kicadtest-"));
await cp(SRC, dir, { recursive: true });
console.log(`${SRC} -> ${dir}\nimage: ${KICAD_IMAGE}\n`);

// #region what KiCad itself reports
const ver = await inKicad(dir, "kicad-cli", "version");
console.log(`kicad-cli ${ver.out.trim()}`);
const stamps = await py(dir, "import pcbnew; print('pcb', pcbnew.SEXPR_BOARD_FILE_VERSION)");
const pcbStamp = Number(stamps.out.match(/pcb (\d+)/)?.[1] ?? 0);
check(`board stamp matches the container (${KICAD_PCB_VERSION})`, pcbStamp === KICAD_PCB_VERSION, `container writes ${pcbStamp}`);

// #region re-serialize through loon
const board = JSON.parse(await readFile(join(dir, "board.loon.json"), "utf8")) as Board;
const specs = new Map<string, number>();
for (const f of board.footprints) specs.set(f.libId, Math.max(specs.get(f.libId) ?? 0, Object.keys(f.padNets).length));
const footprints = await getFootprints([...specs].map(([libId, padCount]) => ({ libId, padCount })));
const raw: Record<string, any> = {};
for (const [id, fp] of Object.entries(footprints)) if (fp.raw) raw[id] = fp.raw;
await writeFile(join(dir, "board.kicad_pcb"), serializeBoard(board, raw));
await writeFile(join(dir, "board.kicad_pro"), serializeProject(board, "board"));
check(`loon stamps the board ${KICAD_PCB_VERSION}`, (await readFile(join(dir, "board.kicad_pcb"), "utf8")).includes(`(version ${KICAD_PCB_VERSION})`));

if (existsSync(join(dir, "board.kicad_sch"))) {
  const { schem, libRaw } = parseSchematic(await readFile(join(dir, "board.kicad_sch"), "utf8"));
  await writeFile(join(dir, "board.kicad_sch"), serializeSchematic(schem, libRaw));
  const text = await readFile(join(dir, "board.kicad_sch"), "utf8");
  check(`loon stamps the sheet ${KICAD_SCH_VERSION}`, text.includes(`(version ${KICAD_SCH_VERSION})`));
  const wide = [...text.matchAll(/\(wire\s*\(pts([^)]*(?:\)[^)]*)*?)\)\s*\(stroke/g)].filter((m) => (m[1].match(/\(xy/g) ?? []).length !== 2);
  check("every wire is two points, as KiCad requires", wide.length === 0, `${wide.length} polyline wires`);
}

// #region the python API loon calls
const load = await py(dir, `
import pcbnew
b = pcbnew.LoadBoard('/work/board.kicad_pcb')
print('parts', len(b.GetFootprints()), 'zones', len(b.Zones()), 'tracks', len(list(b.Tracks())))
pcbnew.SaveBoard('/work/roundtrip.kicad_pcb', b)
`);
check("pcbnew loads the board loon wrote", /parts \d+/.test(load.out), load.out.trim().split("\n").pop());
console.log(`     ${load.out.trim().split("\n").filter((l) => l.startsWith("parts")).join(" ")}`);

const dsn = await py(dir, `
import pcbnew
b = pcbnew.LoadBoard('/work/board.kicad_pcb')
print('dsn', pcbnew.ExportSpecctraDSN(b, '/work/test.dsn'))
`);
check("ExportSpecctraDSN", /dsn True/.test(dsn.out), dsn.out.trim().split("\n").pop());

if (existsSync(join(dir, "board.ses"))) {
  const ses = await py(dir, `
import pcbnew
b = pcbnew.LoadBoard('/work/board.kicad_pcb')
pcbnew.ImportSpecctraSES(b, '/work/board.ses')
print('imported', len(list(b.Tracks())))
`);
  check("ImportSpecctraSES", /imported \d+/.test(ses.out), ses.out.trim().split("\n").pop());
} else {
  console.log("skip ImportSpecctraSES — no board.ses in this project");
}

const fill = await py(dir, `
import pcbnew
b = pcbnew.LoadBoard('/work/board.kicad_pcb')
pcbnew.ZONE_FILLER(b).Fill(b.Zones())
b.BuildConnectivity()
tracks = [t for t in b.Tracks() if t.GetClass() == 'PCB_TRACK']
vias = [t for t in b.Tracks() if t.GetClass() == 'PCB_VIA']
area = sum(z.GetFilledArea() for z in b.Zones()) / 1e12
print('filled %d zones %.1f cm2, %d tracks, %d vias, %d open' % (len(b.Zones()), area / 100, len(tracks), len(vias), b.GetConnectivity().GetUnconnectedCount(True)))
`);
check("ZONE_FILLER and Board.Tracks", /filled \d+ zones/.test(fill.out), fill.out.trim().split("\n").pop());
console.log(`     ${fill.out.trim().split("\n").filter((l) => l.startsWith("filled")).join(" ")}`);

// The stitching pass uses the geometry classes, which move between releases.
const geom = await py(dir, `
import pcbnew
b = pcbnew.LoadBoard('/work/board.kicad_pcb')
pcbnew.ZONE_FILLER(b).Fill(b.Zones())
# a zone only answers for a layer it is actually on
z, layer = next((z, l) for z in b.Zones() for l in (pcbnew.F_Cu, pcbnew.B_Cu) if z.IsOnLayer(l))
polys = z.GetFilledPolysList(layer)
ol = polys.Outline(0)
pcbnew.SEG(pcbnew.VECTOR2I(0, 0), pcbnew.VECTOR2I(1000, 0)).Distance(pcbnew.VECTOR2I(0, 500))
v = pcbnew.PCB_VIA(b); v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
print('geometry ok outlines', polys.OutlineCount(), 'points', ol.PointCount(), 'area', int(ol.Area()))
`);
check("zone geometry API used by the GND stitcher", /geometry ok/.test(geom.out), geom.out.trim().split("\n").pop());

// #region kicad-cli
const drc = await inKicad(dir, "kicad-cli", "pcb", "drc", "--format", "json", "--severity-all", "--output", "/work/drc-test.json", "/work/board.kicad_pcb");
let drcOk = false;
try {
  const rep = JSON.parse(await readFile(join(dir, "drc-test.json"), "utf8"));
  drcOk = Array.isArray(rep.violations);
  console.log(`     drc: ${rep.violations.length} violations, ${(rep.unconnected_items ?? []).length} unconnected`);
} catch { /* reported below */ }
check("kicad-cli pcb drc", drcOk, drc.out.trim().split("\n").pop());

const svg = await inKicad(dir, "kicad-cli", "pcb", "export", "svg", "--output", "/work/test-layers.svg",
  "--layers", "F.Cu,B.Cu,F.SilkS,B.SilkS,Edge.Cuts,F.Mask", "--page-size-mode", "2", "--exclude-drawing-sheet", "/work/board.kicad_pcb");
check("kicad-cli pcb export svg", svg.code === 0 && existsSync(join(dir, "test-layers.svg")), svg.out.trim().split("\n").pop());

const render = await inKicad(dir, "kicad-cli", "pcb", "render", "--output", "/work/test-render.png",
  "--width", "600", "--height", "450", "--quality", "basic", "--background", "opaque", "--side", "top", "--zoom", "0.7", "/work/board.kicad_pcb");
check("kicad-cli pcb render", render.code === 0 && existsSync(join(dir, "test-render.png")), render.out.trim().split("\n").pop());

if (existsSync(join(dir, "board.kicad_sch"))) {
  const net = await inKicad(dir, "kicad-cli", "sch", "export", "netlist", "-o", "/work/test.net", "/work/board.kicad_sch");
  check("kicad-cli sch export netlist", net.code === 0 && existsSync(join(dir, "test.net")), net.out.trim().split("\n").pop());
}

console.log(failures === 0 ? "\nKICAD TEST PASS" : `\nKICAD TEST FAIL (${failures})`);
if (process.env.LOON_KEEP_TMP) console.log(`kept ${dir}`);
else await rm(dir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
