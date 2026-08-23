// Runs the API server and the Vite web dev server together with tagged output.
const procs = [
  { name: "server", cmd: ["bun", "run", "dev"], cwd: "server", color: "\x1b[36m" },
  { name: "web", cmd: ["bun", "run", "dev"], cwd: "web", color: "\x1b[35m" },
];

const reset = "\x1b[0m";

for (const p of procs) {
  const proc = Bun.spawn(p.cmd, {
    cwd: new URL(`../${p.cwd}/`, import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const pipe = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) console.log(`${p.color}[${p.name}]${reset} ${line}`);
    }
  };
  pipe(proc.stdout);
  pipe(proc.stderr);
}

// Keep the parent alive.
await new Promise(() => {});
