import { z } from "zod";
import { router, publicProcedure } from "../trpc";
import { library } from "../services/library";
import { storage } from "../services/storage";
import { generateOps, generateFirmware } from "../services/ai";
import { probeHub } from "../services/probe-hub";
import { parseSchematic, serializeSchematic } from "@loon/shared/kicad-sch";
import { buildNetlist } from "@loon/shared/netlist";
import { runErc } from "@loon/shared/erc";
import { firmwareTargets, generatePinsHeader, generatePlatformIni, generateMainStub } from "@loon/shared/firmware";
import { startBuild, getBuild, listBuilds } from "../services/build";
import { getFootprints } from "../services/footprints";
import { generateBoard, ratsnest, runDrc } from "@loon/shared/pcbgen";
import { padWorld } from "@loon/shared/pcbgen";
import { autoroute } from "@loon/shared/autoroute";
import { planPours, stitchVias } from "@loon/shared/pour";
import { serializeBoard, serializeProject } from "@loon/shared/kicad-pcb";
import { fillZones, runKicadDrc } from "../services/kicad";
import { startSpice, startQemu, getSim } from "../services/sim";
import { buildSpiceDeck, parseWrdata, type SpiceBench } from "@loon/shared/spice";
import { OSHPARK_2LAYER, OSHPARK_4LAYER, type Board } from "@loon/shared/board";
import { emptySchematic, type Schematic, type LibSymbol } from "@loon/shared/schematic";
import { applyOps, type LibResolver } from "@loon/shared/apply-ops";
import type { SxList } from "@loon/shared/sexpr";
import { ALL_SOURCES } from "@loon/shared/parts";

// Per-project cache of raw lib_symbol S-expr captured at load, so files that
// use parts outside Loon's builtin library still round-trip on save.
const projectRaw = new Map<string, Record<string, SxList>>();

// Resolver over the builtin library, optionally falling back to a schematic's
// embedded defs (for loaded external parts). Footprint comes from the instance.
function makeResolver(schem?: Schematic): LibResolver {
  return (libId) => {
    const e = library.get(libId);
    if (e) return { def: e.def, footprint: e.part.footprints[0] };
    const def: LibSymbol | undefined = schem?.libSymbols[libId];
    if (def) return { def };
    return undefined;
  };
}

// Verbatim library S-expressions, keyed by footprint id, for the board writer.
function rawOf(footprints: Record<string, { raw?: unknown }>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [id, fp] of Object.entries(footprints)) if (fp.raw) out[id] = fp.raw;
  return out;
}


// A board with two microcontrollers needs two pin maps. With one, keep the
// name the firmware already includes.
function headerPath(t: { ref: string }, all: { ref: string }[]): string {
  return all.length > 1 ? `firmware/include/board_pins_${t.ref}.h` : "firmware/include/board_pins.h";
}

// #region assistant actions
// What the buttons used to do, callable from the conversation.
async function projectState(project: string, schem: Schematic, unit = ""): Promise<string> {
  const lines: string[] = [];
  // Other boards in the same product, so the assistant can keep a link
  // protocol consistent across both ends of it.
  try {
    const boards = await storage.boards(project);
    lines.push(`boards in this project: ${boards.map((b) => b || "main").join(", ")}. You are editing ${unit || "main"}.`);
    for (const b of boards) {
      if (b === unit) continue;
      try {
        const other = parseSchematic(await storage.read(project, b));
        const defs = (libId: string) => library.get(libId)?.def ?? other.schem.libSymbols[libId];
        const nl = buildNetlist(other.schem, defs);
        const mcus = other.schem.symbols.filter((x) => x.libId.includes("ESP32")).map((x) => x.properties.Reference);
        lines.push(
          `board "${b || "main"}": ${other.schem.symbols.length} parts, MCU ${mcus.join(",") || "none"}, nets ${nl.nets
            .map((n) => n.name)
            .filter((n) => !n.startsWith("N$"))
            .slice(0, 30)
            .join(", ")}`,
        );
        const fw = await storage.listFiles(project, "firmware", b);
        if (fw.length) lines.push(`board "${b || "main"}" firmware: ${fw.map((f) => f.path).join(", ")}`);
      } catch {
        /* a board that will not parse is not context */
      }
    }
  } catch {
    /* single board */
  }
  try {
    const files = await storage.listFiles(project, "firmware", unit);
    lines.push(files.length ? `firmware files: ${files.map((f) => f.path).join(", ")}` : "firmware: none yet");
    for (const f of files.filter((x) => /\.(cpp|h|ini)$/.test(x.path)).slice(0, 6)) {
      const text = await storage.readFile(project, `firmware/${f.path}`, unit);
      lines.push(`--- firmware/${f.path} ---\n${text.slice(0, 4000)}`);
    }
  } catch {
    lines.push("firmware: none yet");
  }
  try {
    await storage.readFile(project, "board.loon.json", unit);
    lines.push("board: placed (board.kicad_pcb exists)");
  } catch {
    lines.push("board: not generated yet");
  }
  void schem;
  return lines.join("\n");
}

