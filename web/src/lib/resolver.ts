import type { LibSymbol } from "@loon/shared/schematic";
import type { PartSummary } from "@loon/shared/parts";
import type { LibResolver } from "@loon/shared/apply-ops";

// Client-side resolver so ops apply instantly in the browser, identical to the
// server. Footprint defaults come from the parts catalog.
export function makeClientResolver(defs: Record<string, LibSymbol>, parts: PartSummary[]): LibResolver {
  const partById = new Map(parts.map((p) => [p.libId, p]));
  return (libId) => {
    const def = defs[libId];
    if (!def) return undefined;
    return { def, footprint: partById.get(libId)?.footprints[0] };
  };
}
