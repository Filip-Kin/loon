// #region Storage
// A project is a folder, not a file, because a design is a schematic plus a
// board plus firmware plus fab output - and a product is often more than one
// board. A project holds a main board at its root and any number of extra
// boards under boards/<name>/, each with the same shape. The root layout is
// unchanged, so every project made before this still opens. On the home server the project directory
// sits inside the Nextcloud data tree, so everything syncs with no WebDAV round
// trip. Point LOON_FS_DIR at an ncdata path in production.
//
//   MyProduct/
//     board.kicad_sch      the main board
//     board.kicad_pcb
//     firmware/            platformio project for the main board
//     boards/remote_estop/ another board, same shape, its own firmware
//
// Projects saved by the flat-file version are migrated into a folder on first
// open, and the original file is kept as a .bak rather than deleted.

import { mkdir, readdir, readFile, writeFile, stat, rename, rm } from "node:fs/promises";
import { join, dirname, normalize } from "node:path";

export interface ProjectMeta {
  name: string;
  updated: number; // epoch ms
  size: number;
}

const SCH_EXT = ".kicad_sch";
const SCH_FILE = "board.kicad_sch";

function safeName(name: string): string {
  const base = name.replace(/[^A-Za-z0-9._-]/g, "_");
  return base.endsWith(SCH_EXT) ? base.slice(0, -SCH_EXT.length) : base;
}

// Keep every path inside the project folder: a name from the browser must not
// be able to walk out of the workspace.
function safeRelative(rel: string): string {
  const clean = normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  if (clean.startsWith("/") || clean.includes("..")) throw new Error(`Bad path: ${rel}`);
  return clean;
}

class Storage {
  constructor(private readonly dir: string) {}

  private async ensure() {
    await mkdir(this.dir, { recursive: true });
  }

  // A unit is "" for the main board, or a board name under boards/.
  projectDir(name: string, unit = ""): string {
    const root = join(this.dir, safeName(name));
    return unit ? join(root, "boards", safeName(unit)) : root;
  }

  private schPath(name: string, unit = ""): string {
    return join(this.projectDir(name, unit), SCH_FILE);
  }

  // Boards inside a project, main board first.
  async boards(name: string): Promise<string[]> {
    const out = [""];
    try {
      const entries = await readdir(join(this.dir, safeName(name), "boards"), { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        try {
          await stat(join(this.dir, safeName(name), "boards", e.name, SCH_FILE));
          out.push(e.name);
        } catch {
          /* a folder without a board is not a board */
        }
      }
    } catch {
      /* no extra boards */
    }
    return out;
  }

  async createBoard(name: string, unit: string, content: string): Promise<void> {
    await mkdir(this.projectDir(name, unit), { recursive: true });
    await writeFile(this.schPath(name, unit), content, "utf8");
  }

  // Move a flat <name>.kicad_sch into <name>/board.kicad_sch, keeping a .bak.
  private async migrateIfNeeded(name: string): Promise<void> {
    const flat = join(this.dir, `${safeName(name)}${SCH_EXT}`);
    try {
      await stat(this.schPath(name));
      return; // already a folder project
    } catch {
      /* fall through */
    }
    try {
      const text = await readFile(flat, "utf8");
      await mkdir(this.projectDir(name), { recursive: true });
      await writeFile(this.schPath(name), text, "utf8");
      await rename(flat, `${flat}.bak`);
    } catch {
      /* no flat file: nothing to migrate */
    }
  }

  async list(): Promise<ProjectMeta[]> {
    await this.ensure();
    const entries = await readdir(this.dir, { withFileTypes: true });
    const out: ProjectMeta[] = [];
    for (const e of entries) {
      if (e.name === "boards") continue;
      if (e.isDirectory()) {
        try {
          const s = await stat(join(this.dir, e.name, SCH_FILE));
          out.push({ name: e.name, updated: s.mtimeMs, size: s.size });
        } catch {
          /* a folder without a board is not a project */
        }
      } else if (e.name.endsWith(SCH_EXT)) {
        const s = await stat(join(this.dir, e.name));
        out.push({ name: e.name.slice(0, -SCH_EXT.length), updated: s.mtimeMs, size: s.size });
      }
    }
    // Deduplicate: a migrated project can briefly appear twice.
    const seen = new Map<string, ProjectMeta>();
    for (const m of out) {
      const prev = seen.get(m.name);
      if (!prev || m.updated > prev.updated) seen.set(m.name, m);
    }
    return [...seen.values()].sort((a, b) => b.updated - a.updated);
  }

  async read(name: string, unit = ""): Promise<string> {
    await this.ensure();
    if (!unit) await this.migrateIfNeeded(name);
    return readFile(this.schPath(name, unit), "utf8");
  }

  async write(name: string, content: string, unit = ""): Promise<void> {
    await this.ensure();
    await mkdir(this.projectDir(name, unit), { recursive: true });
    await writeFile(this.schPath(name, unit), content, "utf8");
  }

  // #region project files (firmware, fab output, anything else)
  async listFiles(name: string, sub = "", unit = ""): Promise<{ path: string; size: number; updated: number }[]> {
    const root = join(this.projectDir(name, unit), safeRelative(sub));
    const out: { path: string; size: number; updated: number }[] = [];
    const walk = async (dir: string, prefix: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name === ".pio" || e.name === "node_modules" || e.name.startsWith(".")) continue;
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(join(dir, e.name), rel);
        else {
          const s = await stat(join(dir, e.name));
          out.push({ path: rel, size: s.size, updated: s.mtimeMs });
        }
      }
    };
    await walk(root, "");
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async readFile(name: string, rel: string, unit = ""): Promise<string> {
    return readFile(join(this.projectDir(name, unit), safeRelative(rel)), "utf8");
  }

  async writeFile(name: string, rel: string, content: string, unit = ""): Promise<void> {
    const full = join(this.projectDir(name, unit), safeRelative(rel));
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }

  async readBinary(name: string, rel: string, unit = ""): Promise<Uint8Array> {
    const buf = await readFile(join(this.projectDir(name, unit), safeRelative(rel)));
    return new Uint8Array(buf);
  }

  async deleteFile(name: string, rel: string, unit = ""): Promise<void> {
    await rm(join(this.projectDir(name, unit), safeRelative(rel)), { force: true });
  }
}

const dir = process.env.LOON_FS_DIR ?? join(process.cwd(), "data", "projects");
export const storage = new Storage(dir);
