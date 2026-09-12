// #region KiCad CLI
// Runs KiCad's own DRC on the board loon wrote, in a container. loon's DRC is
// fast and lives in the browser; this is the authority, and it is the same
// engine OSH Park's own processing uses.

import { storage } from "./storage";

const IMAGE = process.env.LOON_KICAD_IMAGE ?? "ghcr.io/kicad/kicad:9.0";
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

export async function runKicadDrc(project: string): Promise<KicadDrcResult> {
  const dir = storage.projectDir(project);
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
    report = JSON.parse(await storage.readFile(project, "drc.json"));
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

  await storage.deleteFile(project, "drc.json");
  return { ok: violations.filter((v) => v.severity === "error").length === 0, violations, unconnected, raw: out + err };
}
