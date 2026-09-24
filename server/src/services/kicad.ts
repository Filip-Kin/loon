// #region KiCad CLI
// Runs KiCad's own DRC on the board loon wrote, in a container. loon's DRC is
// fast and lives in the browser; this is the authority, and it is the same
// engine OSH Park's own processing uses.

import { storage } from "./storage";
import { KICAD_IMAGE } from "@loon/shared/kicad-version";

const IMAGE = process.env.LOON_KICAD_IMAGE ?? KICAD_IMAGE;
const DOCKER = process.env.LOON_DOCKER_BIN ?? "docker";

export interface KicadViolation {
  severity: "error" | "warning";
  rule: string;
  message: string;
  items: string[];
}

export interface KicadDrcResult {
  ok: boolean;
  violations: KicadViolation[];
  unconnected: number;
  raw: string;
  error?: string;
}

export async function runKicadDrc(project: string, unit = ""): Promise<KicadDrcResult> {
  const dir = storage.projectDir(project, unit);
  const args = [
    "run", "--rm",
    "-v", `${dir}:/work`,
    "-w", "/work",
    IMAGE,
    "kicad-cli", "pcb", "drc", "--format", "json", "-o", "drc.json", "board.kicad_pcb",
  ];
  const proc = Bun.spawn([DOCKER, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;

  let report: any;
  try {
    report = JSON.parse(await storage.readFile(project, "drc.json", unit));
  } catch {
    return { ok: false, violations: [], unconnected: 0, raw: out + err, error: "KiCad could not load the board." };
  }

  const violations: KicadViolation[] = [];
  const collect = (arr: any[], fallback: "error" | "warning") => {
    for (const v of arr ?? []) {
      violations.push({
        severity: (v.severity as "error" | "warning") ?? fallback,
        rule: v.type ?? "drc",
        message: v.description ?? "",
        items: (v.items ?? []).map((i: any) => i.description ?? "").filter(Boolean),
      });
    }
  };
  collect(report.violations, "error");
  collect(report.schematic_parity, "warning");
  const unconnected = (report.unconnected_items ?? []).length;

  await storage.deleteFile(project, "drc.json", unit);
  return { ok: violations.filter((v) => v.severity === "error").length === 0, violations, unconnected, raw: out + err };
}

// #region zone fill
// KiCad's command line will not fill a zone, but the container ships pcbnew, and
// pcbnew has the same filler the GUI uses. A zone with no fill is a zone the fab
// never sees, so this runs after every board write.
const FILL_SCRIPT = `
import pcbnew

b = pcbnew.LoadBoard('/work/board.kicad_pcb')
zones = b.Zones()
if len(zones) == 0:
    print('no zones')
    raise SystemExit

pcbnew.ZONE_FILLER(b).Fill(zones)
b.BuildConnectivity()
pcbnew.SaveBoard('/work/board.kicad_pcb', b)

area = 0.0
for z in zones:
    area += z.GetFilledArea() / 1e12
left = b.GetConnectivity().GetUnconnectedCount(True)
print('filled %d zones, %.0f cm2 of copper, %d connections still open' % (len(zones), area / 100, left))
`;

export async function fillZones(project: string, unit = ""): Promise<{ ok: boolean; note: string }> {
  const dir = storage.projectDir(project, unit);
  const proc = Bun.spawn(
    [DOCKER, "run", "--rm", "-v", `${dir}:/work`, "-w", "/work", IMAGE, "python3", "-c", FILL_SCRIPT],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  const note = out.trim().split("\n").filter(Boolean).pop() ?? err.trim().slice(0, 120);
  return { ok: code === 0, note };
}