async function footprintsFor(schem: Schematic): Promise<Record<string, any>> {
  const specs = new Map<string, number>();
  for (const s of schem.symbols) {
    const fp = s.properties.Footprint;
    if (!fp) continue;
    const def = library.get(s.libId)?.def ?? schem.libSymbols[s.libId];
    specs.set(fp, def?.pins.length ?? 2);
  }
  return getFootprints([...specs].map(([libId, padCount]) => ({ libId, padCount })));
}

async function runAiAction(a: any, project: string, schem: Schematic, job: AiJob, unit = ""): Promise<string> {
  const defs = (libId: string) => library.get(libId)?.def ?? schem.libSymbols[libId];
  switch (a.action) {
    case "sync_pins": {
      const targets = firmwareTargets(schem, defs);
      if (targets.length === 0) return "no MCU on the sheet, nothing to map";
      for (const t of targets) await storage.writeFile(project, headerPath(t, targets), generatePinsHeader(t), unit);
      const t = targets[0];
      const scaffold = async (path: string, text: string) => {
        try {
          await storage.readFile(project, path, unit);
        } catch {
          await storage.writeFile(project, path, text, unit);
        }
      };
      await scaffold("firmware/platformio.ini", generatePlatformIni(t));
      await scaffold("firmware/src/main.cpp", generateMainStub(t));
      job.touched!.firmware = true;
      return targets.map((x) => `${x.pins.length} pins from ${x.ref}`).join(", ");
    }
    case "generate_board": {
      const footprints = await footprintsFor(schem);
      let existing: Board | undefined;
      if (a.keepPlacement !== false) {
        try {
          existing = JSON.parse(await storage.readFile(project, "board.loon.json", unit)) as Board;
        } catch {
          /* first board */
        }
      }
      const res = generateBoard(schem, defs, { rules: OSHPARK_2LAYER, footprints, existing });
      // Route the signals. Power nets are left for copper, deliberately.
      let routeNote = "";
      if (a.route !== false) {
        const nlb = buildNetlist(schem, defs);
        const r = autoroute(res.board, footprints, nlb);
        res.board.tracks.push(...r.tracks);
        res.board.vias.push(...r.vias);
        routeNote = `routed ${r.routed} connections, ${r.failed} unroutable, ${new Set(r.skipped).size} power nets left for copper`;
      }
      await storage.writeFile(project, "board.loon.json", JSON.stringify(res.board, null, 2), unit);
      await storage.writeFile(project, "board.kicad_pcb", serializeBoard(res.board, rawOf(footprints)), unit);
      await storage.writeFile(project, "board.kicad_pro", serializeProject(res.board, "board"), unit);
      job.touched!.board = true;
      const rats = ratsnest(res.board, footprints);
      const notes = [`placed ${res.placed} parts`, ...res.notes, ...(routeNote ? [routeNote] : []), `${rats.length} connections in the netlist`];
      if (res.missingFootprints.length) notes.push(`${res.missingFootprints.length} parts have no footprint set`);
      if (res.approximate.length) notes.push(`${res.approximate.length} generated land patterns to check`);
      return notes.join(", ");
    }
    case "run_drc": {
      const res = await runKicadDrc(project, unit);
      job.touched!.board = true;
      if (res.error) return res.error;
      const errors = res.violations.filter((v) => v.severity === "error");
      job.log = (job.log ?? "") + res.violations.map((v) => `[${v.severity}] ${v.rule}: ${v.message}`).join("\n");
      return `${errors.length} errors, ${res.violations.length - errors.length} warnings, ${res.unconnected} unrouted`;
    }
    case "build_firmware": {
      const build = startBuild(project, unit);
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const j = getBuild(build.id);
        if (!j || j.state !== "running") {
          job.log = (job.log ?? "") + (j?.log ?? "").slice(-4000);
          job.touched!.firmware = true;
          if (!j || j.state === "error") throw new Error(j?.error ?? "build failed");
          return `built ${j.artifacts?.length ?? 0} images`;
        }
      }
    }
    case "run_qemu": {
      const sim = startQemu(project, a.seconds ?? 15, unit);
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const j = getSim(sim.id);
        if (!j || j.state !== "running") {
          job.log = (job.log ?? "") + (j?.log ?? "").slice(-6000);
          job.touched!.sim = true;
          if (!j || j.state === "error") throw new Error(j?.error ?? "emulation failed");
          const kicks = (j.log.match(/KICK/g) ?? []).length;
          const panic = /assert failed|Guru Meditation/i.test(j.log);
          return `${kicks} heartbeat lines${panic ? ", firmware panicked" : ""}`;
        }
      }
    }
    case "run_spice": {
      const probes: string[] = a.probes ?? [];
      const bench = {
        name: "assistant bench",
        analysis: "tran" as const,
        tranStop: a.stop ?? 0.1,
        tranStep: (a.stop ?? 0.1) / 1000,
        sources: [
          { net: "+3V3", kind: "pulse" as const, pulse: { v1: 0, v2: 3.3, delay: 0, rise: 1e-4, fall: 1e-4, width: 10, period: 20 } },
          { net: "+5V", kind: "dc" as const, dc: 5 },
          { net: "+24V", kind: "dc" as const, dc: 24 },
        ],
        probes,
      };
      const deck = buildSpiceDeck(schem, bench, defs);
      const sim = startSpice(project, deck.text, unit);
      for (;;) {
        await new Promise((r) => setTimeout(r, 1200));
        const j = getSim(sim.id);
        if (!j || j.state !== "running") {
          job.touched!.sim = true;
          if (!j || j.state === "error") throw new Error(j?.error ?? "ngspice failed");
          const series = j.data ? parseWrdata(j.data, probes) : [];
          return series.map((x) => `${x.name} ends at ${(x.points[x.points.length - 1]?.v ?? 0).toFixed(2)}V`).join(", ") || "ran";
        }
      }
    }
    case "create_board": {
      const name = String(a.name ?? "board2").replace(/[^A-Za-z0-9._-]/g, "_");
      const fresh = emptySchematic(crypto.randomUUID());
      fresh.title = `${project} - ${name}`;
      await storage.createBoard(project, name, serializeSchematic(fresh, {}));
      return `added board "${name}" to this project - switch to it in the board selector to work on it`;
    }
    default:
      throw new Error(`unknown action ${a.action}`);
  }
}

