# loon-probe

A hardware probe lets Claude debug a board you actually built. You wire a small
network-connected device to points on the board, Claude tells you where to
connect each channel, then it reads and drives those pins over the internet
while reasoning about your schematic.

The probe agent dials OUT to the loon server over a WebSocket, so the device
only needs internet, no port forwarding. All agents speak the same protocol
(`shared/src/probe.ts`), so the server, the UI, and Claude do not care which
device you use.

## Which device

| Device | Analog (voltages) | Digital | Notes |
|---|---|---|---|
| **ESP32-S3** | 12-bit ADC, approximate (noisy near rails) | lots of GPIO, I2C/SPI | Wi-Fi + BLE, ~$8, runs the MicroPython agent. Good everyday probe. Not 5V tolerant. |
| **Raspberry Pi + ADS1115** | 16-bit via the ADS1115, accurate | GPIO, I2C/SPI | Full Linux, runs the Python agent as-is. Add a level shifter for 5V nets. |
| **Digilent Analog Discovery 2/3** | real 14-bit scope, +/-25V, high sample rate | 16 DIO (3.3V) | The accurate/fast tier (~$300). Scope inputs safely read 5V+ nets. Runs the Digilent agent on a host over USB. |
| Pico 2 W (RP2350) | cleaner 12-bit ADC, ~500 kSps | PIO for custom capture | MCU, not covered by an agent yet. |

Rule of thumb: ESP32-S3 for everyday digital and rough analog; the Analog
Discovery when you need accurate voltages or to see a waveform.

## Safety

- A Pi and an ESP32 are **3.3V logic and not 5V tolerant**. Connecting a GPIO to
  a 5V net can damage the board. Use a divider or level shifter, or use the
  Analog Discovery scope inputs (which tolerate about +/-25V).
- Never drive (write) a pin that the board itself is already driving.
- These are not oscilloscopes except the Analog Discovery. Software sampling on a
  Pi/ESP32 is kHz-class and jittery, fine for logic timing and slow logging.

## Running an agent

```bash
# Linux SBC (Raspberry Pi). Real hardware needs gpiozero + optional ADS1115.
uv run loon_probe.py

# Anywhere, simulated pins (no hardware) to try the flow:
uv run loon_probe.py --mock

# Digilent Analog Discovery over USB (needs Digilent WaveForms installed):
uv run digilent.py
```

Environment: `LOON_PROBE_URL` (default `ws://localhost:8790/probe/ws`, use the
server's LAN/tailnet address from the Pi), `LOON_PROBE_TOKEN` (default
`loon-dev`, set `LOON_PROBE_TOKEN` on both the server and the agent for a real
deployment), `LOON_PROBE_NAME`.

### ESP32 (MicroPython)

Flash MicroPython, edit the `CONFIG` block in `esp32/main.py` (Wi-Fi + server
URL + token), copy it to the board as `main.py`, and reset:

```bash
mpremote connect /dev/ttyACM0 fs cp esp32/main.py :main.py
mpremote connect /dev/ttyACM0 reset
```

## Letting Claude drive the probe (MCP)

The `mcp/` server exposes the probe to any Claude as tools (`probe_list`,
`probe_read_pin`, `probe_write_pin`, `probe_read_voltage`, `probe_sample`,
`probe_i2c_scan`, `probe_identify`). Register it in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "loon-probe": {
      "command": "bun",
      "args": ["run", "/media/nas/filip/ncdata/filip/files/Projects/loon/mcp/server.ts"],
      "env": { "LOON_URL": "http://localhost:8790/trpc" }
    }
  }
}
```

Then in a Claude session: "list my probes, then read the voltage on A0" and it
will call the tools. It sees each probe's limits (logic voltage, 5V tolerance)
in `probe_list`, so it warns before touching pins it should not.
```
