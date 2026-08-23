import { z } from "zod";
import { router, publicProcedure } from "../trpc";
import { library } from "../services/library";
import { storage } from "../services/storage";
import { generateOps } from "../services/ai";
import { probeHub } from "../services/probe-hub";
import { parseSchematic, serializeSchematic } from "@loon/shared/kicad-sch";
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

const aiRouter = router({
  generate: publicProcedure
    .input(z.object({ message: z.string(), schem: z.any() }))
    .mutation(async ({ input }) => {
      const schem = input.schem as Schematic;
      const ai = await generateOps(input.message, schem);
      const { results } = applyOps(schem, ai.ops, makeResolver(schem));
      return { message: ai.message, ops: ai.ops, schem, results, raw: ai.raw };
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

export const appRouter = router({
  library: librouter,
  project: projectRouter,
  ai: aiRouter,
  probe: probeRouter,
  health: publicProcedure.query(() => ({ ok: true, ts: Date.now() })),
});

export type AppRouter = typeof appRouter;