const sourceEnum = z.enum(ALL_SOURCES as [string, ...string[]]);

const librouter = router({
  search: publicProcedure
    .input(z.object({ text: z.string().optional(), requireSources: z.array(sourceEnum).optional(), limit: z.number().optional() }))
    .query(({ input }) => library.search(input as any)),
  all: publicProcedure.query(() => ({
    parts: library.search({}),
    defs: library.allDefs(),
  })),
  symbols: publicProcedure
    .input(z.object({ libIds: z.array(z.string()) }))
    .query(({ input }) => library.defMap(input.libIds)),
});

const projectRouter = router({
  list: publicProcedure.query(() => storage.list()),

  create: publicProcedure.input(z.object({ name: z.string() })).mutation(async ({ input }) => {
    const schem = emptySchematic(crypto.randomUUID());
    schem.title = input.name;
    const text = serializeSchematic(schem, {});
    await storage.write(input.name, text);
    return { schem };
  }),

  // Boards inside a project: "" is the main board at the project root.
  boards: publicProcedure.input(z.object({ name: z.string() })).query(({ input }) => storage.boards(input.name)),

  createBoard: publicProcedure
    .input(z.object({ name: z.string(), board: z.string() }))
    .mutation(async ({ input }) => {
      const schem = emptySchematic(crypto.randomUUID());
      schem.title = `${input.name} - ${input.board}`;
      await storage.createBoard(input.name, input.board, serializeSchematic(schem, {}));
      return { schem, boards: await storage.boards(input.name) };
    }),

  load: publicProcedure.input(z.object({ name: z.string(), board: z.string().optional() })).query(async ({ input }) => {
    const text = await storage.read(input.name, input.board ?? "");
    const { schem, libRaw } = parseSchematic(text);
    projectRaw.set(`${input.name}/${input.board ?? ""}`, libRaw);
    return { schem };
  }),

  save: publicProcedure
    .input(z.object({ name: z.string(), schem: z.any(), board: z.string().optional() }))
    .mutation(async ({ input }) => {
      const schem = input.schem as Schematic;
      const unit = input.board ?? "";
      const usedLibIds = Array.from(new Set(schem.symbols.map((s) => s.libId)));
      const cached = projectRaw.get(`${input.name}/${unit}`) ?? {};
      const libRaw: Record<string, SxList> = { ...cached, ...library.rawMap(usedLibIds) };
      const text = serializeSchematic(schem, libRaw);
      await storage.write(input.name, text, unit);
      const list = await storage.list();
      const meta = list.find((m) => m.name === input.name);
      return { ok: true, meta };
    }),
});

