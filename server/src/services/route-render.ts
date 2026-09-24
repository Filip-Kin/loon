// #region Autorouting and rendering through KiCad + Freerouting
// loon's own router is a first-pass grid router. For a real board the work goes
// to Freerouting, with KiCad on both ends: it exports the Specctra DSN (with
// the net classes, so power nets come out wide), imports the SES, fills the
// zones and runs DRC. All of it runs in containers; nothing is installed on
// the host. Renders come from kicad-cli's raytracer with the 3D models fetched
// per board from KiCad's library, plus the LCSC models easyeda2kicad wrote.

import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { storage } from "./storage";
import { parse, findAll, find, value } from "@loon/shared/sexpr";
import { readZoneFills } from "@loon/shared/kicad-pcb";
import { KICAD_IMAGE, KICAD_LIB_REF, KICAD_3DMODEL_VARS, KICAD_NET_SETTINGS_VERSION } from "@loon/shared/kicad-version";
import type { Board, BoardText, Track, Via } from "@loon/shared/board";
import type { Point } from "@loon/shared/schematic";

const KICAD = process.env.LOON_KICAD_IMAGE ?? KICAD_IMAGE;
const FREEROUTING = process.env.LOON_FREEROUTING_IMAGE ?? "ghcr.io/freerouting/freerouting:latest";
const DOCKER = process.env.LOON_DOCKER_BIN ?? "docker";
export const MODELS_DIR = process.env.LOON_3D_DIR ?? join(process.cwd(), "data", "3dmodels");
const MODEL_REF = process.env.LOON_3D_REF ?? KICAD_LIB_REF;

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
  // Widths are for 2 oz outer copper (JLC option): 1.5 mm carries 5 A at
  // about 10 C rise, 1.2 mm 3 A, 0.6 mm 1 A.
  heavy?: string[];   // 1.5 mm: the input bus and anything carrying 5 A
  wide?: string[];    // 1.2 mm: a 3 A rail
  power: string[];    // 0.6 mm
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
  // net_settings v4 gives every class a priority; Default keeps INT_MAX so any
  // named class wins the pattern match. The named ones are disjoint here, so
  // the order is only a tie-break.
  const named = (i: number) => ({ ...def, priority: i });
  pro.net_settings.classes = [
    def,
    // One clearance everywhere: the router and DRC must agree, and a wider
    // class clearance only shows up as DRC errors against the narrow one.
    { ...named(0), name: "Heavy", track_width: 1.5, clearance: 0.18, via_diameter: 1.0, via_drill: 0.5 },
    { ...named(1), name: "Wide", track_width: 1.2, clearance: 0.18, via_diameter: 0.9, via_drill: 0.5 },
    { ...named(2), name: "Power", track_width: 0.6, clearance: 0.18, via_diameter: 0.8, via_drill: 0.4 },
    { ...named(3), name: "Logic", track_width: 0.4, clearance: 0.2 },
    { ...named(4), name: "Ethernet", track_width: 0.3, clearance: 0.2, diff_pair_width: 0.3, diff_pair_gap: 0.2 },
  ];
  pro.net_settings.meta = { ...(pro.net_settings.meta ?? {}), version: KICAD_NET_SETTINGS_VERSION };
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
  // A GND pour region that a pad keeps alive but nothing joins to the rest
  // of the net gets a via inside it, so the other side's pour picks it up;
  // then fill again. Three rounds, inside one KiCad session.
  if (!o.routeGnd && m) {
    prog.set({ stage: "drc", fraction: 0.965, etaSeconds: 60 });
    const st = await kicadPy(dir, STITCH_SCRIPT);
    const sm = st.out.match(/stitched (\d+) vias, (\d+) regions left/);
    if (!sm) notes.push(`GND stitching failed: ${st.out.trim().split("\n").pop()}`);
    else if (Number(sm[1]) || Number(sm[2])) notes.push(`GND stitching: ${sm[1]} vias added, ${sm[2]} cut-off regions left`);
  }
  prog.set({ stage: "drc", fraction: 0.98, etaSeconds: 30 });
  const drc = await runDrcJson(project, unit);
  await syncFromKicad(project, unit);
  const ok = open === 0 && drc.violations === 0;
  prog.finish(ok, `${tracks} tracks, ${open} open, ${drc.violations} DRC`);
  return { ok, seconds: (Date.now() - t0) / 1000, tracks, vias, open, drcViolations: drc.violations, drcUnconnected: drc.unconnected, drcByRule: drc.byRule, notes };
}

