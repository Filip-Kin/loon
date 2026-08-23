# /// script
# requires-python = ">=3.10"
# dependencies = ["websockets>=12"]
# ///
"""
loon-probe: agent for a Linux single-board computer (Raspberry Pi, etc.) wired
to a real board. Dials OUT to the loon server over WebSocket, registers what it
can do, and executes read/write commands so Claude can debug the board.

  uv run loon_probe.py            # real hardware (gpiozero + optional ADS1115)
  uv run loon_probe.py --mock     # simulated pins, no hardware

Env: LOON_PROBE_URL (default ws://localhost:8790/probe/ws),
     LOON_PROBE_TOKEN (default loon-dev), LOON_PROBE_NAME (default hostname).

A Pi is 3.3V logic, NOT 5V tolerant, and has no analog input; voltages need an
ADS1115 (I2C) or MCP3008 (SPI). For accurate/fast analog use the Digilent agent
(digilent.py) instead. This agent is not an oscilloscope.
"""
import argparse
import asyncio
import math
import os
import random
import socket
import time

from agent_common import run


class MockBackend:
    board = "mock"

    def __init__(self):
        self.modes = {}
        self.outputs = {}
        self.t0 = time.time()

    def capabilities(self):
        gpio = [
            {"id": f"GPIO{n}", "physical": phys, "supports": ["input", "input_pullup", "input_pulldown", "output", "pwm"]}
            for n, phys in [(17, 11), (18, 12), (22, 15), (23, 16), (24, 18), (25, 22), (27, 13)]
        ]
        adc = [{"id": f"A{i}", "device": "ADS1115 (simulated)", "bits": 16, "vref": 4.096, "maxSampleHz": 860} for i in range(4)]
        return {
            "board": "mock", "logicVoltage": 3.3, "fiveVoltTolerant": False,
            "gpio": gpio, "adc": adc, "i2c": True, "spi": False, "maxDigitalSampleHz": 2000,
            "notes": "Simulated probe. Inputs return a 1 Hz square wave; ADC returns a slow sine around mid-scale.",
        }

    def set_mode(self, pin, mode):
        self.modes[pin] = mode
        return {"ok": True}

    def read_pin(self, pin):
        if self.modes.get(pin) == "output":
            return {"ok": True, "value": self.outputs.get(pin, 0)}
        return {"ok": True, "value": 1 if int((time.time() - self.t0) * 2) % 2 == 0 else 0}

    def write_pin(self, pin, value):
        self.outputs[pin] = int(value)
        return {"ok": True}

    def read_adc(self, channel):
        t = time.time() - self.t0
        return {"ok": True, "volts": round(1.65 + 1.2 * math.sin(t * 0.7) + random.uniform(-0.01, 0.01), 4)}

    def pwm(self, pin, freq, duty):
        self.outputs[pin] = duty
        return {"ok": True}

    def sample_pin(self, pin, duration_ms, rate_hz):
        n = max(1, min(5000, int(duration_ms * rate_hz / 1000)))
        dt = 1000.0 / rate_hz
        base = time.time() - self.t0
        return {"ok": True, "samples": [{"t": round(i * dt, 3), "v": 1 if int((base + i * dt / 1000) * 2) % 2 == 0 else 0} for i in range(n)]}

    def i2c_scan(self):
        return {"ok": True, "addrs": [0x48, 0x76]}

    def i2c_read(self, addr, reg, length):
        return {"ok": True, "bytes": [(reg + i) & 0xFF for i in range(length)]}

    def identify(self):
        print("[probe] identify: (mock) would blink an LED here")
        return {"ok": True}


class PiBackend(MockBackend):
    """Real Raspberry Pi. Falls back to mock behaviour per feature that is absent."""
    board = "raspberry-pi"

    def __init__(self):
        super().__init__()
        self._gpio = {}
        self._ads = None
        try:
            import gpiozero  # noqa: F401
            self._have_gpio = True
        except Exception:
            self._have_gpio = False
        try:
            import board as _b
            import busio
            import adafruit_ads1x15.ads1115 as ADS
            from adafruit_ads1x15.analog_in import AnalogIn
            self._ads = ADS.ADS1115(busio.I2C(_b.SCL, _b.SDA))
            self._AnalogIn = AnalogIn
            self._ADS = ADS
        except Exception:
            self._ads = None

    def capabilities(self):
        caps = super().capabilities()
        caps["board"] = f"Raspberry Pi ({socket.gethostname()})"
        if self._ads is None:
            caps["adc"] = []
            caps["notes"] = "No ADS1115 detected: digital only. Add an ADS1115 on I2C for voltage reads."
        else:
            for a in caps["adc"]:
                a["device"] = "ADS1115"
        return caps

    def _pin(self, pin, out=False):
        import gpiozero
        n = int(pin.replace("GPIO", ""))
        key = (n, out)
        if key not in self._gpio:
            self._gpio[key] = gpiozero.OutputDevice(n) if out else gpiozero.DigitalInputDevice(n)
        return self._gpio[key]

    def read_pin(self, pin):
        if not self._have_gpio:
            return super().read_pin(pin)
        return {"ok": True, "value": int(self._pin(pin, out=False).value)}

    def write_pin(self, pin, value):
        if not self._have_gpio:
            return super().write_pin(pin, value)
        dev = self._pin(pin, out=True)
        dev.on() if int(value) else dev.off()
        return {"ok": True}

    def read_adc(self, channel):
        if self._ads is None:
            return {"ok": False, "error": "no ADC attached (need ADS1115/MCP3008)"}
        idx = int(channel.replace("A", ""))
        ch = self._AnalogIn(self._ads, getattr(self._ADS, f"P{idx}"))
        return {"ok": True, "volts": round(ch.voltage, 4)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mock", action="store_true")
    ap.add_argument("--url", default=os.environ.get("LOON_PROBE_URL", "ws://localhost:8790/probe/ws"))
    ap.add_argument("--token", default=os.environ.get("LOON_PROBE_TOKEN", "loon-dev"))
    ap.add_argument("--name", default=os.environ.get("LOON_PROBE_NAME", socket.gethostname()))
    args = ap.parse_args()
    backend = MockBackend() if args.mock else PiBackend()
    try:
        asyncio.run(run(args.url, args.token, args.name, backend))
    except KeyboardInterrupt:
        print("\n[probe] bye")


if __name__ == "__main__":
    main()
