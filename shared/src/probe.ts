// #region Hardware probe protocol
// A "probe" is a physical device (a Raspberry Pi, later a Pico) wired to points
// on a real board. The probe agent dials OUT to the loon server over a
// WebSocket and registers what it can do. The server, the UI, and the AI then
// send it commands and read back signals, so Claude can debug a built board:
// it tells you where to connect each channel, then reads and drives those pins.
//
// Honest limits are encoded in the capabilities so the AI does not overreach:
//   - logicVoltage / fiveVoltTolerant: a Pi is 3.3V and NOT 5V tolerant.
//   - adc: a plain Pi has none; voltages need an ADS1115 / MCP3008. Each ADC
//     channel advertises bits, vref, and a realistic max sample rate.
//   - maxDigitalSampleHz: software sampling, kHz-class and jittery. Not a scope.

export type PinMode = "input" | "input_pullup" | "input_pulldown" | "output" | "pwm";

export interface GpioPin {
  id: string; // logical name, e.g. "GPIO17"
  physical?: number; // header pin number, for wiring instructions
  supports: PinMode[];
}

export interface AdcChannel {
  id: string; // e.g. "A0"
  device: string; // e.g. "ADS1115" | "MCP3008"
  bits: number;
  vref: number; // full-scale volts
  maxSampleHz: number;
}

export interface ProbeCapabilities {
  board: string; // "Raspberry Pi 4B", "mock", ...
  logicVoltage: number; // 3.3
  fiveVoltTolerant: boolean;
  gpio: GpioPin[];
  adc: AdcChannel[];
  i2c: boolean;
  spi: boolean;
  maxDigitalSampleHz: number;
  notes?: string;
}

export interface ProbeInfo {
  id: string;
  name: string;
  connectedAt: number;
  capabilities: ProbeCapabilities;
}

// #region commands and results
export type ProbeCommand =
  | { cmd: "identify" } // blink an LED / log, so the user finds the right probe
  | { cmd: "set_mode"; pin: string; mode: PinMode }
  | { cmd: "read_pin"; pin: string }
  | { cmd: "write_pin"; pin: string; value: 0 | 1 }
  | { cmd: "read_adc"; channel: string }
  | { cmd: "pwm"; pin: string; freq: number; duty: number } // duty 0..1
  | { cmd: "sample_pin"; pin: string; durationMs: number; rateHz: number }
  | { cmd: "i2c_scan" }
  | { cmd: "i2c_read"; addr: number; reg: number; length: number };

export interface ProbeResult {
  ok: boolean;
  value?: number; // digital read: 0/1
  volts?: number; // read_adc
  samples?: { t: number; v: number }[]; // sample_pin: t in ms from start
  addrs?: number[]; // i2c_scan: detected addresses
  bytes?: number[]; // i2c_read
  error?: string;
}

// #region wire messages
export type AgentToServer =
  | { type: "register"; token: string; name: string; capabilities: ProbeCapabilities }
  | { type: "result"; id: string; result: ProbeResult }
  | { type: "event"; level: "info" | "warn" | "error"; text: string };

export type ServerToAgent =
  | { type: "registered"; probeId: string }
  | { type: "command"; id: string; command: ProbeCommand }
  | { type: "error"; text: string };

// #region probe plan
// How probe channels map onto the schematic: Claude fills this in ("connect A0
// to net VCC at U1 pin 8") so the UI can show the wiring and results stay tied
// to the design.
export interface ProbeAssignment {
  channel: string; // a gpio pin id or adc channel id
  net?: string; // schematic net label
  ref?: string; // component reference
  pin?: string; // component pin
  note?: string;
  warnVoltage?: boolean; // set when the target may exceed the probe's logic level
}
