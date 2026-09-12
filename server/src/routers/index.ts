import { z } from "zod";
import { router, publicProcedure } from "../trpc";
import { library } from "../services/library";
import { storage } from "../services/storage";
import { generateOps } from "../services/ai";
import { probeHub } from "../services/probe-hub";
import { parseSchematic, serializeSchematic } from "@loon/shared/kicad-sch";
import { buildNetlist } from "@loon/shared/netlist";
import { runErc } from "@loon/shared/erc";
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

  start: publicProcedure
    .input(z.object({ message: z.string(), schem: z.any() }))
    .mutation(({ input }) => {
      reapJobs();
      const id = crypto.randomUUID();
      const schem = input.schem as Schematic;
      const job: AiJob = { id, started: Date.now(), state: "running" };
      aiJobs.set(id, job);
      (async () => {
        try {
          const ai = await generateOps(input.message, schem);
          const { results } = applyOps(schem, ai.ops, makeResolver(schem));
          job.message = ai.message;
          job.ops = ai.ops;
          job.schem = schem;
          job.results = results;
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
  check: publicProcedure
    .input(z.object({ schem: z.any() }))
    .query(({ input }) => {
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

export const appRouter = router({
  design: designRouter,
  library: librouter,
  project: projectRouter,
  ai: aiRouter,
  probe: probeRouter,
  health: publicProcedure.query(() => ({ ok: true, ts: Date.now() })),
});

export type AppRouter = typeof appRouter;
