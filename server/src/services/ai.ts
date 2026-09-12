// #region AI bridge
// Reuses the user's Claude subscription by invoking the local `claude` binary
// in headless print mode (same auth as claude-terminal, no separate API key).
// The model is used as a pure text->JSON transform: it receives the current
// schematic + the available parts + the op vocabulary and returns ops. It is
// run in a scratch cwd with tools off so it never touches the filesystem.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Schematic } from "@loon/shared/schematic";
import type { Op } from "@loon/shared/ops";
import { moduleSummaries } from "@loon/shared/modules";
import { pinBudget, formatBudget } from "@loon/shared/pinbudget";
import { buildNetlist, formatNetlist } from "@loon/shared/netlist";
import { runErc, formatErc } from "@loon/shared/erc";
import { buildBlockGraph } from "@loon/shared/blockgraph";
import { firmwareTargets } from "@loon/shared/firmware";
import { buildBom, formatBom } from "@loon/shared/bom";
import { library } from "./library";

const CLAUDE_BIN = process.env.LOON_CLAUDE_BIN || "claude";
// A whole-board prompt takes minutes to answer. The old 3 minute cap killed the
// model mid-answer and surfaced as "claude exited 143" (SIGTERM), which looks
// like a crash and is not one.
const AI_TIMEOUT_MS = Number(process.env.LOON_AI_TIMEOUT_MS ?? 900_000);

export interface AiResult {
  message: string;
  ops: Op[];
  raw: string;
}

function partsContext(): string {
  const defs = library.allDefs();
  const lines: string[] = [];
  for (const [libId, def] of Object.entries(defs)) {
    const pins = def.pins.map((p) => `${p.number}:${p.name}`).join(",");
    const part = library.get(libId)?.part;
    const price = part?.priceUsd !== undefined ? ` $${part.priceUsd.toFixed(2)}ea${part.mpn ? ` (${part.mpn})` : ""}` : "";
    lines.push(`- ${libId} (ref ${def.refPrefix})${price} ${def.description}${pins ? ` pins[${pins}]` : ""}`);
  }
  return lines.join("\n");
}

// What the design has already spent of its MCU pins, and what that leaves.
// Without this the assistant guesses at questions like "do I have enough ADC
// channels", which is exactly the kind of guess that costs a board spin.
function defResolver(libId: string) {
  return library.get(libId)?.def;
}

function blockContext(schem: Schematic): string {
  const g = buildBlockGraph(schem, defResolver);
  if (g.blocks.length === 0) return "(no module blocks yet)";
  const lines = g.blocks.map(
    (b) => `- ${b.moduleId} [blockId ${b.id}] ${b.partCount} parts, params ${JSON.stringify(b.params)}, ports: ${b.ports.map((p) => p.net).join(", ")}`,
  );
  if (g.looseRefs.length) lines.push(`- loose parts outside any block: ${g.looseRefs.join(", ")}`);
  return lines.join("\n");
}

function netlistContext(schem: Schematic): string {
  if (schem.symbols.length === 0) return "(empty sheet)";
  const nl = buildNetlist(schem, defResolver);
  return formatNetlist(nl, 50);
}

// The assistant sees its own rule violations, so it can fix them in the next
// turn instead of leaving them for the user to find.
function ercContext(schem: Schematic): string {
  if (schem.symbols.length === 0) return "(empty sheet)";
  return formatErc(runErc(schem, defResolver), 20);
}

function budgetContext(schem: Schematic): string {
  const budgets = pinBudget(schem, defResolver);
  if (budgets.length === 0) return "(no MCU placed yet)";
  return budgets.map(formatBudget).join("\n");
}

function bomContext(schem: Schematic): string {
  const bom = buildBom(schem, (libId) => {
    const part = library.get(libId)?.part;
    if (!part) return undefined;
    return { priceUsd: part.priceUsd, mpn: part.mpn, note: part.priceNote };
  });
  if (bom.lines.length === 0) return "(empty sheet)";
  return formatBom(bom);
}

function modulesContext(): string {
  return moduleSummaries()
    .map((m) => {
      const ps = m.params.map((pp) => `${pp.name}=${pp.default}${pp.options ? `(${pp.options.join("|")})` : ""}`).join(", ");
      return `- ${m.id}: ${m.description} params[${ps}]`;
    })
    .join("\n");
}

function schematicContext(schem: Schematic): string {
  const syms = schem.symbols.map(
    (s) => `${s.properties.Reference}: ${s.libId} value="${s.properties.Value}" at (${s.at.x},${s.at.y}) rot ${s.rotation} [uuid ${s.uuid}]`,
  );
  return [
    `paper ${schem.paper}, ${schem.symbols.length} symbols, ${schem.wires.length} wires, ${schem.labels.length} labels`,
    ...syms,
  ].join("\n");
}

