// #region Simulation
// Two engines, two different questions.
//
// SPICE answers "what do the volts do": ngspice in a container, fed a deck
// generated from the same netlist the board uses.
//
// QEMU answers "what does the firmware do": Espressif's QEMU fork runs the real
// binary that was built for the board, so the code under test is the code that
// will be flashed, not a rewrite of it against a mock.

import { storage } from "./storage";
import { buildEnvs } from "./build";

const DOCKER = process.env.LOON_DOCKER_BIN ?? "docker";
const SPICE_IMAGE = process.env.LOON_SPICE_IMAGE ?? "loon-spice:latest";
const QEMU_IMAGE = process.env.LOON_QEMU_IMAGE ?? "loon-qemu:latest";
const PIO_IMAGE = process.env.LOON_PIO_IMAGE ?? "loon-pio:latest";

export interface SimJob {
  id: string;
  kind: "spice" | "qemu";
  project: string;
  started: number;
  state: "running" | "done" | "error";
  log: string;
  data?: string; // raw ngspice wrdata output
  error?: string;
}

const jobs = new Map<string, SimJob>();
export const getSim = (id: string) => jobs.get(id);

function newJob(kind: SimJob["kind"], project: string): SimJob {
  const job: SimJob = { id: crypto.randomUUID(), kind, project, started: Date.now(), state: "running", log: "" };
  jobs.set(job.id, job);
  return job;
}

async function pump(job: SimJob, stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    job.log += dec.decode(value);
    if (job.log.length > 300_000) job.log = job.log.slice(-150_000);
  }
}

export function startSpice(project: string, deck: string, unit = ""): SimJob {
  const job = newJob("spice", project);
  (async () => {
    try {
      await storage.writeFile(project, "sim/bench.cir", deck, unit);
      const dir = storage.projectDir(project, unit);
      const proc = Bun.spawn(
        [DOCKER, "run", "--rm", "-v", `${dir}/sim:/work`, "-w", "/work", SPICE_IMAGE, "ngspice", "-b", "bench.cir"],
        { stdout: "pipe", stderr: "pipe" },
      );
      await Promise.all([pump(job, proc.stdout), pump(job, proc.stderr)]);
      const code = await proc.exited;
      try {
        job.data = await storage.readFile(project, "sim/out.csv", unit);
      } catch {
        /* an analysis with no probes writes nothing */
      }
      if (code !== 0 && !job.data) {
        job.state = "error";
        job.error = `ngspice exited ${code}`;
        return;
      }
      job.state = "done";
    } catch (e: any) {
      job.state = "error";
      job.error = String(e?.message ?? e);
    }
  })();
  return job;
}

// Merge the PlatformIO artifacts into one flash image, then boot it in QEMU.
// Serial output comes back on stdout, which is what the firmware prints.
export function startQemu(project: string, seconds = 12, unit = ""): SimJob {
  const job = newJob("qemu", project);
  (async () => {
    try {
      const dir = storage.projectDir(project, unit);
      // esptool will not create the output directory, and a first run has no
      // sim/ folder yet.
      await storage.writeFile(project, "sim/.keep", "", unit);

      // Build the UART variant: the emulator has no USB peripheral, so the
      // normal build would boot and then appear silent. If the project has no
      // sim environment - because its platformio.ini was written by hand or by
      // the assistant - append one rather than overwriting what is there.
      let envs = await buildEnvs(project, unit);
      if (!envs.includes("sim")) {
        let ini = "";
        try {
          ini = await storage.readFile(project, "firmware/platformio.ini", unit);
        } catch {
          /* no ini yet */
        }
        ini += [
          "",
          "; Added by loon for the emulator: the classic ESP32 with a UART",
          "; console, because QEMU models no USB peripheral.",
          "[env:sim]",
          "platform = espressif32",
          "board = esp32dev",
          "framework = arduino",
          "monitor_speed = 115200",
          "",
        ].join("\n");
        await storage.writeFile(project, "firmware/platformio.ini", ini, unit);
        envs = await buildEnvs(project, unit);
      }
      const build = Bun.spawn(
        [DOCKER, "run", "--rm", "-v", `${dir}:/workspace`, "-v", `${process.env.LOON_PIO_VOLUME ?? "loon-platformio"}:/root/.platformio`, "-w", "/workspace/firmware", PIO_IMAGE, "pio", "run", "-e", "sim"],
        { stdout: "pipe", stderr: "pipe" },
      );
      await Promise.all([pump(job, build.stdout), pump(job, build.stderr)]);
      if ((await build.exited) !== 0) {
        job.state = "error";
        job.error = "The sim build failed. Check the firmware compiles first.";
        return;
      }
      const merge = Bun.spawn(
        [
          DOCKER, "run", "--rm", "-v", `${dir}:/work`, "-w", "/work/firmware", PIO_IMAGE,
          // The simulation build targets the classic ESP32 (see the generated
          // platformio.ini for why), whose bootloader lives at 0x1000.
          "python", "-m", "esptool", "--chip", "esp32", "merge-bin", "-o", "/work/sim/flash.bin",
          // QEMU only accepts 2, 4, 8 or 16MB images, and merge-bin does not pad
          // to the flash size on its own.
          // QEMU only accepts 2, 4, 8 or 16MB images, and the size must match
          // the bootloader header or the second stage hangs.
          "--flash-mode", "dio", "--flash-freq", "40m", "--flash-size", "4MB", "--pad-to-size", "4MB",
          "0x1000", ".pio/build/sim/bootloader.bin",
          "0x8000", ".pio/build/sim/partitions.bin",
          "0x10000", ".pio/build/sim/firmware.bin",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      await Promise.all([pump(job, merge.stdout), pump(job, merge.stderr)]);
      if ((await merge.exited) !== 0) {
        job.state = "error";
        job.error = "Could not merge the flash image. Build the firmware first.";
        return;
      }

      const proc = Bun.spawn(
        [
          DOCKER, "run", "--rm", "-v", `${dir}/sim:/work`, "-w", "/work", QEMU_IMAGE,
          "timeout", String(seconds),
          "qemu-system-xtensa", "-nographic", "-machine", "esp32",
          "-drive", "file=flash.bin,if=mtd,format=raw",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      await Promise.all([pump(job, proc.stdout), pump(job, proc.stderr)]);
      await proc.exited;
      // `timeout` kills QEMU on purpose, so a non-zero exit is expected here.
      job.state = "done";
    } catch (e: any) {
      job.state = "error";
      job.error = String(e?.message ?? e);
    }
  })();
  return job;
}