// A whole-board prompt can run for many minutes. Holding an HTTP request open
// that long is at the mercy of every proxy in front of us, so the generation
// runs as a job and the browser polls it.
interface AiJob {
  id: string;
  started: number;
  state: "running" | "done" | "error";
  message?: string;
  ops?: unknown[];
  schem?: Schematic;
  results?: unknown[];
  error?: string;
  // What the assistant did beyond editing the sheet, so the UI can report it
  // and refresh the views it touched.
  steps?: { label: string; ok: boolean; detail?: string }[];
  files?: string[];
  log?: string;
  touched?: { board?: boolean; firmware?: boolean; sim?: boolean };
  // Which board the assistant actually edited, so the UI can follow it there.
  editedBoard?: string;
}
const aiJobs = new Map<string, AiJob>();

function reapJobs() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of aiJobs) if (job.started < cutoff) aiJobs.delete(id);
}

const aiRouter = router({
  generate: publicProcedure
    .input(z.object({ message: z.string(), schem: z.any() }))
    .mutation(async ({ input }) => {
      const schem = input.schem as Schematic;
      const ai = await generateOps(input.message, schem);
      const { results } = applyOps(schem, ai.ops, makeResolver(schem));
      return { message: ai.message, ops: ai.ops, schem, results, raw: ai.raw };
    }),

  // The one conversation. It edits the schematic, writes firmware, lays out the
  // board and runs the simulators, so the user never has to go find a button.
  start: publicProcedure
    .input(z.object({ message: z.string(), schem: z.any(), project: z.string().optional(), board: z.string().optional() }))
    .mutation(({ input }) => {
      reapJobs();
      const id = crypto.randomUUID();
      const schem = input.schem as Schematic;
      const project = input.project ?? "untitled";
      const unit = input.board ?? "";
      const job: AiJob = { id, started: Date.now(), state: "running", steps: [], files: [], log: "", touched: {} };
      aiJobs.set(id, job);
      (async () => {
        const step = (label: string, ok: boolean, detail?: string) => {
          job.steps!.push({ label, ok, detail });
        };
        try {
          job.message = "Thinking about the whole board...";
          const state = await projectState(project, schem, unit);
          const ai = await generateOps(input.message, schem, state);

          // A board named in the reply wins over the one on screen, and a board
          // created in this same reply has to exist before its ops land.
          const creates = ai.actions.filter((a) => a.action === "create_board");
          for (const c of creates) {
            const detail = await runAiAction(c, project, schem, job, unit);
            step("create board", true, detail);
          }
          const target = ai.board !== undefined ? ai.board : unit;
          let sheet = schem;
          if (target !== unit) {
            // Edit that board's own schematic, not the one the user has open.
            const other = parseSchematic(await storage.read(project, target));
            sheet = other.schem;
            projectRaw.set(`${project}/${target}`, other.libRaw);
          }
          const { results } = applyOps(sheet, ai.ops, makeResolver(sheet));
          job.ops = ai.ops;
          job.results = results;
          job.editedBoard = target;
          job.message = ai.message;
          if (target === unit) {
            job.schem = sheet;
          } else {
            // Persist it: the user is not looking at this sheet, so nothing
            // else is going to save it.
            const usedLibIds = Array.from(new Set(sheet.symbols.map((x) => x.libId)));
            const cached = projectRaw.get(`${project}/${target}`) ?? {};
            await storage.write(project, serializeSchematic(sheet, { ...cached, ...library.rawMap(usedLibIds) }), target);
            step(`edited board "${target || "main"}"`, true, `${sheet.symbols.length} parts on that sheet now`);
          }

          // Firmware files first: a later build should compile what was written.
          for (const f of ai.files) {
            if (f.path.includes("board_pins.h")) continue; // generated, never authored
            await storage.writeFile(project, `firmware/${f.path}`, f.content, target);
            job.files!.push(f.path);
            job.touched!.firmware = true;
          }
          if (ai.files.length) step(`wrote ${job.files!.join(", ")}`, true);

          // Then the actions, in the order the assistant asked for them.
          for (const a of ai.actions) {
            if (a.action === "create_board") continue; // already run, before the ops
            job.message = `Running ${a.action.replace(/_/g, " ")}...`;
            try {
              const detail = await runAiAction(a, project, sheet, job, target);
              step(a.action.replace(/_/g, " "), true, detail);
            } catch (e: any) {
              step(a.action.replace(/_/g, " "), false, String(e?.message ?? e));
            }
          }
          job.message = ai.message;
          job.state = "done";
        } catch (e: any) {
          job.error = String(e?.message ?? e);
          job.state = "error";
        }
      })();
      return { id };
    }),

  status: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input }) => {
      const job = aiJobs.get(input.id);
      if (!job) return { state: "error" as const, error: "That job is gone. The server probably restarted.", elapsedMs: 0 };
      return {
        state: job.state,
        elapsedMs: Date.now() - job.started,
        message: job.message,
        ops: job.ops,
        schem: job.schem,
        results: job.results,
        error: job.error,
        steps: job.steps,
        files: job.files,
        editedBoard: job.editedBoard,
        log: job.log?.slice(-6000),
        touched: job.touched,
      };
    }),
});

