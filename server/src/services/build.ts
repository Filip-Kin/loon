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

// Where PlatformIO drops the images, and where the ESP32 bootloader expects
// each of them in flash.
const ARTIFACTS: { file: string; offset: number }[] = [
  { file: "firmware/.pio/build/board/bootloader.bin", offset: 0x0 },
  { file: "firmware/.pio/build/board/partitions.bin", offset: 0x8000 },
  { file: "firmware/.pio/build/board/firmware.bin", offset: 0x10000 },
];

export function getBuild(id: string): BuildJob | undefined {
  return jobs.get(id);
}

export function listBuilds(project: string): BuildJob[] {
  return [...jobs.values()].filter((j) => j.project === project).sort((a, b) => b.started - a.started);
}

export function startBuild(project: string): BuildJob {
  const id = crypto.randomUUID();
  const job: BuildJob = { id, project, started: Date.now(), state: "running", log: "" };
  jobs.set(id, job);

  const dir = storage.projectDir(project);
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
      const present: { path: string; offset: number }[] = [];
      for (const a of ARTIFACTS) {
        try {
          await storage.readBinary(project, a.file);
          present.push({ path: a.file, offset: a.offset });
        } catch {
          /* a build without this artifact is still usable */
        }
      }
      job.artifacts = present;
      job.state = "done";
    } catch (e: any) {
      job.state = "error";
      job.error = String(e?.message ?? e);
      job.log += `\n${job.error}\n`;
    }
  })();

  return job;
}
