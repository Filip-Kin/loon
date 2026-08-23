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
import { library } from "./library";

const CLAUDE_BIN = process.env.LOON_CLAUDE_BIN || "claude";

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
    lines.push(`- ${libId} (ref ${def.refPrefix}) ${def.description}${pins ? ` pins[${pins}]` : ""}`);
  }
  return lines.join("\n");
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
- Order ops so every symbol referenced by connect_pins was added earlier in the same list.`;

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
  const proc = Bun.spawn([CLAUDE_BIN, "-p", prompt, "--output-format", "json"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const timeout = setTimeout(() => proc.kill(), 180_000);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  clearTimeout(timeout);
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

export async function generateOps(userMessage: string, schem: Schematic): Promise<AiResult> {
  const prompt = buildPrompt(userMessage, schem);
  const raw = await runClaude(prompt);
  const { message, ops } = extractJson(raw);
  return { message, ops, raw };
}