const probeRouter = router({
  list: publicProcedure.query(() => probeHub.list()),
  execute: publicProcedure
    .input(z.object({ probeId: z.string(), command: z.any() }))
    .mutation(({ input }) => probeHub.execute(input.probeId, input.command)),
  getAssignments: publicProcedure
    .input(z.object({ probeId: z.string() }))
    .query(({ input }) => probeHub.getAssignments(input.probeId)),
  setAssignments: publicProcedure
    .input(z.object({ probeId: z.string(), assignments: z.array(z.any()) }))
    .mutation(({ input }) => {
      probeHub.setAssignments(input.probeId, input.assignments as any);
      return { ok: true };
    }),
});

// Connectivity and rule checks over whatever the browser currently has.
const designRouter = router({
  // A mutation, not a query: the schematic travels in the body. As a query its
  // JSON went into the URL and a real board blew past the header size limit.
  check: publicProcedure
    .input(z.object({ schem: z.any() }))
    .mutation(({ input }) => {
      const schem = input.schem as Schematic;
      const defs = (libId: string) => library.get(libId)?.def ?? schem.libSymbols[libId];
      const nl = buildNetlist(schem, defs);
      const issues = runErc(schem, defs, nl);
      return {
        nets: nl.nets.map((n) => ({ name: n.name, isPower: n.isPower, pins: n.pins.map((p) => `${p.ref}.${p.pin}`) })),
        issues,
      };
    }),
});

// #region firmware
// The board's own pinout generates the header, so firmware never retypes it.
const firmwareRouter = router({
  files: publicProcedure
    .input(z.object({ project: z.string(), board: z.string().optional() }))
    .query(({ input }) => storage.listFiles(input.project, "firmware", input.board ?? "")),

  read: publicProcedure
    .input(z.object({ project: z.string(), path: z.string(), board: z.string().optional() }))
    .query(async ({ input }) => ({ text: await storage.readFile(input.project, `firmware/${input.path}`, input.board ?? "") })),

  write: publicProcedure
    .input(z.object({ project: z.string(), path: z.string(), text: z.string(), board: z.string().optional() }))
    .mutation(async ({ input }) => {
      await storage.writeFile(input.project, `firmware/${input.path}`, input.text, input.board ?? "");
      return { ok: true };
    }),

  // Regenerate the pin header from the current sheet, and scaffold the project
  // the first time. Only board_pins.h is ever overwritten.
  sync: publicProcedure
    .input(z.object({ project: z.string(), schem: z.any(), board: z.string().optional() }))
    .mutation(async ({ input }) => {
      const schem = input.schem as Schematic;
      const defs = (libId: string) => library.get(libId)?.def ?? schem.libSymbols[libId];
      const targets = firmwareTargets(schem, defs);
      if (targets.length === 0) return { ok: false, message: "No MCU on the sheet to generate a pin map from." };
      const target = targets[0];
      const unit = input.board ?? "";
      for (const t of targets) await storage.writeFile(input.project, headerPath(t, targets), generatePinsHeader(t), unit);
      const scaffold = async (path: string, text: string) => {
        try {
          await storage.readFile(input.project, path, unit);
        } catch {
          await storage.writeFile(input.project, path, text, unit);
        }
      };
      await scaffold("firmware/platformio.ini", generatePlatformIni(target));
      await scaffold("firmware/src/main.cpp", generateMainStub(target));
      return {
        ok: true,
        message: targets.map((t) => `${t.pins.length} pins from ${t.ref} (${t.profile.name})`).join("; "),
        pins: target.pins,
      };
    }),

  build: publicProcedure
    .input(z.object({ project: z.string(), board: z.string().optional() }))
    .mutation(({ input }) => ({ id: startBuild(input.project, input.board ?? "").id })),

  buildStatus: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input }) => {
      const job = getBuild(input.id);
      if (!job) return { state: "error" as const, log: "", error: "That build is gone (the server restarted)." };
      return { state: job.state, log: job.log.slice(-20000), error: job.error, artifacts: job.artifacts, elapsedMs: Date.now() - job.started };
    }),

  // The assistant writes firmware as a job too: it takes as long as a design
  // edit, and writes whole files rather than ops.
  aiStart: publicProcedure
    .input(z.object({ project: z.string(), message: z.string(), schem: z.any(), board: z.string().optional() }))
    .mutation(({ input }) => {
      reapJobs();
      const id = crypto.randomUUID();
      const job: AiJob = { id, started: Date.now(), state: "running" };
      aiJobs.set(id, job);
      (async () => {
        try {
          const unit = input.board ?? "";
          const files = await storage.listFiles(input.project, "firmware", unit);
          const existing = await Promise.all(
            files
              .filter((f) => /\.(c|cpp|h|hpp|ini|py|txt|json|md)$/.test(f.path))
              .slice(0, 20)
              .map(async (f) => ({ path: f.path, content: await storage.readFile(input.project, `firmware/${f.path}`, unit) })),
          );
          const res = await generateFirmware(input.message, input.schem as Schematic, existing);
          const written: string[] = [];
          for (const f of res.files) {
            if (f.path.includes("board_pins.h")) continue; // generated, never authored
            await storage.writeFile(input.project, `firmware/${f.path}`, f.content, unit);
            written.push(f.path);
          }
          job.message = `${res.message}${written.length ? ` (wrote ${written.join(", ")})` : ""}`;
          job.ops = written as unknown[];
          job.state = "done";
        } catch (e: any) {
          job.error = String(e?.message ?? e);
          job.state = "error";
        }
      })();
      return { id };
    }),

  builds: publicProcedure
    .input(z.object({ project: z.string(), board: z.string().optional() }))
    .query(({ input }) => listBuilds(input.project).map((b) => ({ id: b.id, state: b.state, started: b.started }))),
});