// Every filled GND region on a layer other than the largest is cut off from
// the rest of the net (KiCad keeps it because a pad sits in it). A via inside
// it, clear of other nets, joins it to the other side's pour.
const STITCH_SCRIPT = `
import pcbnew, math
b = pcbnew.LoadBoard('/work/board.kicad_pcb')
MM = pcbnew.FromMM
gnd = b.GetNetcodeFromNetname('GND')
gz = [z for z in b.Zones() if z.GetNetCode() == gnd]
R = MM(0.3) + MM(0.25)
def clear(c):
    for fp in b.GetFootprints():
        for pad in fp.Pads():
            if pad.GetNetCode() == gnd: continue
            sz = pad.GetSize()
            if (pad.GetPosition() - c).EuclideanNorm() < R + max(sz.x, sz.y) / 2: return False
    for t in b.Tracks():
        if t.GetNetCode() == gnd: continue
        if t.GetClass() == 'PCB_VIA':
            if (t.GetPosition() - c).EuclideanNorm() < R + t.GetWidth() / 2: return False
        elif pcbnew.SEG(t.GetStart(), t.GetEnd()).Distance(c) < R + t.GetWidth() / 2: return False
    return True
def inside(polys, i, c):
    # the via ring has to sit in the region
    for k in range(8):
        a = k * math.pi / 4
        q = pcbnew.VECTOR2I(int(c.x + MM(0.4) * math.cos(a)), int(c.y + MM(0.4) * math.sin(a)))
        if not polys.Contains(q, i): return False
    return polys.Contains(c, i)
def regions():
    out = []
    for z in gz:
        for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
            if not z.IsOnLayer(layer): continue
            polys = z.GetFilledPolysList(layer)
            n = polys.OutlineCount()
            if n < 2: continue
            main = max(range(n), key=lambda i: polys.Outline(i).Area())
            for i in range(n):
                if i != main: out.append((polys, i))
    return out
added = 0
left = 0
for rnd in range(3):
    regs = regions()
    left = len(regs)
    if not regs: break
    got = 0
    for polys, i in regs:
        ol = polys.Outline(i)
        bb = ol.BBox()
        cands = [bb.Centre()]
        step = max(1, ol.PointCount() // 16)
        for k in range(0, ol.PointCount(), step):
            p = ol.CPoint(k)
            # pull each vertex toward the box centre a little
            cands.append(pcbnew.VECTOR2I(int(p.x + (bb.Centre().x - p.x) * 0.3), int(p.y + (bb.Centre().y - p.y) * 0.3)))
        # a region that already holds a GND via is not reaching the other
        # side's pour there; another via would not help
        if any(t.GetClass() == 'PCB_VIA' and t.GetNetCode() == gnd and polys.Contains(t.GetPosition(), i) for t in b.Tracks()): continue
        for c in cands:
            if not inside(polys, i, c) or not clear(c): continue
            if any(t.GetClass() == 'PCB_VIA' and (t.GetPosition() - c).EuclideanNorm() < MM(0.9) for t in b.Tracks()): continue
            v = pcbnew.PCB_VIA(b); v.SetPosition(c); v.SetWidth(MM(0.6)); v.SetDrill(MM(0.3)); v.SetNetCode(gnd); v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu); b.Add(v)
            got += 1
            break
    added += got
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    b.BuildConnectivity()
    if got == 0: break
left = len(regions())
pcbnew.SaveBoard('/work/board.kicad_pcb', b)
print('stitched %d vias, %d regions left' % (added, left))
`;

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

