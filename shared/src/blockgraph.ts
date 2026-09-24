// #region Block graph (module instances)
// Note: this is the module-level view - one node per module instantiation, at
// the position of its parts. The Blocks view in the editor draws segments.ts
// instead, which groups the whole sheet by function and lays it out by signal
// flow. This one stays because the block-level ops (move_block, delete_block,
// set_block_params) address module instances, and blocktest.ts checks them.

// The block view is not a second document. It is the schematic, grouped: a
// block is the set of symbols one module instantiation owns, its ports are the
// nets that leave that set, and a link is a net shared by two blocks. Position
// comes from where the members actually sit on the sheet.
//
// Keeping it derived means the two views can never disagree, and a block edit is
// just an edit to the schematic underneath.

import type { Schematic, Point } from "./schematic";
import { instanceBBox } from "./geometry";
import { deriveBlocks, type Block } from "./blocks";
import { buildNetlist, type Netlist, type DefResolver } from "./netlist";

export type PortDir = "in" | "out" | "power" | "bidir";

export interface BlockPort {
  net: string;
  dir: PortDir;
  isPower: boolean;
  // How many pins of this block sit on the net.
  pins: number;
}

export interface GraphBlock {
  id: string;
  moduleId: string;
  params: Record<string, string | number>;
  refs: string[];
  memberUuids: string[];
  // Bounding box of the members on the schematic sheet, in mm.
  box: { min: Point; max: Point };
  ports: BlockPort[];
  partCount: number;
}

export interface GraphLink {
  net: string;
  isPower: boolean;
  from: string; // block id
  to: string;
}

export interface BlockGraph {
  blocks: GraphBlock[];
  links: GraphLink[];
  // Parts that belong to no block, so the view can show they exist.
  looseRefs: string[];
}

function dirOf(types: string[]): PortDir {
  if (types.some((t) => t === "power_in" || t === "power_out")) return "power";
  const hasOut = types.some((t) => t === "output");
  const hasIn = types.some((t) => t === "input");
  if (hasOut && !hasIn) return "out";
  if (hasIn && !hasOut) return "in";
  return "bidir";
}

export function buildBlockGraph(schem: Schematic, resolve?: DefResolver, netlist?: Netlist): BlockGraph {
  const nl = netlist ?? buildNetlist(schem, resolve);
  const blocks: Block[] = deriveBlocks(schem);
  const byUuid = new Map(schem.symbols.map((s) => [s.uuid, s]));

  const blockOfRef = new Map<string, string>();
  const graphBlocks: GraphBlock[] = [];
  // Parts placed outside any module become one-part nodes, so the graph shows
  // the whole board rather than only the parts that came from a module.
  const looseGroups: Block[] = schem.symbols
    .filter((s) => !s.properties.LoonBlock && !s.libId.startsWith("power:"))
    .map((s) => ({
      id: `loose:${s.uuid}`,
      moduleId: s.properties.Value || s.libId.split(":")[1] || "part",
      params: {},
      memberUuids: [s.uuid],
    }));
  blocks.push(...looseGroups);
  for (const b of blocks) {
    const members = b.memberUuids.map((u) => byUuid.get(u)).filter(Boolean) as typeof schem.symbols;
    if (members.length === 0) continue;
    let min = { x: Infinity, y: Infinity };
    let max = { x: -Infinity, y: -Infinity };
    const refs: string[] = [];
    for (const m of members) {
      const ref = m.properties.Reference ?? "?";
      refs.push(ref);
      blockOfRef.set(ref, b.id);
      const def = resolve?.(m.libId) ?? schem.libSymbols[m.libId];
      const bb = def
        ? instanceBBox(def, { at: m.at, rotation: m.rotation, mirror: m.mirror })
        : { min: m.at, max: m.at };
      min = { x: Math.min(min.x, bb.min.x), y: Math.min(min.y, bb.min.y) };
      max = { x: Math.max(max.x, bb.max.x), y: Math.max(max.y, bb.max.y) };
    }
    graphBlocks.push({
      id: b.id,
      moduleId: b.moduleId,
      params: b.params,
      refs,
      memberUuids: b.memberUuids,
      box: { min, max },
      ports: [],
      partCount: members.length,
    });
  }

  const byId = new Map(graphBlocks.map((b) => [b.id, b]));

  // A net that touches a block and also touches anything outside it is a port.
  const links: GraphLink[] = [];
  for (const net of nl.nets) {
    const perBlock = new Map<string, string[]>(); // blockId -> pin types
    let outsideCount = 0;
    for (const p of net.pins) {
      const bid = blockOfRef.get(p.ref);
      if (!bid) {
        outsideCount++;
        continue;
      }
      const arr = perBlock.get(bid) ?? [];
      arr.push(p.type);
      perBlock.set(bid, arr);
    }
    const touching = [...perBlock.keys()];
    const isExternal = touching.length > 1 || outsideCount > 0 || net.isPower;
    if (isExternal) {
      for (const [bid, types] of perBlock) {
        const blk = byId.get(bid);
        if (!blk) continue;
        blk.ports.push({ net: net.name, dir: dirOf(types), isPower: net.isPower, pins: types.length });
      }
    }
    if (!net.isPower && touching.length > 1) {
      for (let i = 0; i < touching.length; i++) {
        for (let j = i + 1; j < touching.length; j++) {
          links.push({ net: net.name, isPower: false, from: touching[i], to: touching[j] });
        }
      }
    }
  }

  for (const b of graphBlocks) {
    b.ports.sort((x, y) => Number(x.isPower) - Number(y.isPower) || x.net.localeCompare(y.net));
  }

  const looseRefs: string[] = [];

  return { blocks: graphBlocks, links, looseRefs };
}
