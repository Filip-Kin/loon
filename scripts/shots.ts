// Screenshots of the running app, plus the horizontal-overflow check that
// reasoning about the CSS does not replace.
// Run: bun run scripts/shots.ts <url> <outdir> [view=schematic|pcb|blocks] [width] [height]
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5179";
const out = process.argv[3] ?? "/tmp/loon-shots";
const which = process.argv[4] ?? "schematic";
const width = Number(process.argv[5] ?? 1600);
const height = Number(process.argv[6] ?? 1000);
mkdirSync(out, { recursive: true });

const CHROME = process.env.CHROME_PATH ?? "/usr/bin/chromium";
const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width, height, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("console error:", m.text()); });
page.on("pageerror", (e) => console.log("page error:", String(e).slice(0, 300)));
await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
await new Promise((r) => setTimeout(r, 4000));

// Click the named view in the top bar.
const label = which === "pcb" ? "PCB" : which === "blocks" ? "Blocks" : which === "code" ? "Code" : "Schematic";
await page.evaluate((l) => {
  const b = [...document.querySelectorAll(".topbar button")].find((x) => x.textContent?.trim() === l) as HTMLButtonElement | undefined;
  b?.click();
}, label);
await new Promise((r) => setTimeout(r, which === "pcb" ? 9000 : 3000));

const name = `${which}-${width}`;
await page.screenshot({ path: `${out}/${name}.png` });

const m = await page.evaluate(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
  // Whatever is sticking out past the viewport, so the fix has an address.
  wide: [...document.querySelectorAll("*")]
    .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
    .slice(0, 6)
    .map((el) => `${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]} right=${Math.round(el.getBoundingClientRect().right)}`),
}));
console.log(`${name}: scrollWidth=${m.scrollWidth} clientWidth=${m.clientWidth} ${m.scrollWidth === m.clientWidth ? "OK" : "OVERFLOW"}`);
if (m.wide.length) console.log("  past the edge:", m.wide.join(" | "));
console.log(`wrote ${out}/${name}.png`);

await browser.close();