const OP_SPEC = `Each op is one JSON object. Coordinates are millimetres on a 2.54mm grid, origin top-left, +x right, +y down. Available ops:
- {"op":"add_symbol","libId":"Device:R","ref":"R1","value":"10k","at":{"x":100,"y":100},"rotation":0}  (ALWAYS give an explicit unique ref; rotation optional 0/90/180/270)
- {"op":"move_symbol","uuid":"...","at":{"x":..,"y":..},"rotation":0}
- {"op":"set_property","uuid":"...","key":"Value","value":"4.7k"}
- {"op":"delete","uuid":"..."}
- {"op":"connect_pins","a":{"ref":"R1","pin":"1"},"b":{"ref":"U1","pin":"3"}}  (preferred way to wire; uses pin numbers from the parts list)
- {"op":"add_wire","from":{"x":..,"y":..},"to":{"x":..,"y":..}}
- {"op":"add_label","text":"VCC","at":{"x":..,"y":..},"kind":"local"}
- {"op":"add_text","text":"a note on the sheet","at":{"x":..,"y":..},"size":2}
- {"op":"add_junction","at":{"x":..,"y":..}}
- {"op":"add_no_connect","at":{"x":..,"y":..}}
- {"op":"set_title","title":"..","rev":".."}
- {"op":"instantiate_module","moduleId":"led_indicator","params":{"supply":"+5V","color":"red","current_ma":10},"at":{"x":120,"y":100}}  (expands a whole sub-circuit; PREFER this when a module fits the request)
Prefer connect_pins over add_wire. Space parts about 25-40mm apart.
CRITICAL RULES:
- Give every add_symbol an explicit unique "ref". Use standard prefixes: R (resistor), C (cap), L (inductor), D (diode/LED), Q (transistor), SW (switch), J (connector), and #PWR01/#PWR02/... for power symbols (GND/+5V/+3V3). Each power symbol instance needs its own #PWRxx.
- In connect_pins, use exactly the refs you assigned above.
- Use pin NUMBERS from the parts list [pins number:name]. Power symbols have a single pin, number "1". Pin names also work as a fallback.
- Order ops so every symbol referenced by connect_pins was added earlier in the same list.
- {"op":"define_symbol","libId":"Sensor:MY_PART","refPrefix":"U","value":"MY_PART","description":"...","footprint":"Package_SO:SOIC-8_3.9x4.9mm_P1.27mm","pins":[{"number":"1","name":"VCC","type":"power_in","side":"left"},{"number":"2","name":"SDA","side":"right"}]}
  Declares a part that is not in the catalog. The symbol is generated from the pin list, renders immediately, wires like any other part, and is written into the saved KiCad file.

NEVER SUBSTITUTE A PLACEHOLDER. If the user asks for a chip, module or connector that is not in the parts list, emit define_symbol with its real pinout from the datasheet and then use it. Do not drop in a generic pin header "as a placeholder", do not tell the user to swap a part later, and do not ask them to supply a symbol. A design the user cannot manufacture as-drawn is a failed answer: the board they order must have the chip on it.
Pin side hint for define_symbol: power and inputs on the left, outputs and buses on the right; the body and pin geometry are generated for you.

BLOCK-LEVEL OPS (the block view is the same document, grouped by module):
- {"op":"move_block","blockId":"...","by":{"dx":40,"dy":0}}
- {"op":"delete_block","blockId":"..."}
- {"op":"set_block_params","blockId":"...","params":{"inputs":4}}   (rebuilds the block from its module; hand edits inside it are lost)
- {"op":"rename_net","from":"ARM","to":"IO21_ARM"}   (joins two nets by name; this is how block ports connect)`;

function buildPrompt(userMessage: string, schem: Schematic): string {
  return `You are the schematic design assistant inside Loon, an electronics CAD tool.
Convert the user's request into schematic edit operations.

OUTPUT CONTRACT: respond with ONLY a single JSON object, no prose, no markdown fences:
{"message": "<one short sentence for the user>", "ops": [ <op>, ... ]}

${OP_SPEC}

AVAILABLE MODULES (parametric sub-circuits; prefer these for common blocks):
${modulesContext()}

AVAILABLE PARTS:
${partsContext()}

CURRENT SCHEMATIC:
${schematicContext(schem)}

BLOCKS ON THE SHEET:
${blockContext(schem)}

NETS (derived from the sheet, this is the real connectivity):
${netlistContext(schem)}

RULE CHECK ON THE CURRENT SHEET:
${ercContext(schem)}

MCU PIN BUDGET:
${budgetContext(schem)}

CURRENT BOM AND COST:
${bomContext(schem)}

ANSWERING DESIGN QUESTIONS:
If the user asks a question rather than giving an instruction ("how much would X cost", "do I have enough pins", "can I do Y on board"), answer it in "message" and return an empty ops array. Such an answer must contain:
- the parts it needs, with quantity and the unit price from the parts list, and a total in dollars. Say when a price is an estimate rather than a live quote.
- what it costs in MCU pins, checked against the pin budget above, and whether a multiplexer or an I2C part is needed to avoid running out.
- the one design catch that matters, in a sentence.
Then offer to build it. Keep it to a short list a person reads in ten seconds, not an essay. Plain text, no markdown tables.
If the user gives an instruction, do the work with ops and keep "message" to one line.
If the rule check above lists errors that your previous edit caused, fix them as part of this request.

USER REQUEST:
${userMessage}

Remember: output only the JSON object.`;
}

