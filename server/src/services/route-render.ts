// #region Autorouting and rendering through KiCad + Freerouting
// loon's own router is a first-pass grid router. For a real board the work goes
// to Freerouting, with KiCad on both ends: it exports the Specctra DSN (with
// the net classes, so power nets come out wide), imports the SES, fills the
// zones and runs DRC. All of it runs in containers; nothing is installed on
// the host. Renders come from kicad-cli's raytracer with the 3D models fetched
// per board from KiCad's library, plus the LCSC models easyeda2kicad wrote.

import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { storage } from "./storage";
import { parse, findAll, find } from "@loon/shared/sexpr";
import { readZoneFills } from "@loon/shared/kicad-pcb";
import type { Board, Track, Via } from "@loon/shared/board";

const KICAD = process.env.LOON_KICAD_IMAGE ?? "ghcr.io/kicad/kicad:9.0";
const FREEROUTING = process.env.LOON_FREEROUTING_IMAGE ?? "ghcr.io/freerouting/freerouting:latest";
const DOCKER = process.env.LOON_DOCKER_BIN ?? "docker";
export const MODELS_DIR = process.env.LOON_3D_DIR ?? join(process.cwd(), "data", "3dmodels");
const MODEL_REF = process.env.LOON_3D_REF ?? "9.0.8";

async function run(args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, out: out + err };
}
const kicadPy = (dir: string, script: string, extra: string[] = []) =>
  run([DOCKER, "run", "--rm", "-v", `${dir}:/work`, "-w", "/work", ...extra, KICAD, "python3", "-c", script], 600000);

// #region net classes
// Which nets get wide copper. A rail is anything that carries the load; the
// names are loon's conventions plus whatever the caller adds.
export interface NetClassPlan {
  power: string[];
  logic?: string[];
  ethernet?: string[];
}
export function defaultNetClassPlan(board: Board): NetClassPlan {
  const nets = new Set<string>();
  for (const f of board.footprints) for (const n of Object.values(f.padNets)) nets.add(n);
  const all = [...nets];
  return {
    power: all.filter((n) => /^(\+\d|VIN|VBUS|PORT_[PN]$|PACK|LAPTOP_OUT|BOOST_SW|BOOST_CS|FAN_N|PSE_SENSE|PSE_AGND|TEST_NODE|_OUT$)/.test(n) && n !== "+3V3"),
    logic: all.filter((n) => n === "+3V3"),
    ethernet: all.filter((n) => /^ETH_/.test(n)),
  };
}

export async function writeNetClasses(project: string, unit: string, plan: NetClassPlan): Promise<void> {
  const pro = JSON.parse(await storage.readFile(project, "board.kicad_pro", unit));
  const def = pro.net_settings.classes[0];
  pro.net_settings.classes = [
    def,
    { ...def, name: "Power", track_width: 1.0, clearance: 0.25, via_diameter: 0.9, via_drill: 0.5 },
    { ...def, name: "Logic", track_width: 0.4, clearance: 0.2 },
    { ...def, name: "Ethernet", track_width: 0.3, clearance: 0.2, diff_pair_width: 0.3, diff_pair_gap: 0.2 },
  ];
  pro.net_settings.netclass_patterns = [
    ...plan.power.map((n) => ({ netclass: "Power", pattern: n })),
    ...(plan.logic ?? []).map((n) => ({ netclass: "Logic", pattern: n })),
    ...(plan.ethernet ?? []).map((n) => ({ netclass: "Ethernet", pattern: n })),
  ];
  await storage.writeFile(project, "board.kicad_pro", JSON.stringify(pro, null, 2), unit);
}

// #region route
export interface RouteReport {
  ok: boolean;
  seconds: number;
  tracks: number;
  vias: number;
  open: number;
  drcViolations: number;
  drcUnconnected: number;
  drcByRule: { rule: string; count: number }[];
  notes: string[];
}

