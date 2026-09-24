// #region Autorouting and rendering through KiCad + Freerouting
// loon's own router is a first-pass grid router. For a real board the work goes
// to Freerouting, with KiCad on both ends: it exports the Specctra DSN (with
// the net classes, so power nets come out wide), imports the SES, fills the
// zones and runs DRC. All of it runs in containers; nothing is installed on
// the host. Renders come from kicad-cli's raytracer with the 3D models fetched
// per board from KiCad's library, plus the LCSC models easyeda2kicad wrote.

import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
// Same as run(), but hands each stdout line to the caller as it arrives.
async function runStreaming(args: string[], timeoutMs: number, onLine: (l: string) => void): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const lines: string[] = [];
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      lines.push(l); onLine(l);
    }
  }
  if (buf) { lines.push(buf); onLine(buf); }
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, out: lines.join("\n") + err };
}

// #region progress
// Where a route run is, for the editor's progress bar. Written to the
// project dir so a run started from the CLI shows up in the UI too.
export interface RouteProgress {
  running: boolean;
  stage: "export" | "fanout" | "route" | "optimize" | "import" | "drc" | "done" | "failed";
  pass: number;          // current pass within the stage
  passes: number;        // pass budget for the route stage
  unrouted: number;      // open items after the last pass
  violations: number;
  fraction: number;      // 0..1 across the whole run
  etaSeconds: number | null;
  startedAt: number;
  updatedAt: number;
  note: string;
}
const PROGRESS_FILE = "route-progress.json";
export async function readRouteProgress(project: string, unit = ""): Promise<RouteProgress | null> {
  const f = join(storage.projectDir(project, unit), PROGRESS_FILE);
  if (!existsSync(f)) return null;
  try { return JSON.parse(await Bun.file(f).text()) as RouteProgress; } catch { return null; }
}

