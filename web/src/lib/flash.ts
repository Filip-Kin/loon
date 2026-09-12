// #region Browser flashing
// esptool-js over WebSerial: the board on the other end of the USB-C port gets
// programmed from the tab that designed it, with no toolchain on the laptop.
// Chromium only - WebSerial does not exist in Safari or Firefox, and saying so
// is better than a dead button.

import { ESPLoader, Transport } from "esptool-js";

export interface FlashProgress {
  file: string;
  percent: number;
  message: string;
}

async function fetchBinary(project: string, path: string): Promise<string> {
  const res = await fetch(`/artifact/${encodeURIComponent(project)}/${path}`);
  if (!res.ok) throw new Error(`Could not fetch ${path} (${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  // esptool-js wants a binary string, not a typed array.
  let out = "";
  for (let i = 0; i < buf.length; i++) out += String.fromCharCode(buf[i]);
  return out;
}

export async function flashBoard(
  project: string,
  artifacts: { path: string; offset: number }[],
  onProgress: (p: FlashProgress) => void,
): Promise<void> {
  const anyNav = navigator as any;
  if (!anyNav.serial) throw new Error("This browser has no WebSerial. Use Chrome or Edge.");

  const port = await anyNav.serial.requestPort();
  const transport = new Transport(port, true);
  const loader = new ESPLoader({
    transport,
    baudrate: 921600,
    romBaudrate: 115200,
    terminal: {
      clean() {},
      writeLine(data: string) { onProgress({ file: "", percent: 0, message: data }); },
      write(data: string) { onProgress({ file: "", percent: 0, message: data }); },
    },
  } as any);

  try {
    const chip = await loader.main();
    onProgress({ file: "", percent: 0, message: `Connected to ${chip}` });

    const fileArray = [];
    for (const a of artifacts) {
      fileArray.push({ data: await fetchBinary(project, a.path), address: a.offset });
    }

    await loader.writeFlash({
      fileArray,
      flashSize: "keep",
      flashMode: "keep",
      flashFreq: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (fileIndex: number, written: number, total: number) => {
        onProgress({
          file: artifacts[fileIndex]?.path ?? "",
          percent: total > 0 ? (written / total) * 100 : 0,
          message: "writing",
        });
      },
    } as any);

    await loader.after();
  } finally {
    try {
      await transport.disconnect();
    } catch {
      /* the port may already be gone */
    }
  }
}