export async function routeWithFreerouting(project: string, unit = "", passes = 30): Promise<RouteReport> {
  const dir = storage.projectDir(project, unit);
  const notes: string[] = [];
  const t0 = Date.now();

  const dsn = await kicadPy(dir, `
import pcbnew
b = pcbnew.LoadBoard('/work/board.kicad_pcb')
ok = pcbnew.ExportSpecctraDSN(b, '/work/board.dsn')
print('dsn', ok)
`);
  if (!/dsn True/.test(dsn.out)) return { ok: false, seconds: 0, tracks: 0, vias: 0, open: 0, drcViolations: 0, drcUnconnected: 0, drcByRule: [], notes: [`DSN export failed: ${dsn.out.trim().split("\n").pop()}`] };

  await run(["chmod", "777", dir], 10000);
  const fr = await run([DOCKER, "run", "--rm", "--user", "root", "-v", `${dir}:/work`, FREEROUTING,
    "java", "-jar", "/app/freerouting-executable.jar", "--user_data_path=/work/.freerouting", "--gui-enabled=false",
    "-de", "/work/board.dsn", "-do", "/work/board.ses", "-mp", String(passes), "-mt", "8"], 3600000);
  await run(["rm", "-rf", `${dir}/.freerouting`], 10000);
  if (!existsSync(join(dir, "board.ses"))) return { ok: false, seconds: (Date.now() - t0) / 1000, tracks: 0, vias: 0, open: 0, drcViolations: 0, drcUnconnected: 0, drcByRule: [], notes: [`Freerouting wrote no session: ${fr.out.split("\n").filter((l) => /ERROR|Exception/.test(l)).slice(-2).join(" | ")}`] };
  const frInfo = fr.out.split("\n").filter((l) => /INFO/.test(l) && /rout|pass|complete/i.test(l)).slice(-2).map((l) => l.replace(/^.*INFO\s+/, ""));
  notes.push(...frInfo);

  const imp = await kicadPy(dir, `
import pcbnew
b = pcbnew.LoadBoard('/work/board.kicad_pcb')
pcbnew.ImportSpecctraSES(b, '/work/board.ses')
zones = b.Zones()
pcbnew.ZONE_FILLER(b).Fill(zones)
b.BuildConnectivity()
pcbnew.SaveBoard('/work/board.kicad_pcb', b)
tracks = [t for t in b.GetTracks() if t.GetClass() == 'PCB_TRACK']
vias = [t for t in b.GetTracks() if t.GetClass() == 'PCB_VIA']
print('result %d %d %d' % (len(tracks), len(vias), b.GetConnectivity().GetUnconnectedCount(True)))
`);
  const m = imp.out.match(/result (\d+) (\d+) (\d+)/);
  const tracks = m ? Number(m[1]) : 0, vias = m ? Number(m[2]) : 0, open = m ? Number(m[3]) : 0;

  const drc = await runDrcJson(project, unit);
  await syncFromKicad(project, unit);
  return { ok: open === 0 && drc.violations === 0, seconds: (Date.now() - t0) / 1000, tracks, vias, open, drcViolations: drc.violations, drcUnconnected: drc.unconnected, drcByRule: drc.byRule, notes };
}

async function runDrcJson(project: string, unit: string): Promise<{ violations: number; unconnected: number; byRule: { rule: string; count: number }[] }> {
  const dir = storage.projectDir(project, unit);
  await run([DOCKER, "run", "--rm", "-v", `${dir}:/work`, "-w", "/work", KICAD, "kicad-cli", "pcb", "drc", "--format", "json", "--severity-all", "--output", "/work/drc.json", "/work/board.kicad_pcb"], 600000);
  try {
    const rep = JSON.parse(await storage.readFile(project, "drc.json", unit));
    const counts = new Map<string, number>();
    for (const v of rep.violations ?? []) counts.set(`${v.severity}:${v.type}`, (counts.get(`${v.severity}:${v.type}`) ?? 0) + 1);
    return { violations: (rep.violations ?? []).length, unconnected: (rep.unconnected_items ?? []).length, byRule: [...counts].map(([rule, count]) => ({ rule, count })).sort((a, b) => b.count - a.count) };
  } catch {
    return { violations: -1, unconnected: -1, byRule: [] };
  }
}

// Copper KiCad now holds (tracks, vias, zone fills) back into board.loon.json,
// so the layout view shows the routed board.
export async function syncFromKicad(project: string, unit = ""): Promise<{ tracks: number; vias: number; filled: number }> {
  const text = await storage.readFile(project, "board.kicad_pcb", unit);
  const root = parse(text);
  const netNames = new Map<number, string>();
  for (const n of findAll(root, "net")) {
    if (n.items[1]?.kind === "atom" && n.items[2]?.kind === "atom") netNames.set(Number(n.items[1].value), n.items[2].value);
  }
  const num = (l: any, i: number) => Number(l?.items?.[i]?.value ?? 0);
  const tracks: Track[] = [];
  for (const s of findAll(root, "segment")) {
    const st = find(s, "start"), en = find(s, "end"), w = find(s, "width"), ly = find(s, "layer"), nt = find(s, "net");
    tracks.push({ uuid: crypto.randomUUID(), layer: (ly?.items[1] as any)?.value ?? "F.Cu", width: num(w, 1), start: { x: num(st, 1), y: num(st, 2) }, end: { x: num(en, 1), y: num(en, 2) }, net: netNames.get(num(nt, 1)) ?? "" });
  }
  const vias: Via[] = [];
  for (const v of findAll(root, "via")) {
    const at = find(v, "at"), sz = find(v, "size"), dr = find(v, "drill"), nt = find(v, "net");
    vias.push({ uuid: crypto.randomUUID(), at: { x: num(at, 1), y: num(at, 2) }, size: num(sz, 1), drill: num(dr, 1), net: netNames.get(num(nt, 1)) ?? "" });
  }
  const board = JSON.parse(await storage.readFile(project, "board.loon.json", unit)) as Board;
  board.tracks = tracks;
  board.vias = vias;
  const fills = readZoneFills(text);
  let filled = 0;
  for (const z of board.zones) {
    const hit = fills.find((f) => f.net === z.net && f.layer === z.layer);
    if (hit) { z.filled = hit.polys; filled++; }
  }
  await storage.writeFile(project, "board.loon.json", JSON.stringify(board, null, 2), unit);
  return { tracks: tracks.length, vias: vias.length, filled };
}

