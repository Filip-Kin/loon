// #region Blocks (derived view)
// A "block" is a module instance seen as one unit. Rather than a second source
// of truth, blocks are DERIVED from the provenance stamped on symbols when a
// module was instantiated (LoonBlock / LoonModule / LoonBlockParams). This keeps
// the schematic pure KiCad while letting the UI group, label, and (later)
// collapse a module. It is the seam the block-builder view grows from.

import type { Schematic } from "./schematic";

export interface Block {
  id: string; // LoonBlock uuid
  moduleId: string;
  params: Record<string, string | number>;
  memberUuids: string[];
}

export function deriveBlocks(schem: Schematic): Block[] {
  const byId = new Map<string, Block>();
  for (const s of schem.symbols) {
    const id = s.properties.LoonBlock;
    if (!id) continue;
    let b = byId.get(id);
    if (!b) {
      let params: Record<string, string | number> = {};
      const raw = s.properties.LoonBlockParams;
      if (raw) {
        try {
          params = JSON.parse(raw);
        } catch {
          /* ignore malformed */
        }
      }
      b = { id, moduleId: s.properties.LoonModule ?? "module", params, memberUuids: [] };
      byId.set(id, b);
    }
    b.memberUuids.push(s.uuid);
    // A member may carry the params even if it is not the first one placed.
    if (Object.keys(b.params).length === 0 && s.properties.LoonBlockParams) {
      try {
        b.params = JSON.parse(s.properties.LoonBlockParams);
      } catch {
        /* ignore */
      }
    }
  }
  return [...byId.values()];
}
