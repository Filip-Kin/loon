// The test that matters: press the e-stop, or let the firmware die, and check
// the switched channels actually go off - in the logic model, before copper.
// Run: bun run scripts/estoptest.ts
import { library } from "../server/src/services/library";
import { emptySchematic } from "@loon/shared/schematic";
import { applyOps, type LibResolver } from "@loon/shared/apply-ops";
import { buildModels, deriveInputs, LogicSim, suggestedWatches } from "@loon/shared/logicsim";
import { buildNetlist } from "@loon/shared/netlist";
import type { Op } from "@loon/shared/ops";

const resolve: LibResolver = (libId) => {
  const e = library.get(libId);
  return e ? { def: e.def, footprint: e.part.footprints[0] } : undefined;
};
const defs = (libId: string) => library.get(libId)?.def;

let failures = 0;
const check = (n: string, c: boolean, d = "") => { if (!c) { failures++; console.log(`FAIL ${n} ${d}`); } else console.log(`ok   ${n}`); };

const schem = emptySchematic(crypto.randomUUID());
const ops: Op[] = [
  { op: "instantiate_module", moduleId: "esp32s3_core", at: { x: 200, y: 120 } },
  { op: "instantiate_module", moduleId: "estop_input", params: { net: "ESTOP1" }, at: { x: 40, y: 240 } },
  { op: "instantiate_module", moduleId: "estop_input", params: { net: "ESTOP2" }, at: { x: 40, y: 320 } },
  { op: "instantiate_module", moduleId: "estop_latch", params: { inputs: 2 }, at: { x: 420, y: 180 } },
  { op: "instantiate_module", moduleId: "high_side_channel", params: { channel: "CH1" }, at: { x: 700, y: 120 } },
];
applyOps(schem, ops, resolve);
// The latch drives the channel's enable.
applyOps(schem, [{ op: "rename_net", from: "CH1_EN_MCU", to: "ESTOP_RUN" }], resolve);

const nl = buildNetlist(schem, defs);
const { models } = buildModels(schem, defs, nl);
const inputs = deriveInputs(models);
console.log("controls:", inputs.map((i) => i.label).join(" | "));
const watches = suggestedWatches(nl);
console.log("watching:", watches.join(", "));

const sim = new LogicSim(models, inputs);
// Arming only takes when the latch is not being cleared: the board decides
// when it is ready, the firmware only asks.
const arm = () => {
  for (let i = 0; i < 50 && sim.level("CLR_N") !== 1; i++) sim.step(5);
  inputs.find((i) => i.id === "ARM")!.pressed = true;
  sim.step(5);
  inputs.find((i) => i.id === "ARM")!.pressed = false;
  sim.step(5);
};
const show = (label: string) => {
  const s = sim.snapshot(watches);
  console.log(`t=${s.t}ms ${label}: ` + watches.map((w) => `${w}=${s.levels[w]}`).join(" "));
  return s;
};

// Power-up: the board must come up stopped, and stay stopped while the
// power-on RC holds the latch clear low.
sim.step(5);
const early = sim.snapshot(watches);
check("the power-on RC holds the clear line low at first", early.levels["CLR_N"] === 0, JSON.stringify(early.levels["CLR_N"]));
sim.step(60);
let s = show("after power-up");
check("board comes up stopped", s.levels["ESTOP_RUN"] !== 1);

// Arm it.
arm();
sim.step(20);
s = show("after arming");
check("arming turns the channels on", s.levels["ESTOP_RUN"] === 1, JSON.stringify(s.levels));

// Press e-stop 1.
const e1 = inputs.find((i) => i.kind === "estop")!;
e1.pressed = true;
sim.step(20);
s = show("e-stop 1 pressed");
check("pressing an e-stop stops the board", s.levels["ESTOP_RUN"] === 0);
check("the trip line went high", s.levels["ESTOP_TRIP"] === 1);

// Release it: the latch must stay stopped until armed again.
e1.pressed = false;
sim.step(50);
s = show("e-stop released");
check("releasing does not restart the board", s.levels["ESTOP_RUN"] !== 1);

arm();
sim.step(20);
s = show("re-armed");
check("re-arming works after a trip", s.levels["ESTOP_RUN"] === 1);

// Now kill the firmware: the watchdog must trip the same latch.
inputs.find((i) => i.id === "MCU")!.alive = false;
sim.step(100);
s = show("firmware stopped kicking");
check("a dead MCU stops the board through hardware", s.levels["ESTOP_RUN"] === 0);
check("the watchdog raised the fail line", s.levels["WDT_FAIL"] === 1 || s.levels["ESTOP_TRIP"] === 1);

console.log(failures === 0 ? "\nE-STOP TEST PASS" : `\nE-STOP TEST FAIL (${failures})`);
if (failures > 0) process.exit(1);
