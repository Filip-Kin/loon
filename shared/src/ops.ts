// #region Schematic operations
// The edit vocabulary. The UI, undo/redo, and the AI all speak these ops so
// there is exactly one way to mutate a schematic. The AI returns an array of
// these; the server validates and applies them, then returns the new state.

import type { IcSymbolSpec } from "./symbolgen";

export type PinRef = { ref: string; pin: string }; // e.g. { ref: "R1", pin: "1" }

export type Op =
  | { op: "add_symbol"; libId: string; ref?: string; value?: string; at?: { x: number; y: number }; rotation?: number; uuid?: string }
  | { op: "move_symbol"; uuid: string; at: { x: number; y: number }; rotation?: number }
  | { op: "set_property"; uuid: string; key: string; value: string }
  | { op: "delete"; uuid: string }
  | { op: "add_wire"; from: { x: number; y: number }; to: { x: number; y: number } }
  | { op: "connect_pins"; a: PinRef; b: PinRef }
  | { op: "add_junction"; at: { x: number; y: number } }
  | { op: "add_label"; text: string; at: { x: number; y: number }; rotation?: number; kind?: "local" | "global" | "hier" }
  | { op: "add_no_connect"; at: { x: number; y: number } }
  | { op: "add_text"; text: string; at: { x: number; y: number }; rotation?: number; size?: number }
  | { op: "set_title"; title?: string; rev?: string; company?: string }
  // Instantiate a parametric sub-circuit (a "module"): expands to primitive
  // ops. Modules are the building blocks the AI composes larger designs from.
  | { op: "instantiate_module"; moduleId: string; params?: Record<string, string | number>; at?: { x: number; y: number } }
  // Declare a part that is not in the builtin catalog (any IC, module or
  // connector) from its pin list. The generated symbol is stored on the
  // schematic, so it renders, wires and saves exactly like a builtin part.
  // This exists so the assistant never has to stand in a placeholder header.
  | ({ op: "define_symbol" } & IcSymbolSpec)
  // #region block-level ops
  // The block view edits the schematic through these; they are ordinary ops so
  // undo, the AI and the API all behave the same in either view.
  | { op: "move_block"; blockId: string; by?: { dx: number; dy: number }; at?: { x: number; y: number } }
  | { op: "delete_block"; blockId: string }
  // Join two nets by name: every label reading `from` becomes `to`. This is how
  // connecting two block ports is expressed.
  | { op: "rename_net"; from: string; to: string }
  // Re-expand a block with new parameters. Its old parts are removed first, so
  // hand edits inside the block are lost - the UI must confirm.
  | { op: "set_block_params"; blockId: string; params: Record<string, string | number> };

export interface OpResult {
  ok: boolean;
  // For add_* ops, the uuid of the created element.
  createdUuid?: string;
  error?: string;
}
