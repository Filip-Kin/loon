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
import { serializeBoard, serializeProject } from "@loon/shared/kicad-pcb";
import { runKicadDrc } from "../services/kicad";
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


// #region assistant actions
// What the buttons used to do, callable from the conversation.
async function projectState(project: string, schem: Schematic): Promise<string> {
  const lines: string[] = [];
  try {
    const files = await storage.listFiles(project, "firmware");
    lines.push(files.length ? `firmware files: ${files.map((f) => f.path).join(", ")}` : "firmware: none yet");
    for (const f of files.filter((x) => /\.(cpp|h|ini)$/.test(x.path)).slice(0, 6)) {
      const text = await storage.readFile(project, `firmware/${f.path}`);
      lines.push(`--- firmware/${f.path} ---\n${text.slice(0, 4000)}`);
    }
  } catch {
    lines.push("firmware: none yet");
  }
  try {
    await storage.readFile(project, "board.loon.json");
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

async function runAiAction(a: any, project: string, schem: Schematic, job: AiJob): Promise<string> {
  const defs = (libId: string) => library.get(libId)?.def ?? schem.libSymbols[libId];
  switch (a.action) {
    case "sync_pins": {
      const targets = firmwareTargets(schem, defs);
      if (targets.length === 0) return "no MCU on the sheet, nothing to map";
      const t = targets[0];
      await storage.writeFile(project, "firmware/include/board_pins.h", generatePinsHeader(t));
      const scaffold = async (path: string, text: string) => {
        try {
          await storage.readFile(project, path);
        } catch {
          await storage.writeFile(project, path, text);
        }
      };
      await scaffold("firmware/platformio.ini", generatePlatformIni(t));
      await scaffold("firmware/src/main.cpp", generateMainStub(t));
      job.touched!.firmware = true;
      return `${t.pins.length} pins mapped from ${t.ref}`;
    }
    case "generate_board": {
      const footprints = await footprintsFor(schem);
      let existing: Board | undefined;
      if (a.keepPlacement !== false) {
        try {
          existing = JSON.parse(await storage.readFile(project, "board.loon.json")) as Board;
        } catch {
          /* first board */
        }
      }
      const res = generateBoard(schem, defs, { rules: OSHPARK_2LAYER, footprints, existing });
      await storage.writeFile(project, "board.loon.json", JSON.stringify(res.board, null, 2));
      await storage.writeFile(project, "board.kicad_pcb", serializeBoard(res.board, rawOf(footprints)));
      await storage.writeFile(project, "board.kicad_pro", serializeProject(res.board, "board"));
      job.touched!.board = true;
      const rats = ratsnest(res.board, footprints);
      const notes = [`placed ${res.placed} parts`, ...res.notes, `${rats.length} connections to route`];
      if (res.missingFootprints.length) notes.push(`${res.missingFootprints.length} parts have no footprint set`);
      if (res.approximate.length) notes.push(`${res.approximate.length} generated land patterns to check`);
      return notes.join(", ");
    }
    case "run_drc": {
      const res = await runKicadDrc(project);
      job.touched!.board = true;
      if (res.error) return res.error;
      const errors = res.violations.filter((v) => v.severity === "error");
      job.log = (job.log ?? "") + res.violations.map((v) => `[${v.severity}] ${v.rule}: ${v.message}`).join("\n");
      return `${errors.length} errors, ${res.violations.length - errors.length} warnings, ${res.unconnected} unrouted`;
    }
    case "build_firmware": {
      const build = startBuild(project);
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
      const sim = startQemu(project, a.seconds ?? 15);
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
      const sim = startSpice(project, deck.text);
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

  load: publicProcedure.input(z.object({ name: z.string() })).query(async ({ input }) => {
    const text = await storage.read(input.name);
    const { schem, libRaw } = parseSchematic(text);
    projectRaw.set(input.name, libRaw);
    return { schem };
  }),

  save: publicProcedure
    .input(z.object({ name: z.string(), schem: z.any() }))
    .mutation(async ({ input }) => {
      const schem = input.schem as Schematic;
      const usedLibIds = Array.from(new Set(schem.symbols.map((s) => s.libId)));
      const cached = projectRaw.get(input.name) ?? {};
      const libRaw: Record<string, SxList> = { ...cached, ...library.rawMap(usedLibIds) };
      const text = serializeSchematic(schem, libRaw);
      await storage.write(input.name, text);
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
    .input(z.object({ message: z.string(), schem: z.any(), project: z.string().optional() }))
    .mutation(({ input }) => {
      reapJobs();
      const id = crypto.randomUUID();
      const schem = input.schem as Schematic;
      const project = input.project ?? "untitled";
      const job: AiJob = { id, started: Date.now(), state: "running", steps: [], files: [], log: "", touched: {} };
      aiJobs.set(id, job);
      (async () => {
        const step = (label: string, ok: boolean, detail?: string) => {
          job.steps!.push({ label, ok, detail });
        };
        try {
          job.message = "Thinking about the whole board...";
          const state = await projectState(project, schem);
          const ai = await generateOps(input.message, schem, state);
          const { results } = applyOps(schem, ai.ops, makeResolver(schem));
          job.ops = ai.ops;
          job.schem = schem;
          job.results = results;
          job.message = ai.message;

          // Firmware files first: a later build should compile what was written.
          for (const f of ai.files) {
            if (f.path.includes("board_pins.h")) continue; // generated, never authored
            await storage.writeFile(project, `firmware/${f.path}`, f.content);
            job.files!.push(f.path);
            job.touched!.firmware = true;
          }
          if (ai.files.length) step(`wrote ${job.files!.join(", ")}`, true);

          // Then the actions, in the order the assistant asked for them.
          for (const a of ai.actions) {
            job.message = `Running ${a.action.replace(/_/g, " ")}...`;
            try {
              const detail = await runAiAction(a, project, schem, job);
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
    .input(z.object({ project: z.string() }))
    .query(({ input }) => storage.listFiles(input.project, "firmware")),

  read: publicProcedure
    .input(z.object({ project: z.string(), path: z.string() }))
    .query(async ({ input }) => ({ text: await storage.readFile(input.project, `firmware/${input.path}`) })),

  write: publicProcedure
    .input(z.object({ project: z.string(), path: z.string(), text: z.string() }))
    .mutation(async ({ input }) => {
      await storage.writeFile(input.project, `firmware/${input.path}`, input.text);
      return { ok: true };
    }),

  // Regenerate the pin header from the current sheet, and scaffold the project
  // the first time. Only board_pins.h is ever overwritten.
  sync: publicProcedure
    .input(z.object({ project: z.string(), schem: z.any() }))
    .mutation(async ({ input }) => {
      const schem = input.schem as Schematic;
      const defs = (libId: string) => library.get(libId)?.def ?? schem.libSymbols[libId];
      const targets = firmwareTargets(schem, defs);
      if (targets.length === 0) return { ok: false, message: "No MCU on the sheet to generate a pin map from." };
      const target = targets[0];
      await storage.writeFile(input.project, "firmware/include/board_pins.h", generatePinsHeader(target));
      const scaffold = async (path: string, text: string) => {
        try {
          await storage.readFile(input.project, path);
        } catch {
          await storage.writeFile(input.project, path, text);
        }
      };
      await scaffold("firmware/platformio.ini", generatePlatformIni(target));
      await scaffold("firmware/src/main.cpp", generateMainStub(target));
      return {
        ok: true,
        message: `${target.pins.length} pins mapped from ${target.ref} (${target.profile.name}).`,
        pins: target.pins,
      };
    }),

  build: publicProcedure
    .input(z.object({ project: z.string() }))
    .mutation(({ input }) => ({ id: startBuild(input.project).id })),

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
    .input(z.object({ project: z.string(), message: z.string(), schem: z.any() }))
    .mutation(({ input }) => {
      reapJobs();
      const id = crypto.randomUUID();
      const job: AiJob = { id, started: Date.now(), state: "running" };
      aiJobs.set(id, job);
      (async () => {
        try {
          const files = await storage.listFiles(input.project, "firmware");
          const existing = await Promise.all(
            files
              .filter((f) => /\.(c|cpp|h|hpp|ini|py|txt|json|md)$/.test(f.path))
              .slice(0, 20)
              .map(async (f) => ({ path: f.path, content: await storage.readFile(input.project, `firmware/${f.path}`) })),
          );
          const res = await generateFirmware(input.message, input.schem as Schematic, existing);
          const written: string[] = [];
          for (const f of res.files) {
            if (f.path.includes("board_pins.h")) continue; // generated, never authored
            await storage.writeFile(input.project, `firmware/${f.path}`, f.content);
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
    .input(z.object({ project: z.string() }))
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
    .input(z.object({ project: z.string(), schem: z.any(), layers: z.number().optional(), keepPlacement: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      const schem = input.schem as Schematic;
      const defs = (libId: string) => library.get(libId)?.def ?? schem.libSymbols[libId];
      const specs = new Map<string, number>();
      for (const s of schem.symbols) {
        const fp = s.properties.Footprint;
        if (!fp) continue;
        specs.set(fp, defs(s.libId)?.pins.length ?? 2);
      }
      const footprints = await getFootprints([...specs].map(([libId, padCount]) => ({ libId, padCount })));
      let existing: Board | undefined;
      if (input.keepPlacement) {
        try {
          existing = JSON.parse(await storage.readFile(input.project, "board.loon.json")) as Board;
        } catch {
          /* first board */
        }
      }
      const res = generateBoard(schem, defs, {
        rules: input.layers === 4 ? OSHPARK_4LAYER : OSHPARK_2LAYER,
        footprints,
        existing,
      });
      await storage.writeFile(input.project, "board.loon.json", JSON.stringify(res.board, null, 2));
      await storage.writeFile(input.project, "board.kicad_pcb", serializeBoard(res.board, rawOf(footprints)));
      await storage.writeFile(input.project, "board.kicad_pro", serializeProject(res.board, "board"));
      return { board: res.board, placed: res.placed, missingFootprints: res.missingFootprints, approximate: res.approximate, notes: res.notes };
    }),

  load: publicProcedure
    .input(z.object({ project: z.string() }))
    .query(async ({ input }) => {
      try {
        return { board: JSON.parse(await storage.readFile(input.project, "board.loon.json")) as Board };
      } catch {
        return { board: null };
      }
    }),

  save: publicProcedure
    .input(z.object({ project: z.string(), board: z.any(), schem: z.any() }))
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
      await storage.writeFile(input.project, "board.loon.json", JSON.stringify(board, null, 2));
      await storage.writeFile(input.project, "board.kicad_pcb", serializeBoard(board, rawOf(footprints)));
      await storage.writeFile(input.project, "board.kicad_pro", serializeProject(board, "board"));
      const rats = ratsnest(board, footprints);
      const drc = runDrc(board, footprints, rats.length);
      return { ok: true, drc, unrouted: rats.length };
    }),

  // KiCad's own DRC on the saved board: slower, and the one that counts.
  kicadDrc: publicProcedure
    .input(z.object({ project: z.string() }))
    .mutation(({ input }) => runKicadDrc(input.project)),

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
    .input(z.object({ project: z.string(), schem: z.any(), bench: z.any() }))
    .mutation(({ input }) => {
      const schem = input.schem as Schematic;
      const defs = (libId: string) => library.get(libId)?.def ?? schem.libSymbols[libId];
      const deck = buildSpiceDeck(schem, input.bench as SpiceBench, defs);
      const job = startSpice(input.project, deck.text);
      return { id: job.id, unmodelled: deck.unmodelled, deck: deck.text };
    }),

  qemu: publicProcedure
    .input(z.object({ project: z.string(), seconds: z.number().optional() }))
    .mutation(({ input }) => ({ id: startQemu(input.project, input.seconds ?? 12).id })),

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
