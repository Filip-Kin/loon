// Screenshot loon's PCB layout view for one project, the way Filip sees it.
// Run: bun run scripts/pcbshot.ts <project> <out.png> [x0 y0 x1 y1 in board mm to zoom to]
import puppeteer from "puppeteer-core";
const [project, out, ...box] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"], defaultViewport: { width: 1400, height: 1400, deviceScaleFactor: 2 } });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("page error:", String(e).slice(0, 300)));
await page.goto("http://127.0.0.1:8790/", { waitUntil: "domcontentloaded" });
await page.evaluate((p) => localStorage.setItem("loon.lastProject", p), project);
await page.goto("http://127.0.0.1:8790/", { waitUntil: "networkidle2", timeout: 60000 });
await new Promise((r) => setTimeout(r, 3000));
await page.evaluate(() => { const b = [...document.querySelectorAll(".topbar button")].find((x) => x.textContent?.trim() === "PCB") as HTMLButtonElement | undefined; b?.click(); });
await new Promise((r) => setTimeout(r, 10000));
if (box.length === 4) {
  // zoom: wheel on the canvas centred on the box, then screenshot the canvas
  const [x0, y0, x1, y1] = box.map(Number);
  const info = await page.evaluate(() => { const s = document.querySelector("svg.pcbcanvas") as SVGSVGElement; const g = s.querySelector("g") as SVGGElement; const r = s.getBoundingClientRect(); return { r: { x: r.x, y: r.y, w: r.width, h: r.height }, t: g.getAttribute("transform") }; });
  const m = info.t?.match(/translate\(([-\d.]+),([-\d.]+)\) scale\(([-\d.]+)\)/);
  if (m) {
    let [tx, ty, sc] = [+m[1], +m[2], +m[3]];
    const want = Math.min(info.r.w / (x1 - x0), info.r.h / (y1 - y0));
    let steps = Math.round(Math.log(want / sc) / Math.log(1.15));
    const cx = info.r.x + tx + ((x0 + x1) / 2) * sc, cy = info.r.y + ty + ((y0 + y1) / 2) * sc;
    for (let i = 0; i < Math.abs(steps); i++) { await page.mouse.move(cx, cy); await page.mouse.wheel({ deltaY: steps > 0 ? -100 : 100 }); await new Promise((r) => setTimeout(r, 60)); }
    // re-centre: drag with the middle button
    const info2 = await page.evaluate(() => { const s = document.querySelector("svg.pcbcanvas") as SVGSVGElement; const g = s.querySelector("g") as SVGGElement; const r = s.getBoundingClientRect(); return { r: { x: r.x, y: r.y, w: r.width, h: r.height }, t: g.getAttribute("transform") }; });
    const m2 = info2.t!.match(/translate\(([-\d.]+),([-\d.]+)\) scale\(([-\d.]+)\)/)!;
    const px = info2.r.x + +m2[1] + ((x0 + x1) / 2) * +m2[3], py = info2.r.y + +m2[2] + ((y0 + y1) / 2) * +m2[3];
    const tx2 = info2.r.x + info2.r.w / 2, ty2 = info2.r.y + info2.r.h / 2;
    await page.mouse.move(px, py); await page.mouse.down({ button: "middle" }); await page.mouse.move(tx2, ty2, { steps: 10 }); await page.mouse.up({ button: "middle" });
    await new Promise((r) => setTimeout(r, 800));
  }
  const el = await page.$("svg.pcbcanvas");
  await el!.screenshot({ path: out });
} else await page.screenshot({ path: out });
console.log("wrote", out);
await browser.close();