class ProgressTracker {
  p: RouteProgress;
  private passTimes: number[] = [];
  private unroutedHist: number[] = [];
  private lastWrite = 0;
  constructor(private file: string, passes: number) {
    this.p = { running: true, stage: "export", pass: 0, passes, unrouted: 0, violations: 0, fraction: 0, etaSeconds: null, startedAt: Date.now(), updatedAt: Date.now(), note: "" };
    this.flush(true);
  }
  set(patch: Partial<RouteProgress>) { Object.assign(this.p, patch); this.flush(); }
  // Parse one Freerouting log line. Fanout, routing and optimizer passes each
  // say how long they took and how much is still open.
  line(l: string) {
    let m: RegExpMatchArray | null;
    if ((m = l.match(/Fanout pass #(\d+) .* completed in ([\d.]+) seconds .* (\d+) not routed/))) {
      this.set({ stage: "fanout", pass: +m[1], unrouted: +m[3], fraction: Math.min(0.1, 0.02 + +m[1] * 0.01), etaSeconds: this.eta() });
    } else if ((m = l.match(/Auto-routing stage started .* for (\d+) unrouted items/))) {
      this.unroutedHist = [+m[1]]; this.passTimes = [];
      this.set({ stage: "route", pass: 0, unrouted: +m[1], fraction: 0.1, etaSeconds: this.eta() });
    } else if ((m = l.match(/Auto-routing pass #(\d+) .* completed in ([\d.]+) seconds with score [\d.]+ \((\d+) unrouted and (\d+) violations/))) {
      this.passTimes.push(+m[2]); this.unroutedHist.push(+m[3]);
      const byPass = +m[1] / this.p.passes;
      const start = this.unroutedHist[0] || 1;
      const byItems = 1 - +m[3] / start;
      this.set({ stage: "route", pass: +m[1], unrouted: +m[3], violations: +m[4], fraction: 0.1 + 0.75 * Math.max(byPass, byItems), etaSeconds: this.eta() });
    } else if ((m = l.match(/Optimizer pass #(\d+) .* completed in ([\d.]+) seconds with the score of [\d.]+ \((\d+) unrouted and (\d+) violations/))) {
      this.set({ stage: "optimize", pass: +m[1], unrouted: +m[3], violations: +m[4], fraction: Math.min(0.95, 0.85 + +m[1] * 0.03), etaSeconds: this.eta() });
    } else if (/Optimization stage started/.test(l)) {
      this.set({ stage: "optimize", pass: 0, fraction: 0.85, etaSeconds: this.eta() });
    }
  }
  // Route passes get shorter and clear fewer items as they go; the estimate
  // takes the mean pass time and the recent clearing rate, and stops at the
  // pass budget. The optimizer is allowed two passes on top.
  private eta(): number | null {
    const st = this.p.stage;
    const mean = this.passTimes.length ? this.passTimes.reduce((a, b) => a + b, 0) / this.passTimes.length : null;
    if (st === "fanout") return null;
    if (st === "route") {
      if (mean === null) return null;
      const h = this.unroutedHist;
      const left = this.p.passes - this.p.pass;
      let passesLeft = left;
      if (h.length >= 3) {
        const recent = h.slice(-3);
        const rate = (recent[0] - recent[recent.length - 1]) / (recent.length - 1);
        if (rate > 0) passesLeft = Math.min(left, Math.ceil(this.p.unrouted / rate));
        else passesLeft = Math.min(left, 3);   // stalls end the stage after 3 flat passes
      }
      return Math.round(passesLeft * mean + 2 * mean);
    }
    if (st === "optimize") return mean === null ? null : Math.round(Math.max(1, 2 - this.p.pass) * mean);
    return null;
  }
  private flush(force = false) {
    this.p.updatedAt = Date.now();
    if (!force && Date.now() - this.lastWrite < 500) return;
    this.lastWrite = Date.now();
    try { writeFileSync(this.file, JSON.stringify(this.p)); } catch {}
  }
  finish(ok: boolean, note: string) { this.set({ running: false, stage: ok ? "done" : "failed", fraction: 1, etaSeconds: 0, note }); this.flush(true); }
}
// #endregion

const kicadPy = (dir: string, script: string, extra: string[] = []) =>
  run([DOCKER, "run", "--rm", "-v", `${dir}:/work`, "-w", "/work", ...extra, KICAD, "python3", "-c", script], 600000);

// #region net classes
// Which nets get wide copper. A rail is anything that carries the load; the
// names are loon's conventions plus whatever the caller adds.
export interface NetClassPlan {
  heavy?: string[];   // 2.5 mm: the input bus and anything carrying 5 A
  wide?: string[];    // 2.0 mm: a 3 A rail
  power: string[];    // 1.0 mm
  logic?: string[];
  ethernet?: string[];
}
export function defaultNetClassPlan(board: Board): NetClassPlan {
  const nets = new Set<string>();
  for (const f of board.footprints) for (const n of Object.values(f.padNets)) nets.add(n);
  const all = [...nets];
  const heavy = all.filter((n) => /^(VIN|VIN_USB|VIN_USBS|VIN_DC|VBUS)$/.test(n));
  const wide = all.filter((n) => /^(LAPTOP_OUT|\+15V6_BUCK|\+15V6_S|\+12V|\+12V_BUCK)$/.test(n));
  return {
    heavy,
    wide,
    power: all.filter((n) => /^(\+\d|VIN|VBUS|PORT_[PN]$|PACK|LAPTOP_OUT|BOOST_SW|BOOST_CS|FAN_N|PSE_SENSE|PSE_AGND|TEST_NODE|_OUT$)/.test(n) && n !== "+3V3" && !heavy.includes(n) && !wide.includes(n)),
    logic: all.filter((n) => n === "+3V3"),
    ethernet: all.filter((n) => /^ETH_/.test(n)),
  };
}

export async function writeNetClasses(project: string, unit: string, plan: NetClassPlan): Promise<void> {
  const pro = JSON.parse(await storage.readFile(project, "board.kicad_pro", unit));
  // 0.18: the USB-C receptacle's pads sit 0.2 mm apart, and OSH Park and
  // JLC both allow 0.15.
  const def = { ...pro.net_settings.classes[0], clearance: 0.18 };
  pro.net_settings.classes = [
    def,
    // One clearance everywhere: the router and DRC must agree, and a wider
    // class clearance only shows up as DRC errors against the narrow one.
    { ...def, name: "Heavy", track_width: 2.5, clearance: 0.18, via_diameter: 1.2, via_drill: 0.6 },
    { ...def, name: "Wide", track_width: 2.0, clearance: 0.18, via_diameter: 1.0, via_drill: 0.5 },
    { ...def, name: "Power", track_width: 1.0, clearance: 0.18, via_diameter: 0.9, via_drill: 0.5 },
    { ...def, name: "Logic", track_width: 0.4, clearance: 0.2 },
    { ...def, name: "Ethernet", track_width: 0.3, clearance: 0.2, diff_pair_width: 0.3, diff_pair_gap: 0.2 },
  ];
  pro.net_settings.netclass_patterns = [
    ...(plan.heavy ?? []).map((n) => ({ netclass: "Heavy", pattern: n })),
    ...(plan.wide ?? []).map((n) => ({ netclass: "Wide", pattern: n })),
    ...plan.power.map((n) => ({ netclass: "Power", pattern: n })),
    ...(plan.logic ?? []).map((n) => ({ netclass: "Logic", pattern: n })),
    ...(plan.ethernet ?? []).map((n) => ({ netclass: "Ethernet", pattern: n })),
  ];
  await storage.writeFile(project, "board.kicad_pro", JSON.stringify(pro, null, 2), unit);
}

// Remove nets from a Specctra DSN's (network ...) section so the router leaves
// them alone. Pads keep their net in KiCad; only Freerouting stops caring.
async function stripNetsFromDsn(path: string, names: string[]): Promise<void> {
  let text = await Bun.file(path).text();
  for (const n of names) {
    // (net "GND" (pins ...)) or (net GND (pins ...)), possibly multi-line
    const re = new RegExp(`\\(net\\s+"?${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\s*\\(pins[^()]*(?:\\([^()]*\\)[^()]*)*\\)\\s*\\)`, "g");
    text = text.replace(re, "");
  }
  await Bun.write(path, text);
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

export interface RouteOptions {
  passes?: number;
  // Start from the previous session's copper instead of a blank board. Nets on
  // the given parts (moved since) are stripped first so the router redoes
  // only those and whatever was still open.
  keepTracks?: boolean;
  dirtyRefs?: string[];
  // Route GND as tracks as well; the pours still fill on top. Off, GND is
  // left to the pours alone, which strands any pad they cannot reach.
  routeGnd?: boolean;
  // Skip Freerouting and import the board.ses already there (after a fix
  // to the import step, or to re-read a finished run).
  importOnly?: boolean;
}

export async function routeWithFreerouting(project: string, unit = "", opts: RouteOptions | number = 30): Promise<RouteReport> {
  const o: RouteOptions = typeof opts === "number" ? { passes: opts } : opts;
  const passes = o.passes ?? 30;
  const dir = storage.projectDir(project, unit);
  const notes: string[] = [];
  const t0 = Date.now();
  const prog = new ProgressTracker(join(dir, PROGRESS_FILE), passes);
  const fail = (note: string): RouteReport => {
    prog.finish(false, note);
    return { ok: false, seconds: (Date.now() - t0) / 1000, tracks: 0, vias: 0, open: 0, drcViolations: 0, drcUnconnected: 0, drcByRule: [], notes: [...notes, note] };
  };

  if (o.importOnly) {
    if (!existsSync(join(dir, "board.ses"))) return fail("no board.ses to import");
    notes.push("imported the existing board.ses, Freerouting not run");
  }
  if (!o.importOnly && o.keepTracks && existsSync(join(dir, "board.ses"))) {
    const board = JSON.parse(await storage.readFile(project, "board.loon.json", unit)) as Board;
    const dirty = new Set<string>();
    for (const f of board.footprints) if ((o.dirtyRefs ?? []).includes(f.ref)) for (const n of Object.values(f.padNets)) dirty.add(n);
    const pre = await kicadPy(dir, `
import pcbnew
b = pcbnew.LoadBoard('/work/board.kicad_pcb')
pcbnew.ImportSpecctraSES(b, '/work/board.ses')
dirty = set(${JSON.stringify([...dirty])})
n = 0
for t in list(b.Tracks()):
    if t.GetNetname() in dirty:
        b.Remove(t); n += 1
pcbnew.SaveBoard('/work/board.kicad_pcb', b)
print('kept', len(list(b.Tracks())), 'dropped', n)
`);
    notes.push(`previous copper: ${pre.out.trim().split("\n").pop()} (nets on ${(o.dirtyRefs ?? []).join(", ") || "nothing"} redone)`);
  }

  if (!o.importOnly) {
    const dsn = await kicadPy(dir, `
  import pcbnew
  b = pcbnew.LoadBoard('/work/board.kicad_pcb')
  ok = pcbnew.ExportSpecctraDSN(b, '/work/board.dsn')
  print('dsn', ok)
  `);
    if (!/dsn True/.test(dsn.out)) return fail(`DSN export failed: ${dsn.out.trim().split("\n").pop()}`);

    // Ground is the pour on both sides; routing it as tracks wastes the router's
    // effort and the board's space. Take it out of the DSN's network section.
    if (!o.routeGnd) await stripNetsFromDsn(join(dir, "board.dsn"), ["GND"]);
    await run(["chmod", "777", dir], 10000);
    prog.set({ stage: "fanout", fraction: 0.02 });
    const fr = await runStreaming([DOCKER, "run", "--rm", "--user", "root", "-v", `${dir}:/work`, FREEROUTING,
      "java", "-jar", "/app/freerouting-executable.jar", "--user_data_path=/work/.freerouting", "--gui-enabled=false",
      "-de", "/work/board.dsn", "-do", "/work/board.ses", "-mp", String(passes), "-mt", "8"], 3600000, (l) => prog.line(l));
    // Freerouting ran as root, so its scratch dir and the SES are root's: clean
    // up and hand them back the same way.
    await run([DOCKER, "run", "--rm", "--user", "root", "-v", `${dir}:/work`, "--entrypoint", "sh", FREEROUTING, "-c", `rm -rf /work/.freerouting; chown ${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000} /work/board.ses /work/board.dsn 2>/dev/null; true`], 30000);
    if (!existsSync(join(dir, "board.ses"))) return fail(`Freerouting wrote no session: ${fr.out.split("\n").filter((l) => /ERROR|Exception/.test(l)).slice(-2).join(" | ")}`);
    prog.set({ stage: "import", fraction: 0.95, etaSeconds: 60 });
    const frInfo = fr.out.split("\n").filter((l) => /INFO/.test(l) && /rout|pass|complete/i.test(l)).slice(-2).map((l) => l.replace(/^.*INFO\s+/, ""));
    notes.push(...frInfo);
  }

  // Ground is the pour. Import the session and fill.
  prog.set({ stage: "import", fraction: 0.95, etaSeconds: 90 });
  const imp = await kicadPy(dir, `
import pcbnew
b = pcbnew.LoadBoard('/work/board.kicad_pcb')
pcbnew.ImportSpecctraSES(b, '/work/board.ses')
pcbnew.ZONE_FILLER(b).Fill(b.Zones())
b.BuildConnectivity()
pcbnew.SaveBoard('/work/board.kicad_pcb', b)
tracks = [t for t in b.Tracks() if t.GetClass() == 'PCB_TRACK']
vias = [t for t in b.Tracks() if t.GetClass() == 'PCB_VIA']
print('result %d %d %d' % (len(tracks), len(vias), b.GetConnectivity().GetUnconnectedCount(True)))
`);
  const m = imp.out.match(/result (\d+) (\d+) (\d+)/);
  const tracks = m ? Number(m[1]) : 0, vias = m ? Number(m[2]) : 0, open = m ? Number(m[3]) : 0;
  if (!m) notes.push(`import failed: ${imp.out.trim().split("\n").slice(-3).join(" | ")}`);
  // Any GND pad the pour left on its own (KiCad's DRC lists them) gets a
  // via beside it and a stub, so the other side's pour picks it up; then
  // fill again and ask DRC again. Two rounds.
  if (!o.routeGnd && m) {
    let added = 0;
    for (let round = 0; round < 2; round++) {
      prog.set({ stage: "drc", fraction: 0.96 + round * 0.01, etaSeconds: 60 });
      const gndPads = await unconnectedGndPads(project, unit);
      if (round === 0) notes.push(`GND ends without ground after the fill: ${gndPads.length}`);
      if (!gndPads.length) break;
      const st = await kicadPy(dir, stitchScript(gndPads));
      const sm = st.out.match(/stitched (\d+) of (\d+)/);
      if (!sm) { notes.push(`GND stitching failed: ${st.out.trim().split("\n").pop()}`); break; }
      added += Number(sm[1]);
      if (Number(sm[1]) === 0) break;
    }
    if (added) notes.push(`GND stitching: ${added} vias added`);
  }

  prog.set({ stage: "drc", fraction: 0.98, etaSeconds: 30 });
  const drc = await runDrcJson(project, unit);
  await syncFromKicad(project, unit);
  const ok = open === 0 && drc.violations === 0;
  prog.finish(ok, `${tracks} tracks, ${open} open, ${drc.violations} DRC`);
  return { ok, seconds: (Date.now() - t0) / 1000, tracks, vias, open, drcViolations: drc.violations, drcUnconnected: drc.unconnected, drcByRule: drc.byRule, notes };
}

// GND items KiCad's DRC reports as unconnected: both ends of every open
// GND link (pads, or track and via ends), by position.
async function unconnectedGndPads(project: string, unit: string): Promise<{ x: number; y: number }[]> {
  await runDrcJson(project, unit);
  const f = join(storage.projectDir(project, unit), "drc.json");
  if (!existsSync(f)) return [];
  const d = JSON.parse(await Bun.file(f).text()) as { unconnected_items?: { items: { description: string; pos: { x: number; y: number } }[] }[] };
  const out: { x: number; y: number }[] = [];
  const seen = new Set<string>();
  for (const u of d.unconnected_items ?? []) for (const it of u.items) {
    if (!/\[GND\]/.test(it.description)) continue;
    const k = `${it.pos.x},${it.pos.y}`;
    if (!seen.has(k)) { seen.add(k); out.push(it.pos); }
  }
  return out;
}
// A via 0.7 mm off each listed pad (first of eight directions with room)
// and a stub to it, then a fresh fill.
function stitchScript(pads: { x: number; y: number }[]): string {
  return `
import pcbnew, math, json
b = pcbnew.LoadBoard('/work/board.kicad_pcb')
MM = pcbnew.FromMM
gnd = b.GetNetcodeFromNetname('GND')
want = json.loads('${JSON.stringify(pads)}')
def clear(c, r):
    for fp in b.GetFootprints():
        for pad in fp.Pads():
            if pad.GetNetCode() == gnd: continue
            sz = pad.GetSize()
            if (pad.GetPosition() - c).EuclideanNorm() < r + max(sz.x, sz.y) / 2: return False
    for t in b.Tracks():
        if t.GetNetCode() == gnd: continue
        if t.GetClass() == 'PCB_VIA':
            if (t.GetPosition() - c).EuclideanNorm() < r + t.GetWidth() / 2: return False
        elif pcbnew.SEG(t.GetStart(), t.GetEnd()).Distance(c) < r + t.GetWidth() / 2: return False
    return True
done = 0
for w in want:
    target = pcbnew.VECTOR2I(MM(w['x']), MM(w['y']))
    pad = None
    for fp in b.GetFootprints():
        for q in fp.Pads():
            if q.GetNetCode() == gnd and (q.GetPosition() - target).EuclideanNorm() < MM(0.05): pad = q
    if pad is None:
        # a track or via end: a via right there ties it to the other side's pour
        tr = None
        for t in b.Tracks():
            if t.GetNetCode() == gnd and t.GetClass() == 'PCB_TRACK' and pcbnew.SEG(t.GetStart(), t.GetEnd()).Distance(target) < MM(0.05): tr = t
        if tr is None: continue
        if clear(target, MM(0.3) + MM(0.25)):
            v = pcbnew.PCB_VIA(b); v.SetPosition(target); v.SetWidth(MM(0.6)); v.SetDrill(MM(0.3)); v.SetNetCode(gnd); v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu); b.Add(v)
            done += 1
        continue
    p = pad.GetPosition(); sz = pad.GetSize()
    d = max(sz.x, sz.y) / 2 + MM(0.7)
    layer = pcbnew.F_Cu if pad.IsOnLayer(pcbnew.F_Cu) else pcbnew.B_Cu
    for k in range(8):
        a = k * math.pi / 4
        c = pcbnew.VECTOR2I(int(p.x + d * math.cos(a)), int(p.y + d * math.sin(a)))
        if not clear(c, MM(0.3) + MM(0.25)): continue
        v = pcbnew.PCB_VIA(b); v.SetPosition(c); v.SetWidth(MM(0.6)); v.SetDrill(MM(0.3)); v.SetNetCode(gnd); v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu); b.Add(v)
        t = pcbnew.PCB_TRACK(b); t.SetStart(p); t.SetEnd(c); t.SetWidth(MM(0.4)); t.SetLayer(layer); t.SetNetCode(gnd); b.Add(t)
        done += 1
        break
pcbnew.ZONE_FILLER(b).Fill(b.Zones())
b.BuildConnectivity()
pcbnew.SaveBoard('/work/board.kicad_pcb', b)
print('stitched %d of %d' % (done, len(want)))
`;
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
    ["render-top.png", ["--side", "top", "--zoom", "0.7"]],
    ["render-bottom.png", ["--side", "bottom", "--zoom", "0.7"]],
    ["render-iso.png", ["--rotate", "-40,0,30", "--perspective", "--zoom", "0.6", "--floor"]],
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
