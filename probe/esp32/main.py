# loon-probe agent for ESP32 / ESP32-S3 (MicroPython).
#
# Flash MicroPython to the board, edit the CONFIG block below (Wi-Fi + server),
# copy this file as main.py with mpremote/Thonny, and reset. It connects to the
# loon server over WebSocket and exposes GPIO, ADC, and I2C.
#
# ESP32 is 3.3V logic and NOT 5V tolerant. Its ADC is 12-bit but noisy and
# nonlinear near the rails, so treat voltages as approximate; use the Digilent
# agent for accurate analog. Pin maps below are for ESP32-S3; adjust for classic
# ESP32 (ADC1 is GPIO32-39 there).

import network
import socket
import time
import json
import os
import binascii
from machine import Pin, ADC, SoftI2C

CONFIG = {
    "wifi_ssid": "YOUR_WIFI",
    "wifi_password": "YOUR_PASS",
    "url": "ws://192.168.1.2:8790/probe/ws",  # loon server
    "token": "loon-dev",
    "name": "esp32-probe",
    "gpio_pins": [4, 5, 6, 7, 15, 16, 17, 18],   # usable digital IO (S3)
    "adc_pins": {"A0": 1, "A1": 2, "A2": 3, "A3": 4},  # ADC1 channels (S3: GPIO1-10)
    "i2c_scl": 9,
    "i2c_sda": 8,
    "led_pin": 48,  # onboard RGB/led for identify (S3 devkit); set None if absent
}

# #region hardware
_pins = {}
_adcs = {}


def _gpio(n, mode):
    if mode == "output":
        p = Pin(n, Pin.OUT)
    elif mode == "input_pullup":
        p = Pin(n, Pin.IN, Pin.PULL_UP)
    elif mode == "input_pulldown":
        p = Pin(n, Pin.IN, Pin.PULL_DOWN)
    else:
        p = Pin(n, Pin.IN)
    _pins[n] = p
    return p


def capabilities():
    gpio = [{"id": "GPIO%d" % n, "supports": ["input", "input_pullup", "input_pulldown", "output"]} for n in CONFIG["gpio_pins"]]
    adc = [{"id": k, "device": "ESP32 ADC1", "bits": 12, "vref": 3.3, "maxSampleHz": 10000} for k in CONFIG["adc_pins"]]
    return {
        "board": "esp32", "logicVoltage": 3.3, "fiveVoltTolerant": False,
        "gpio": gpio, "adc": adc, "i2c": True, "spi": False, "maxDigitalSampleHz": 20000,
        "notes": "ESP32 ADC is approximate (nonlinear near rails). NOT 5V tolerant.",
    }