// Everything KiCad now holds back into board.loon.json, so the layout view
// shows the board as it is on disk. Copper after a route, and placement and
// silkscreen after the user has had the board open in KiCad themselves - loon
// does not own the file while it is in someone else's editor.
export async function syncFromKicad(project: string, unit = ""): Promise<{ tracks: number; vias: number; filled: number; moved: number; texts: number }> {
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

  // Placement, matched by reference designator. A part KiCad does not have is
  // left alone rather than dropped: the schematic owns which parts exist.
  let moved = 0;
  const placed = new Map<string, { at: Point; rotation: number; side: "F" | "B" }>();
  for (const f of findAll(root, "footprint")) {
    let ref = "";
    for (const pr of findAll(f, "property")) {
      if (pr.items[1]?.kind === "atom" && pr.items[1].value === "Reference" && pr.items[2]?.kind === "atom") ref = pr.items[2].value;
    }
    if (!ref) for (const t of findAll(f, "fp_text")) {
      if (t.items[1]?.kind === "atom" && t.items[1].value === "reference" && t.items[2]?.kind === "atom") ref = t.items[2].value;
    }
    if (!ref) continue;
    const at = find(f, "at");
    const layer = value(f, "layer") ?? "F.Cu";
    placed.set(ref, {
      at: { x: num(at, 1), y: num(at, 2) },
      rotation: (((at && at.items.length > 3 ? num(at, 3) : 0) % 360) + 360) % 360,
      side: layer.startsWith("B.") ? "B" : "F",
    });
  }
  for (const f of board.footprints) {
    const p = placed.get(f.ref);
    if (!p) continue;
    if (f.at.x !== p.at.x || f.at.y !== p.at.y || f.rotation !== p.rotation || f.side !== p.side) moved++;
    f.at = p.at;
    f.rotation = p.rotation;
    f.side = p.side;
  }

  // Free silkscreen, which is the one thing on the board with no source in the
  // schematic, so KiCad's copy is the only copy.
  const texts: BoardText[] = [];
  for (const t of findAll(root, "gr_text")) {
    const at = find(t, "at");
    const eff = find(t, "effects");
    const font = eff ? find(eff, "font") : undefined;
    const size = font ? num(find(font, "size"), 1) : 1;
    texts.push({
      uuid: value(t, "uuid") ?? crypto.randomUUID(),
      text: t.items[1]?.kind === "atom" ? t.items[1].value : "",
      at: { x: num(at, 1), y: num(at, 2) },
      rotation: at && at.items.length > 3 ? num(at, 3) : 0,
      layer: value(t, "layer") ?? "F.SilkS",
      size: size || 1,
      thickness: font ? num(find(font, "thickness"), 1) || undefined : undefined,
      bold: font ? !!find(font, "bold") : false,
    });
  }
  board.texts = texts;

  const fills = readZoneFills(text);
  let filled = 0;
  for (const z of board.zones) {
    const hit = fills.find((f) => f.net === z.net && f.layer === z.layer);
    if (hit) { z.filled = hit.polys; filled++; }
  }
  await storage.writeFile(project, "board.loon.json", JSON.stringify(board, null, 2), unit);
  return { tracks: tracks.length, vias: vias.length, filled, moved, texts: texts.length };
}

// #region disk watch
// KiCad saves board.kicad_pcb behind loon's back. The editor polls this and
// pulls the file in when it is newer than loon's own model of it.
export async function boardDiskState(project: string, unit = ""): Promise<{ pcb: number; loon: number }> {
  const dir = storage.projectDir(project, unit);
  const at = async (name: string) => {
    try { return (await stat(join(dir, name))).mtimeMs; } catch { return 0; }
  };
  return { pcb: await at("board.kicad_pcb"), loon: await at("board.loon.json") };
}

// #region 3D models
// Fetched on demand from KiCad's 3D library, like footprints. A model that is
// not there is reported, not faked.
export async function fetchModels(pcbText: string): Promise<{ fetched: number; missing: string[] }> {
  const refs = new Set<string>();
  // The cache holds footprints from more than one library tag, and each tag
  // names the model directory after its own KiCad. Read every name KiCad knows.
  const varNames = KICAD_3DMODEL_VARS.join("|");
  for (const m of pcbText.matchAll(new RegExp(`\\(model "\\$\\{(?:${varNames})\\}/([^"]+)"`, "g"))) refs.add(m[1]);
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
  const modelEnv = KICAD_3DMODEL_VARS.flatMap((v) => ["-e", `${v}=/models/kicad`]);
  const mounts = ["-v", `${dir}:/work`, "-v", `${join(MODELS_DIR, "kicad")}:/models/kicad:ro`, "-v", `${join(MODELS_DIR, "lcsc.3dshapes")}:/work/lcsc.3dshapes:ro`, ...modelEnv, "-w", "/work"];
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