// #region pcb
// The .kicad_pcb is the deliverable: OSH Park accepts it directly, so there is
// no Gerber step between the layout and the order.
const pcbRouter = router({
  // Footprints for everything on the sheet, fetched from KiCad's library and
  // cached. Returned to the browser so the canvas can draw real land patterns.
  footprints: publicProcedure
    .input(z.object({ schem: z.any() }))
    .mutation(async ({ input }) => {
      const schem = input.schem as Schematic;
      const specs = new Map<string, number>();
      for (const s of schem.symbols) {
        const fp = s.properties.Footprint;
        if (!fp) continue;
        const def = library.get(s.libId)?.def ?? schem.libSymbols[s.libId];
        specs.set(fp, def?.pins.length ?? 2);
      }
      return getFootprints([...specs].map(([libId, padCount]) => ({ libId, padCount })));
    }),

  generate: publicProcedure
    .input(z.object({ project: z.string(), schem: z.any(), layers: z.number().optional(), keepPlacement: z.boolean().optional(), board: z.string().optional(), route: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      const schem = input.schem as Schematic;
      const defs = (libId: string) => library.get(libId)?.def ?? schem.libSymbols[libId];
      const specs = new Map<string, number>();
      for (const s of schem.symbols) {
        const fp = s.properties.Footprint;
        if (!fp) continue;
        specs.set(fp, defs(s.libId)?.pins.length ?? 2);
      }
      // Placement bolts the board down, so the hole pattern has to be on hand
      // whether or not the schematic mentions it.
      const footprints = await getFootprints([
        ...[...specs].map(([libId, padCount]) => ({ libId, padCount })),
        { libId: "MountingHole:MountingHole_3.2mm_M3", padCount: 0 },
      ]);
      const unit = input.board ?? "";
      let existing: Board | undefined;
      if (input.keepPlacement) {
        try {
          existing = JSON.parse(await storage.readFile(input.project, "board.loon.json", unit)) as Board;
        } catch {
          /* first board */
        }
      }
      const res = generateBoard(schem, defs, {
        rules: input.layers === 4 ? OSHPARK_4LAYER : OSHPARK_2LAYER,
        footprints,
        existing,
      });
      // Route the signals unless asked not to. A 30A channel is not a trace,
      // so power nets are left for copper and the note says how many.
      const notes = [...res.notes];
      if (input.route !== false) {
        const nlb = buildNetlist(schem, defs);
        const r = autoroute(res.board, footprints, nlb);
        res.board.tracks.push(...r.tracks);
        res.board.vias.push(...r.vias);
        notes.push(
          `routed ${r.routed} connections with ${r.tracks.length} tracks and ${r.vias.length} vias in ${r.seconds.toFixed(0)}s; ${r.failed} could not be routed and ${new Set(r.skipped).size} power nets were left for copper`,
        );

        // The copper the router deliberately skipped. Ground goes on the back
        // of the board and the battery rail on the front, which is what a two
        // layer power board looks like.
        // Every net the router left for copper gets a pour, bounded to the
        // area its own pads occupy, on the layer where most of them sit. The
        // smaller a pour's area, the higher its priority, so a channel output
        // wins its own corner from the rail it branches off.
        const padsOf = (net: string) => board2Pads.get(net) ?? [];
        const board2Pads = new Map<string, { x: number; y: number; smd: boolean }[]>();
        for (const f of res.board.footprints) {
          const fp = footprints[f.libId];
          for (const [padNum, net] of Object.entries(f.padNets)) {
            if (!net) continue;
            const pad = fp?.pads.find((x) => x.number === padNum);
            // The pad, not the footprint origin. On a 45mm terminal block the
            // origin is at one end, so a pour bounded by origins misses most of
            // the pads it is supposed to feed.
            const at = pad ? padWorld(f, pad.at) : f.at;
            const arr = board2Pads.get(net) ?? [];
            arr.push({ x: at.x, y: at.y, smd: (pad?.type ?? "smd") === "smd" });
            board2Pads.set(net, arr);
          }
        }
        const railNames = [...new Set(r.skipped)].filter((n) => n !== "GND" && padsOf(n).length > 1);
        const boundsOf = (net: string) => {
          const pts = padsOf(net);
          return {
            x1: Math.min(...pts.map((p) => p.x)) - 6,
            y1: Math.min(...pts.map((p) => p.y)) - 6,
            x2: Math.max(...pts.map((p) => p.x)) + 6,
            y2: Math.max(...pts.map((p) => p.y)) + 6,
          };
        };
        const areaOf = (net: string) => {
          const b = boundsOf(net);
          return (b.x2 - b.x1) * (b.y2 - b.y1);
        };
        // Ground on both layers: most pads are surface mount on the front, and a
        // pour they cannot reach connects nothing. The through-hole terminals
        // stitch the two together.
        const volts = (n: string) => {
          const m = /^\+(\d+)(?:V(\d+))?/.exec(n);
          return m ? parseFloat(`${m[1]}.${m[2] ?? 0}`) : 0;
        };
        const railName = [...railNames].sort((a, b) => volts(b) - volts(a))[0];
        const pourNets: { name: string; layer: string; priority?: number; bounds?: { x1: number; y1: number; x2: number; y2: number } }[] = [
          { name: "GND", layer: "B.Cu" },
          { name: "GND", layer: "F.Cu" },
        ];
        // One layer each: the front when the net has surface mount pads to
        // reach, the back otherwise. Two zones for one small net just makes two
        // islands, and KiCad throws away an island that touches nothing.
        // A net whose pads are spread across the board is not a pour, it is a
        // wide trace, and it is left in the ratsnest until the router grows one.
        const ranked = railNames.filter((n) => areaOf(n) < 6000).sort((a, b) => areaOf(b) - areaOf(a));
        // Rails go on the front. The back is the ground plane, and a rail pour
        // carved out of it strands every ground pin it surrounds - which on a
        // terminal block is every other pin.
        ranked.forEach((net, i) => {
          pourNets.push({ name: net, layer: "F.Cu", priority: i + 1, bounds: boundsOf(net) });
        });
        const spread = railNames.filter((n) => areaOf(n) >= 6000 && n !== railName);
        if (spread.length) notes.push(`${spread.length} rails are spread too far to pour (${spread.slice(0, 4).join(", ")}); they need wide traces`);

        // Stitch only where the ground pour will actually be: outside the areas
        // another pour owns and outside every part's keepout.
        const avoid = pourNets.filter((n) => n.bounds).map((n) => n.bounds!);
        for (const f of res.board.footprints) {
          const fp = footprints[f.libId];
          for (const ring of fp?.keepouts ?? []) {
            const rad = (-f.rotation * Math.PI) / 180;
            const pts = ring.map((pt) => ({
              x: f.at.x + pt.x * Math.cos(rad) - pt.y * Math.sin(rad),
              y: f.at.y + pt.x * Math.sin(rad) + pt.y * Math.cos(rad),
            }));
            avoid.push({
              x1: Math.min(...pts.map((p2) => p2.x)),
              y1: Math.min(...pts.map((p2) => p2.y)),
              x2: Math.max(...pts.map((p2) => p2.x)),
              y2: Math.max(...pts.map((p2) => p2.y)),
            });
          }
        }
        const stitch = stitchVias(res.board, footprints, { net: "GND", avoid });
        notes.push(stitch.note);
        const p = planPours(res.board, nlb, { nets: pourNets });
        res.board.zones.push(...p.zones);
        notes.push(...p.notes);
      }
      await storage.writeFile(input.project, "board.loon.json", JSON.stringify(res.board, null, 2), unit);
      await storage.writeFile(input.project, "board.kicad_pcb", serializeBoard(res.board, rawOf(footprints)), unit);
      await storage.writeFile(input.project, "board.kicad_pro", serializeProject(res.board, "board"), unit);

      // A zone outline is not copper until it is filled, and only KiCad's own
      // filler produces what the fab will get.
      if (res.board.zones.length) {
        const fill = await fillZones(input.project, unit);
        notes.push(fill.ok ? fill.note : `zone fill failed: ${fill.note}`);
      }
      return { board: res.board, placed: res.placed, missingFootprints: res.missingFootprints, approximate: res.approximate, notes };
    }),

  load: publicProcedure
    .input(z.object({ project: z.string(), board: z.string().optional() }))
    .query(async ({ input }) => {
      try {
        return { board: JSON.parse(await storage.readFile(input.project, "board.loon.json", input.board ?? "")) as Board };
      } catch {
        return { board: null };
      }
    }),

  save: publicProcedure
    .input(z.object({ project: z.string(), board: z.any(), schem: z.any(), unit: z.string().optional() }))
    .mutation(async ({ input }) => {
      const board = input.board as Board;
      const schem = input.schem as Schematic;
      const defs = (libId: string) => library.get(libId)?.def ?? schem.libSymbols[libId];
      const specs = new Map<string, number>();
      for (const f of board.footprints) specs.set(f.libId, 2);
      for (const s of schem.symbols) {
        const fp = s.properties.Footprint;
        if (fp) specs.set(fp, defs(s.libId)?.pins.length ?? 2);
      }
      const footprints = await getFootprints([...specs].map(([libId, padCount]) => ({ libId, padCount })));
      const unit = input.unit ?? "";
      await storage.writeFile(input.project, "board.loon.json", JSON.stringify(board, null, 2), unit);
      await storage.writeFile(input.project, "board.kicad_pcb", serializeBoard(board, rawOf(footprints)), unit);
      await storage.writeFile(input.project, "board.kicad_pro", serializeProject(board, "board"), unit);
      const rats = ratsnest(board, footprints);
      const drc = runDrc(board, footprints, rats.length);
      return { ok: true, drc, unrouted: rats.length };
    }),

  // KiCad's own DRC on the saved board: slower, and the one that counts.
  kicadDrc: publicProcedure
    .input(z.object({ project: z.string(), board: z.string().optional() }))
    .mutation(({ input }) => runKicadDrc(input.project, input.board ?? "")),

  check: publicProcedure
    .input(z.object({ board: z.any() }))
    .mutation(async ({ input }) => {
      const board = input.board as Board;
      const footprints = await getFootprints(board.footprints.map((f) => ({ libId: f.libId, padCount: 2 })));
      const rats = ratsnest(board, footprints);
      return { drc: runDrc(board, footprints, rats.length), unrouted: rats.length };
    }),
});

// #region simulation
// SPICE for what the volts do, QEMU for what the firmware does.
const simRouter = router({
  deck: publicProcedure
    .input(z.object({ schem: z.any(), bench: z.any() }))
    .mutation(({ input }) => {
      const schem = input.schem as Schematic;
      const defs = (libId: string) => library.get(libId)?.def ?? schem.libSymbols[libId];
      return buildSpiceDeck(schem, input.bench as SpiceBench, defs);
    }),

  spice: publicProcedure
    .input(z.object({ project: z.string(), schem: z.any(), bench: z.any(), board: z.string().optional() }))
    .mutation(({ input }) => {
      const schem = input.schem as Schematic;
      const defs = (libId: string) => library.get(libId)?.def ?? schem.libSymbols[libId];
      const deck = buildSpiceDeck(schem, input.bench as SpiceBench, defs);
      const job = startSpice(input.project, deck.text, input.board ?? "");
      return { id: job.id, unmodelled: deck.unmodelled, deck: deck.text };
    }),

  qemu: publicProcedure
    .input(z.object({ project: z.string(), seconds: z.number().optional(), board: z.string().optional() }))
    .mutation(({ input }) => ({ id: startQemu(input.project, input.seconds ?? 12, input.board ?? "").id })),

  status: publicProcedure
    .input(z.object({ id: z.string(), probes: z.array(z.string()).optional() }))
    .query(({ input }) => {
      const job = getSim(input.id);
      if (!job) return { state: "error" as const, log: "", error: "That run is gone (the server restarted)." };
      return {
        state: job.state,
        log: job.log.slice(-30000),
        error: job.error,
        elapsedMs: Date.now() - job.started,
        series: job.data ? parseWrdata(job.data, input.probes ?? []) : undefined,
      };
    }),
});

export const appRouter = router({
  design: designRouter,
  pcb: pcbRouter,
  sim: simRouter,
  firmware: firmwareRouter,
  library: librouter,
  project: projectRouter,
  ai: aiRouter,
  probe: probeRouter,
  health: publicProcedure.query(() => ({ ok: true, ts: Date.now() })),
});

export type AppRouter = typeof appRouter;
