// #region Footprint library
// Land patterns come from KiCad's own footprint library, fetched on demand and
// cached on disk. A generated land pattern is a guess, and a guessed land
// pattern is a board you cannot solder, so the real one is always preferred and
// anything generated is flagged.
//
// The cache lives outside the project folder: it is shared by every design and
// is rebuildable, so it does not belong in a user's Nextcloud tree.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFootprint, generateFootprint, type Footprint } from "@loon/shared/footprint";

const CACHE_DIR = process.env.LOON_FP_CACHE ?? join(process.cwd(), "data", "footprints");
// Pinned to the KiCad 9 library tag, not master: master tracks the next KiCad
// release and emits footprints that KiCad 9 refuses to load. OSH Park processes
// with the latest stable KiCad, which is 9.x.
const FP_REF = process.env.LOON_FP_REF ?? "9.0.9.1";
const BASE = process.env.LOON_FP_URL ?? `https://gitlab.com/kicad/libraries/kicad-footprints/-/raw/${FP_REF}`;

const memo = new Map<string, Footprint>();

function cachePath(libId: string): string {
  return join(CACHE_DIR, `${libId.replace(/[^A-Za-z0-9._-]/g, "_")}.kicad_mod`);
}

async function fromCache(libId: string): Promise<string | undefined> {
  try {
    return await readFile(cachePath(libId), "utf8");
  } catch {
    return undefined;
  }
}

async function fromKicadLibrary(libId: string): Promise<string | undefined> {
  const [lib, name] = libId.split(":");
  if (!lib || !name) return undefined;
  const url = `${BASE}/${encodeURIComponent(lib)}.pretty/${encodeURIComponent(name)}.kicad_mod`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return undefined;
    const text = await res.text();
    if (!text.startsWith("(footprint") && !text.startsWith("(module")) return undefined;
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath(libId), text, "utf8");
    return text;
  } catch {
    return undefined;
  }
}

export async function getFootprint(libId: string, padCountHint = 2): Promise<Footprint> {
  const hit = memo.get(libId);
  if (hit) return hit;

  const text = (await fromCache(libId)) ?? (await fromKicadLibrary(libId));
  const fp = text ? parseFootprint(text, libId) : generateFootprint(libId, padCountHint);
  memo.set(libId, fp);
  return fp;
}

export async function getFootprints(specs: { libId: string; padCount: number }[]): Promise<Record<string, Footprint>> {
  const out: Record<string, Footprint> = {};
  for (const s of specs) {
    if (!s.libId) continue;
    out[s.libId] = await getFootprint(s.libId, s.padCount);
  }
  return out;
}
