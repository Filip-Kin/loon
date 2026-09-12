// #region BOM + costing
// Rolls the placed symbols up into a bill of materials with a price per line,
// so a design question can be answered in dollars rather than in adjectives.
// Power-rail symbols are schematic decoration and never appear in the BOM.

import type { Schematic } from "./schematic";

export interface PriceInfo {
  priceUsd?: number;
  mpn?: string;
  note?: string;
}

export interface BomLine {
  libId: string;
  value: string;
  refs: string[];
  qty: number;
  unitUsd?: number;
  extUsd?: number;
  mpn?: string;
  priceNote?: string;
}

export interface Bom {
  lines: BomLine[];
  totalUsd: number;
  unpriced: string[];
  // True while any line is priced from a seeded estimate rather than a live
  // supplier quote, which the answer must say out loud.
  estimated: boolean;
}

const isPowerSymbol = (libId: string) => libId.startsWith("power:");

export function buildBom(schem: Schematic, priceOf: (libId: string) => PriceInfo | undefined): Bom {
  const byKey = new Map<string, BomLine>();
  for (const s of schem.symbols) {
    if (isPowerSymbol(s.libId)) continue;
    const value = s.properties.Value ?? "";
    const key = `${s.libId}|${value}`;
    const price = priceOf(s.libId);
    const line = byKey.get(key) ?? {
      libId: s.libId,
      value,
      refs: [],
      qty: 0,
      unitUsd: price?.priceUsd,
      mpn: price?.mpn,
      priceNote: price?.note,
    };
    line.refs.push(s.properties.Reference ?? "?");
    line.qty += 1;
    byKey.set(key, line);
  }
  const lines = [...byKey.values()].sort((a, b) => a.refs[0].localeCompare(b.refs[0]));
  let total = 0;
  const unpriced: string[] = [];
  for (const l of lines) {
    if (l.unitUsd === undefined) unpriced.push(l.libId);
    else {
      l.extUsd = Math.round(l.unitUsd * l.qty * 100) / 100;
      total += l.extUsd;
    }
  }
  return {
    lines,
    totalUsd: Math.round(total * 100) / 100,
    unpriced,
    estimated: lines.some((l) => l.priceNote?.includes("estimate")),
  };
}

export function formatBom(bom: Bom): string {
  const rows = bom.lines.map((l) => {
    const unit = l.unitUsd === undefined ? "?" : `$${l.unitUsd.toFixed(2)}`;
    const ext = l.extUsd === undefined ? "?" : `$${l.extUsd.toFixed(2)}`;
    return `  ${l.qty}x ${l.value || l.libId} [${l.refs.join(",")}] ${unit} ea = ${ext}`;
  });
  rows.push(`  board total (parts only): $${bom.totalUsd.toFixed(2)}${bom.unpriced.length ? ` + ${bom.unpriced.length} unpriced line(s)` : ""}`);
  return rows.join("\n");
}
