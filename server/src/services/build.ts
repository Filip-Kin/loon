// #region Firmware builds
// PlatformIO runs in a container so the host stays clean and the ESP32
// toolchain is fetched once into a named volume instead of on every build.
// Builds are jobs: the first one pulls a toolchain and takes minutes, which no
// HTTP request should be holding open.

import { storage } from "./storage";

const IMAGE = process.env.LOON_PIO_IMAGE ?? "loon-pio:latest";
const TOOLCHAIN_VOLUME = process.env.LOON_PIO_VOLUME ?? "loon-platformio";
const DOCKER = process.env.LOON_DOCKER_BIN ?? "docker";

export interface BuildJob {
  id: string;
  project: string;
  started: number;
  state: "running" | "done" | "error";
  log: string;
  // Paths of the flashable artifacts, relative to the project folder.
  artifacts?: { path: string; offset: number }[];
  error?: string;
}

const jobs = new Map<string, BuildJob>();

// Where the ESP32 bootloader expects each image in flash. The build directory
// is named after the environment, and the environment is whatever the project's
// platformio.ini calls it - which the assistant is free to rename - so the
// artifacts are discovered rather than assumed.
const OFFSETS: Record<string, number> = {
  "bootloader.bin": 0x0,
  "partitions.bin": 0x8000,
  "firmware.bin": 0x10000,
};

export async function buildEnvs(project: string, unit = ""): Promise<string[]> {
  try {
    const ini = await storage.readFile(project, "firmware/platformio.ini", unit);
    return [...ini.matchAll(/^\s*\[env:([^\]]+)\]/gm)].map((m) => m[1].trim());
  } catch {
    return [];
  }
}

// Prefer the environment that was actually built most recently.
async function findArtifacts(project: string, envs: string[], unit = ""): Promise<{ path: string; offset: number }[]> {
  for (const env of envs) {
    const found: { path: string; offset: number }[] = [];
    for (const [file, offset] of Object.entries(OFFSETS)) {
      const path = `firmware/.pio/build/${env}/${file}`;
      try {
        await storage.readBinary(project, path, unit);
        found.push({ path, offset });
      } catch {
        /* not every env produces every image */
      }
    }
    if (found.some((f) => f.path.endsWith("firmware.bin"))) return found;
  }
  return [];
}

export function getBuild(id: string): BuildJob | undefined {
  return jobs.get(id);
}

export function listBuilds(project: string): BuildJob[] {
  return [...jobs.values()].filter((j) => j.project === project).sort((a, b) => b.started - a.started);
}

export function startBuild(project: string, unit = ""): BuildJob {
  const id = crypto.randomUUID();
  const job: BuildJob = { id, project, started: Date.now(), state: "running", log: "" };
  jobs.set(id, job);

  const dir = storage.projectDir(project, unit);
  const args = [
    "run", "--rm",
    "-v", `${dir}:/workspace`,
    "-v", `${TOOLCHAIN_VOLUME}:/root/.platformio`,
    "-w", "/workspace/firmware",
    IMAGE,
    "pio", "run",
  ];

  (async () => {
    try {
      const proc = Bun.spawn([DOCKER, ...args], { stdout: "pipe", stderr: "pipe" });
      const pump = async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          job.log += dec.decode(value);
          if (job.log.length > 400_000) job.log = job.log.slice(-200_000);
        }
      };
      await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
      const code = await proc.exited;
      if (code !== 0) {
        job.state = "error";
        job.error = `pio run exited ${code}`;
        return;
      }
      const envs = await buildEnvs(project, unit);
      const present = await findArtifacts(project, envs, unit);
      job.artifacts = present;
      if (present.length === 0) {
        job.state = "error";
        job.error = `The build produced no images. Environments found in platformio.ini: ${envs.join(", ") || "none"}.`;
        return;
      }
      job.state = "done";
    } catch (e: any) {
      job.state = "error";
      job.error = String(e?.message ?? e);
      job.log += `\n${job.error}\n`;
    }
  })();

  return job;
}