// #region 3D models
// Fetched on demand from KiCad's 3D library, like footprints. A model that is
// not there is reported, not faked.
export async function fetchModels(pcbText: string): Promise<{ fetched: number; missing: string[] }> {
  const refs = new Set<string>();
  for (const m of pcbText.matchAll(/\(model "\$\{KICAD9_3DMODEL_DIR\}\/([^"]+)"/g)) refs.add(m[1]);
  let fetched = 0;
  const missing: string[] = [];
  for (const rel of refs) {
    const target = join(MODELS_DIR, "kicad", rel);
    if (existsSync(target)) continue;
    mkdirSync(join(MODELS_DIR, "kicad", rel.split("/")[0]), { recursive: true });
    try {
      const res = await fetch(`https://gitlab.com/kicad/libraries/kicad-packages3D/-/raw/${MODEL_REF}/${rel}`, { signal: AbortSignal.timeout(30000) });
      if (!res.ok || (res.headers.get("content-type") ?? "").includes("html")) { missing.push(rel); continue; }
      await Bun.write(target, await res.arrayBuffer());
      fetched++;
    } catch {
      missing.push(rel);
    }
  }
  return { fetched, missing };
}

// #region render
export const RENDERS = ["render-top.png", "render-bottom.png", "render-iso.png", "layers.svg"] as const;

export async function renderBoard(project: string, unit = ""): Promise<{ images: string[]; missingModels: string[]; notes: string[] }> {
  const dir = storage.projectDir(project, unit);
  const pcb = await storage.readFile(project, "board.kicad_pcb", unit);
  const models = await fetchModels(pcb);
  mkdirSync(join(MODELS_DIR, "lcsc.3dshapes"), { recursive: true });
  const mounts = ["-v", `${dir}:/work`, "-v", `${join(MODELS_DIR, "kicad")}:/models/kicad:ro`, "-v", `${join(MODELS_DIR, "lcsc.3dshapes")}:/work/lcsc.3dshapes:ro`, "-e", "KICAD9_3DMODEL_DIR=/models/kicad", "-w", "/work"];
  const base = [DOCKER, "run", "--rm", ...mounts, KICAD, "kicad-cli", "pcb"];
  const notes: string[] = [];
  const views: [string, string[]][] = [
    ["render-top.png", ["--side", "top"]],
    ["render-bottom.png", ["--side", "bottom"]],
    ["render-iso.png", ["--rotate", "-40,0,30", "--perspective", "--zoom", "1.1", "--floor"]],
  ];
  for (const [name, extra] of views) {
    const r = await run([...base, "render", "--output", `/work/${name}`, "--width", "1800", "--height", "1300", "--quality", "high", "--background", "opaque", ...extra, "/work/board.kicad_pcb"], 900000);
    if (r.code !== 0) notes.push(`${name}: ${r.out.trim().split("\n").pop()}`);
  }
  const svg = await run([...base, "export", "svg", "--output", "/work/layers.svg", "--layers", "F.Cu,B.Cu,F.SilkS,B.SilkS,Edge.Cuts,F.Mask", "--page-size-mode", "2", "--exclude-drawing-sheet", "/work/board.kicad_pcb"], 300000);
  if (svg.code !== 0) notes.push(`layers.svg: ${svg.out.trim().split("\n").pop()}`);
  const images = RENDERS.filter((n) => existsSync(join(dir, n)));
  return { images, missingModels: models.missing, notes };
}

export function renderList(project: string, unit = ""): string[] {
  const dir = storage.projectDir(project, unit);
  return RENDERS.filter((n) => existsSync(join(dir, n)));
}
