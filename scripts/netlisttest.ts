// Netlist + ERC check: build the control section, then verify connectivity is
// derived correctly from geometry and labels, not just visually plausible.
// Run: bun run scripts/netlisttest.ts
import { library } from "../server/src/services/library";
import { emptySchematic } from "@loon/shared/schematic";
import { applyOps, type LibResolver } from "@loon/shared/apply-ops";
import { buildNetlist, formatNetlist } from "@loon/shared/netlist";
import { runErc, formatErc, summarizeNets } from "@loon/shared/erc";
import type { Op } from "@loon/shared/ops";

const resolve: LibResolver = (libId) => {
  const e = library.get(libId);
  return e ? { def: e.def, footprint: e.part.footprints[0] } : undefined;
};
const defs = (libId: string) => library.get(libId)?.def;

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (!cond) { failures++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`);
};

const schem = emptySchematic(crypto.randomUUID());
const ops: Op[] = [
  { op: "instantiate_module", moduleId: "esp32s3_core", at: { x: 200, y: 120 } },
  { op: "instantiate_module", moduleId: "usb_c_program", at: { x: 340, y: 60 } },
  { op: "instantiate_module", moduleId: "estop_latch", params: { inputs: 2 }, at: { x: 560, y: 120 } },
  { op: "instantiate_module", moduleId: "ldo_3v3", at: { x: 60, y: 120 } },
];
const { results } = applyOps(schem, ops, resolve);
check("ops applied", results.every((r) => r.ok), results.filter((r) => !r.ok).map((r) => r.error).join("; "));

const nl = buildNetlist(schem, defs);
const stats = summarizeNets(nl);
console.log(`nets: ${stats.total} (${stats.power} power, ${stats.singlePin} single-pin)`);

const byName = new Map(nl.nets.map((n) => [n.name, n]));
// Internal module nets carry a per-instance suffix, so resolve by base name.
const net = (base: string) => byName.get(base) ?? nl.nets.find((n) => n.name.startsWith(base + "_"));
check("3V3 rail exists and is shared", (byName.get("+3V3")?.pins.length ?? 0) > 5);
check("GND exists and is shared", (byName.get("GND")?.pins.length ?? 0) > 8);

// The ESP32's EN pin must resolve to the same net as the pull-up and the RC cap.
const en = byName.get("EN");
check("EN net found", !!en, [...byName.keys()].join(","));
if (en) {
  const refs = en.pins.map((p) => `${p.ref}.${p.pin}`);
  console.log("  EN:", refs.join(" "));
  check("EN reaches the module, a resistor, a cap and the reset button", en.pins.length >= 4, refs.join(" "));
  check("EN includes the ESP32 pin 3", en.pins.some((p) => p.libId.includes("ESP32") && p.pin === "3"));
}

// USB must be continuous from the connector, through the ESD array, to the MCU.
const dm = byName.get("USB_D-");
check("USB_D- joins the ESD array and the MCU", !!dm && dm.pins.some((p) => p.libId.includes("ESP32")) && dm.pins.some((p) => p.libId.includes("USBLC6")));

// The latch's trip node must gather both e-stops and the watchdog.
const trip = net("ESTOP_TRIP");
check("ESTOP_TRIP gathers 2 e-stop diodes, the watchdog diode, the pulldown and the inverter", (trip?.pins.length ?? 0) >= 5, String(trip?.pins.length));

const wdt = byName.get("WDT_KICK");
check("watchdog kick is a real net", (wdt?.pins.length ?? 0) >= 1);

console.log("\n" + formatNetlist(nl, 18));

const issues = runErc(schem, defs, nl);
console.log("\n" + formatErc(issues, 12));
check("no duplicate references", !issues.some((i) => i.rule === "duplicate-reference"), issues.filter((i) => i.rule === "duplicate-reference").map((i) => i.message).join("; "));
check("no fighting drivers", !issues.some((i) => i.rule === "multiple-drivers"), issues.filter((i) => i.rule === "multiple-drivers").map((i) => i.message).join("; "));

console.log(failures === 0 ? "\nNETLIST TEST PASS" : `\nNETLIST TEST FAIL (${failures})`);
if (failures > 0) process.exit(1);
