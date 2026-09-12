// #region Parts library + source filtering
// A "part" is a catalog entry the user can drop onto a schematic. It binds a
// KiCad symbol (graphics + pins) to real-world sourcing info from one or more
// suppliers/fabs. The source filter lets the user restrict the visible catalog
// to parts a chosen fab can actually source and place, e.g. only parts OSH Park
// stocks for pick-and-place assembly.

export type PartSource = "kicad" | "digikey" | "mouser" | "oshpark";

export const ALL_SOURCES: PartSource[] = ["kicad", "digikey", "mouser", "oshpark"];

export const SOURCE_LABELS: Record<PartSource, string> = {
  kicad: "KiCad library",
  digikey: "DigiKey",
  mouser: "Mouser",
  oshpark: "OSH Park assembly",
};

export interface SourceAvailability {
  source: PartSource;
  available: boolean;
  // Supplier/fab part number when known.
  sku?: string;
  stock?: number;
  priceUsd?: number;
  url?: string;
}

export interface PartSummary {
  // Stable catalog id (usually the KiCad lib_id, e.g. "Device:R").
  id: string;
  libId: string;
  name: string;
  description: string;
  refPrefix: string;
  keywords: string;
  footprints: string[];
  sources: SourceAvailability[];
  // Unit price used for BOM costing. Seeded estimates today; replaced by live
  // supplier data when the DigiKey/Mouser keys are wired in.
  priceUsd?: number;
  priceNote?: string;
  mpn?: string;
}

export interface PartSearchQuery {
  text?: string;
  // Part must be available in every listed source (AND). Empty = no filter.
  requireSources?: PartSource[];
  limit?: number;
}

export function partMatches(part: PartSummary, q: PartSearchQuery): boolean {
  if (q.requireSources && q.requireSources.length > 0) {
    for (const src of q.requireSources) {
      const a = part.sources.find((s) => s.source === src);
      if (!a || !a.available) return false;
    }
  }
  if (q.text && q.text.trim().length > 0) {
    const hay = `${part.libId} ${part.name} ${part.description} ${part.keywords}`.toLowerCase();
    const terms = q.text.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.every((t) => hay.includes(t))) return false;
  }
  return true;
}
