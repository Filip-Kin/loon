// #region Storage
// Projects load/save straight to the filesystem. On the home server the project
// directory is simply a folder inside the Nextcloud data tree, so saved files
// sync to Nextcloud with no WebDAV round trip. Point LOON_FS_DIR at an ncdata
// path in production; the dev default keeps files inside the repo.
// A "project" is currently a single .kicad_sch file addressed by name.

import { mkdir, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface ProjectMeta {
  name: string;
  updated: number; // epoch ms
  size: number;
}

const SCH_EXT = ".kicad_sch";

function safeName(name: string): string {
  const base = name.replace(/[^A-Za-z0-9._-]/g, "_");
  return base.endsWith(SCH_EXT) ? base : base + SCH_EXT;
}

class Storage {
  constructor(private readonly dir: string) {}

  private async ensure() {
    await mkdir(this.dir, { recursive: true });
  }

  async list(): Promise<ProjectMeta[]> {
    await this.ensure();
    const files = await readdir(this.dir);
    const out: ProjectMeta[] = [];
    for (const f of files) {
      if (!f.endsWith(SCH_EXT)) continue;
      const s = await stat(join(this.dir, f));
      out.push({ name: f.slice(0, -SCH_EXT.length), updated: s.mtimeMs, size: s.size });
    }
    return out.sort((a, b) => b.updated - a.updated);
  }

  async read(name: string): Promise<string> {
    await this.ensure();
    return readFile(join(this.dir, safeName(name)), "utf8");
  }

  async write(name: string, content: string): Promise<void> {
    await this.ensure();
    await writeFile(join(this.dir, safeName(name)), content, "utf8");
  }
}

const dir = process.env.LOON_FS_DIR ?? join(process.cwd(), "data", "projects");
export const storage = new Storage(dir);
