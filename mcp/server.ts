// #region loon-probe MCP server
// Exposes the hardware probe to any MCP client (a claude-terminal session, or
// loon's own AI debug mode) as tools. It talks to the loon server over tRPC, so
// the probe agent, the server, and Claude stay decoupled. Claude uses these to
// read and drive real pins on a built board while reasoning about the design.
//
// Register in a project's .mcp.json:
//   { "mcpServers": { "loon-probe": { "command": "bun",
//       "args": ["run", "/path/to/loon/mcp/server.ts"],
//       "env": { "LOON_URL": "http://localhost:8790/trpc" } } } }

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { z } from "zod";
import type { AppRouter } from "../server/src/routers";
import type { ProbeCommand } from "@loon/shared/probe";

const LOON_URL = process.env.LOON_URL || "http://localhost:8790/trpc";
const trpc = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: LOON_URL })] });

const text = (obj: unknown) => ({ content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });

async function exec(probeId: string, command: ProbeCommand) {
  return trpc.probe.execute.mutate({ probeId, command });
}

const server = new McpServer({ name: "loon-probe", version: "0.1.0" });

server.registerTool(
  "probe_list",
  {
    description: "List connected hardware probes and their capabilities (board, logic voltage, 5V tolerance, GPIO pins, ADC channels, buses). Call this first to get a probeId and to learn the probe's limits before driving pins.",
    inputSchema: {},
  },
  async () => {
    const probes = await trpc.probe.list.query();
    if (!probes.length) return text("No probes connected. Ask the user to run the loon-probe agent on their Pi/ESP32 and wire it to the board.");
    return text(
      probes.map((p) => ({
        probeId: p.id,
        name: p.name,
        board: p.capabilities.board,
        logicVoltage: p.capabilities.logicVoltage,
        fiveVoltTolerant: p.capabilities.fiveVoltTolerant,
        gpio: p.capabilities.gpio.map((g) => g.id),
        adc: p.capabilities.adc.map((a) => `${a.id} (${a.device}, ${a.bits}-bit, ${a.vref}V FS, <=${a.maxSampleHz}Hz)`),
        i2c: p.capabilities.i2c,
        spi: p.capabilities.spi,
        maxDigitalSampleHz: p.capabilities.maxDigitalSampleHz,
        notes: p.capabilities.notes,
      })),
    );
  },
);

server.registerTool(
  "probe_read_pin",
  { description: "Read a digital logic level (0/1) from a GPIO pin.", inputSchema: { probeId: z.string(), pin: z.string().describe("GPIO id, e.g. GPIO17") } },
  async ({ probeId, pin }) => text(await exec(probeId, { cmd: "read_pin", pin })),
);

server.registerTool(
  "probe_set_mode",
  { description: "Set a GPIO pin mode before reading or driving it.", inputSchema: { probeId: z.string(), pin: z.string(), mode: z.enum(["input", "input_pullup", "input_pulldown", "output", "pwm"]) } },
  async ({ probeId, pin, mode }) => text(await exec(probeId, { cmd: "set_mode", pin, mode })),
);

server.registerTool(
  "probe_write_pin",
  {
    description: "Drive a GPIO pin high (1) or low (0). SAFETY: the probe outputs its logic voltage (3.3V on a Pi); never drive a pin that is already driven by the board, and check fiveVoltTolerant before connecting to 5V nets.",
    inputSchema: { probeId: z.string(), pin: z.string(), value: z.union([z.literal(0), z.literal(1)]) },
  },
  async ({ probeId, pin, value }) => text(await exec(probeId, { cmd: "write_pin", pin, value })),
);

server.registerTool(
  "probe_read_voltage",
  { description: "Read an analog voltage from an ADC channel (requires an ADC on the probe, e.g. ADS1115). Returns volts.", inputSchema: { probeId: z.string(), channel: z.string().describe("ADC channel id, e.g. A0") } },
  async ({ probeId, channel }) => text(await exec(probeId, { cmd: "read_adc", channel })),
);

server.registerTool(
  "probe_sample",
  { description: "Log a digital pin over time (software sampling, kHz-class, not a scope). Returns samples [{t ms, v}].", inputSchema: { probeId: z.string(), pin: z.string(), durationMs: z.number(), rateHz: z.number() } },
  async ({ probeId, pin, durationMs, rateHz }) => text(await exec(probeId, { cmd: "sample_pin", pin, durationMs, rateHz })),
);

server.registerTool(
  "probe_i2c_scan",
  { description: "Scan the I2C bus and return detected 7-bit addresses.", inputSchema: { probeId: z.string() } },
  async ({ probeId }) => text(await exec(probeId, { cmd: "i2c_scan" })),
);

server.registerTool(
  "probe_identify",
  { description: "Make the probe identify itself (blink an LED / log) so the user can confirm which physical device it is.", inputSchema: { probeId: z.string() } },
  async ({ probeId }) => text(await exec(probeId, { cmd: "identify" })),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("loon-probe MCP server ready (LOON_URL=" + LOON_URL + ")");