def dispatch(cmd):
    c = cmd.get("cmd")
    try:
        if c == "identify":
            if CONFIG["led_pin"] is not None:
                led = Pin(CONFIG["led_pin"], Pin.OUT)
                for _ in range(6):
                    led.value(not led.value())
                    time.sleep(0.1)
            return {"ok": True}
        if c == "set_mode":
            n = int(cmd["pin"].replace("GPIO", ""))
            _gpio(n, cmd["mode"])
            return {"ok": True}
        if c == "read_pin":
            n = int(cmd["pin"].replace("GPIO", ""))
            p = _pins.get(n) or _gpio(n, "input")
            return {"ok": True, "value": p.value()}
        if c == "write_pin":
            n = int(cmd["pin"].replace("GPIO", ""))
            p = _gpio(n, "output")  # ensure the pin is an output
            p.value(int(cmd["value"]))
            return {"ok": True}
        if c == "read_adc":
            gp = CONFIG["adc_pins"].get(cmd["channel"])
            if gp is None:
                return {"ok": False, "error": "unknown channel"}
            if gp not in _adcs:
                a = ADC(Pin(gp))
                try:
                    a.atten(ADC.ATTN_11DB)  # ~0-3.3V range
                except Exception:
                    pass
                _adcs[gp] = a
            raw = _adcs[gp].read_u16()
            return {"ok": True, "volts": round(raw / 65535 * 3.3, 4)}
        if c == "sample_pin":
            n = int(cmd["pin"].replace("GPIO", ""))
            p = _pins.get(n) or _gpio(n, "input")
            rate = cmd["rateHz"]
            count = max(1, min(20000, int(cmd["durationMs"] * rate // 1000)))
            dt = 1.0 / rate
            t0 = time.ticks_ms()
            out = []
            for i in range(count):
                out.append({"t": time.ticks_diff(time.ticks_ms(), t0), "v": p.value()})
                target = i * dt * 1000
                while time.ticks_diff(time.ticks_ms(), t0) < target:
                    pass
            return {"ok": True, "samples": out}
        if c == "i2c_scan":
            i2c = SoftI2C(scl=Pin(CONFIG["i2c_scl"]), sda=Pin(CONFIG["i2c_sda"]))
            return {"ok": True, "addrs": i2c.scan()}
        return {"ok": False, "error": "unknown command %s" % c}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# #region wifi
def wifi_connect():
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    if not wlan.isconnected():
        wlan.connect(CONFIG["wifi_ssid"], CONFIG["wifi_password"])
        for _ in range(40):
            if wlan.isconnected():
                break
            time.sleep(0.5)
    if not wlan.isconnected():
        raise OSError("wifi connect failed")
    print("[probe] wifi", wlan.ifconfig()[0])


# #region minimal websocket client (RFC6455)
def _recv_exact(s, n):
    buf = b""
    while len(buf) < n:
        chunk = s.recv(n - len(buf))
        if not chunk:
            raise OSError("socket closed")
        buf += chunk
    return buf


def ws_connect(url):
    assert url.startswith("ws://")
    rest = url[5:]
    hostport, _, path = rest.partition("/")
    path = "/" + path
    host, _, port = hostport.partition(":")
    port = int(port or 80)
    addr = socket.getaddrinfo(host, port)[0][-1]
    s = socket.socket()
    s.connect(addr)
    key = binascii.b2a_base64(os.urandom(16)).strip().decode()
    req = (
        "GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\n"
        "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n"
        % (path, host, port, key)
    )
    s.send(req.encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        resp += s.recv(64)
    if b"101" not in resp.split(b"\r\n")[0]:
        raise OSError("ws handshake failed: %s" % resp[:64])
    return s


def ws_send_text(s, text):
    payload = text.encode()
    ln = len(payload)
    frame = bytearray([0x81])  # FIN + text
    if ln < 126:
        frame.append(0x80 | ln)
    elif ln < 65536:
        frame.append(0x80 | 126)
        frame += ln.to_bytes(2, "big")
    else:
        frame.append(0x80 | 127)
        frame += ln.to_bytes(8, "big")
    mask = os.urandom(4)
    frame += mask
    frame += bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    s.send(frame)


def ws_recv(s):
    # returns (opcode, bytes) for one frame; assumes server frames are unmasked
    h = _recv_exact(s, 2)
    opcode = h[0] & 0x0F
    masked = h[1] & 0x80
    ln = h[1] & 0x7F
    if ln == 126:
        ln = int.from_bytes(_recv_exact(s, 2), "big")
    elif ln == 127:
        ln = int.from_bytes(_recv_exact(s, 8), "big")
    mask = _recv_exact(s, 4) if masked else None
    data = _recv_exact(s, ln) if ln else b""
    if mask:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return opcode, data


def run():
    while True:
        try:
            wifi_connect()
            s = ws_connect(CONFIG["url"])
            ws_send_text(s, json.dumps({"type": "register", "token": CONFIG["token"], "name": CONFIG["name"], "capabilities": capabilities()}))
            print("[probe] connected")
            while True:
                opcode, data = ws_recv(s)
                if opcode == 0x8:  # close
                    break
                if opcode == 0x9:  # ping -> pong
                    s.send(bytes([0x8A, 0x80]) + os.urandom(4))
                    continue
                if opcode != 0x1:
                    continue
                msg = json.loads(data)
                if msg.get("type") == "command":
                    result = dispatch(msg["command"])
                    ws_send_text(s, json.dumps({"type": "result", "id": msg["id"], "result": result}))
                elif msg.get("type") == "registered":
                    print("[probe] registered", msg.get("probeId"))
        except Exception as e:
            print("[probe] error:", e, "- retry 3s")
            time.sleep(3)


run()
