# /// script
# requires-python = ">=3.10"
# dependencies = ["websockets>=12", "pydwf>=1.1.19"]
# ///
"""
loon-probe agent for a Digilent Analog Discovery (2/3) over USB via the
WaveForms SDK (pydwf). This is the accurate/fast tier: the scope inputs are
real 14-bit differential ADCs that tolerate about +/-25V, so reading 5V (and
higher) nets is safe, unlike a 3.3V Pi GPIO. The 16 DIO pins are 3.3V logic.

  uv run digilent.py           # real Analog Discovery over USB (needs WaveForms)
  uv run digilent.py --mock    # simulated, for testing the link without hardware

Requires Digilent WaveForms installed (provides the dwf runtime pydwf binds to).
Env: same as loon_probe.py.

Field-testing against real AD3 hardware is still pending; the pydwf calls follow
the documented high-level API. Report back if a call needs adjusting.
"""
import argparse
import asyncio
import os
import socket
import time

from agent_common import run


class DigilentBackend:
    board = "digilent-analog-discovery"

    def __init__(self):
        from pydwf import DwfLibrary
        from pydwf.utilities import openDwfDevice
        self._dwf = DwfLibrary()
        self._dev = openDwfDevice(self._dwf)
        self._ain = self._dev.analogIn
        self._dio = self._dev.digitalIO
        self._scope_range = 50.0  # Vpp; wide + safe. Narrow later for precision.
        self._ain.reset()
        for ch in (0, 1):
            self._ain.channelEnableSet(ch, True)
            self._ain.channelRangeSet(ch, self._scope_range)
        self._dio.reset()

    def capabilities(self):
        gpio = [{"id": f"DIO{n}", "supports": ["input", "input_pullup", "output"]} for n in range(16)]
        adc = [
            {"id": "A0", "device": "AD Scope Ch1", "bits": 14, "vref": 25.0, "maxSampleHz": 1_000_000},
            {"id": "A1", "device": "AD Scope Ch2", "bits": 14, "vref": 25.0, "maxSampleHz": 1_000_000},
        ]
        return {
            "board": "Digilent Analog Discovery", "logicVoltage": 3.3, "fiveVoltTolerant": False,
            "gpio": gpio, "adc": adc, "i2c": False, "spi": False, "maxDigitalSampleHz": 100_000,
            "notes": "Scope inputs A0/A1 tolerate about +/-25V, so reading 5V nets is safe. DIO0-15 are 3.3V logic. read_adc returns a scope DC sample; streaming waveform capture is planned.",
        }

    # #region digital
    def _bit(self, pin):
        return int(pin.replace("DIO", ""))

    def set_mode(self, pin, mode):
        b = self._bit(pin)
        oe = self._dio.outputEnableGet()
        if mode == "output":
            oe |= (1 << b)
        else:
            oe &= ~(1 << b)
        self._dio.outputEnableSet(oe)
        return {"ok": True}

    def read_pin(self, pin):
        state = self._dio.inputStatus()
        return {"ok": True, "value": (state >> self._bit(pin)) & 1}

    def write_pin(self, pin, value):
        b = self._bit(pin)
        self._dio.outputEnableSet(self._dio.outputEnableGet() | (1 << b))
        out = self._dio.outputGet()
        out = (out | (1 << b)) if int(value) else (out & ~(1 << b))
        self._dio.outputSet(out)
        return {"ok": True}

    def sample_pin(self, pin, duration_ms, rate_hz):
        b = self._bit(pin)
        n = max(1, min(20000, int(duration_ms * rate_hz / 1000)))
        dt = 1.0 / rate_hz
        t0 = time.time()
        samples = []
        for i in range(n):
            samples.append({"t": round((time.time() - t0) * 1000, 3), "v": (self._dio.inputStatus() >> b) & 1})
            while time.time() - t0 < (i + 1) * dt:
                pass
        return {"ok": True, "samples": samples}

    # #region analog
    def read_adc(self, channel):
        ch = int(channel.replace("A", ""))
        self._ain.configure(False, False)
        self._ain.status(False)
        return {"ok": True, "volts": round(float(self._ain.statusSample(ch)), 4)}

    def pwm(self, pin, freq, duty):
        raise NotImplementedError("use the AD wavegen for PWM (planned)")

    def i2c_scan(self):
        raise NotImplementedError("I2C via the AD protocol analyzer is planned")

    def i2c_read(self, addr, reg, length):
        raise NotImplementedError("I2C via the AD protocol analyzer is planned")

    def identify(self):
        print("[probe] identify: Digilent Analog Discovery connected")
        return {"ok": True}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mock", action="store_true")
    ap.add_argument("--url", default=os.environ.get("LOON_PROBE_URL", "ws://localhost:8790/probe/ws"))
    ap.add_argument("--token", default=os.environ.get("LOON_PROBE_TOKEN", "loon-dev"))
    ap.add_argument("--name", default=os.environ.get("LOON_PROBE_NAME", "analog-discovery"))
    args = ap.parse_args()
    if args.mock:
        from loon_probe import MockBackend
        backend = MockBackend()
        backend.board = "digilent-mock"
    else:
        backend = DigilentBackend()
    try:
        asyncio.run(run(args.url, args.token, args.name, backend))
    except KeyboardInterrupt:
        print("\n[probe] bye")


if __name__ == "__main__":
    main()