function extractJson(text: string): { message: string; ops: Op[] } {
  let t = text.trim();
  // Strip code fences if the model added them.
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  // Find the first { and last } to be forgiving.
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  const parsed = JSON.parse(t);
  const ops = Array.isArray(parsed.ops) ? parsed.ops : [];
  const message = typeof parsed.message === "string" ? parsed.message : "";
  return { message, ops };
}

async function runClaude(prompt: string): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "loon-ai-"));
  // "" disables every built-in tool: this is a pure text-to-JSON transform, and
  // a tool call here is wasted minutes on a prompt that is already slow.
  const proc = Bun.spawn([CLAUDE_BIN, "-p", prompt, "--output-format", "json", "--tools", ""], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; proc.kill(); }, AI_TIMEOUT_MS);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  clearTimeout(timeout);
  if (timedOut) {
    throw new Error(`The model ran past ${Math.round(AI_TIMEOUT_MS / 60000)} minutes and was stopped. Split the request into two or three smaller ones, or raise LOON_AI_TIMEOUT_MS.`);
  }
  if (code !== 0) {
    throw new Error(`claude exited ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`);
  }
  // --output-format json wraps the reply: { ..., "result": "<text>" }.
  try {
    const env = JSON.parse(stdout);
    if (typeof env.result === "string") return env.result;
  } catch {
    // Not the envelope; treat stdout as the raw reply.
  }
  return stdout;
}

// #region firmware authoring
// Same bridge, different contract: the model returns files, not ops. It gets
// the generated pin map and the netlist, so the code it writes uses the board's
// own net names instead of pin numbers it guessed.
export interface AiFiles {
  message: string;
  files: { path: string; content: string }[];
  raw: string;
}

function firmwarePrompt(userMessage: string, schem: Schematic, existing: { path: string; content: string }[]): string {
  const targets = firmwareTargets(schem, defResolver);
  const t = targets[0];
  const pinLines = t
    ? t.pins.map((p) => `- ${p.symbol} = GPIO${p.gpio} (net ${p.net}${p.strapping ? `, STRAPPING: ${p.strapping}` : ""}${p.adc ? `, ADC${p.adc.unit}` : ""})`).join("\n")
    : "(no MCU wired yet)";
  const files = existing.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
  return `You are the firmware assistant inside Loon, an electronics design tool. You write firmware for the board the user just designed, in the same document.

OUTPUT CONTRACT: respond with ONLY a single JSON object, no prose, no markdown fences:
{"message": "<one short sentence>", "files": [{"path": "src/main.cpp", "content": "<the whole file>"}]}
Paths are relative to the firmware/ folder. Return the COMPLETE content of every file you change. Never return a diff or a fragment.
Never write include/board_pins.h: it is generated from the schematic and your edits would be overwritten.

TARGET: ${t ? `${t.profile.name} (${t.ref})` : "unknown"}, PlatformIO with the Arduino framework.

PIN MAP (use these constants from "board_pins.h", never a raw GPIO number):
${pinLines}

PART RULES:
${t ? t.profile.rules.map((r) => `- ${r}`).join("\n") : ""}

NETS ON THE BOARD:
${netlistContext(schem)}

BLOCKS:
${blockContext(schem)}

EXISTING FIRMWARE FILES:
${files || "(none yet)"}

USER REQUEST:
${userMessage}

Keep printing a line containing the word KICK on every pass of the main loop, at least four times a second, alongside whatever else you print: the simulator feeds the board's watchdog from that line, so firmware that stops looping correctly trips the e-stop latch in the simulation the same way it would in hardware.

Write firmware that matches what the hardware actually does. If the board has a hardware e-stop latch with a watchdog charge pump, the firmware must keep toggling the kick pin to stay armed and must stop toggling to trip it - do not invent a different mechanism. Remember: output only the JSON object.`;
}

export async function generateFirmware(
  userMessage: string,
  schem: Schematic,
  existing: { path: string; content: string }[],
): Promise<AiFiles> {
  const raw = await runClaude(firmwarePrompt(userMessage, schem, existing));
  let t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  const parsed = JSON.parse(t);
  const files = Array.isArray(parsed.files)
    ? parsed.files.filter((f: any) => typeof f?.path === "string" && typeof f?.content === "string")
    : [];
  return { message: typeof parsed.message === "string" ? parsed.message : "", files, raw };
}

export async function generateOps(userMessage: string, schem: Schematic): Promise<AiResult> {
  const prompt = buildPrompt(userMessage, schem);
  const raw = await runClaude(prompt);
  const { message, ops } = extractJson(raw);
  return { message, ops, raw };
}
