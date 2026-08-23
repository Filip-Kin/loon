"""Shared connection loop + command dispatch for CPython probe agents
(Pi/mock and Digilent). The ESP32 agent is standalone MicroPython and does not
use this. A backend is any object implementing the command methods; dispatch
routes a protocol command to it."""
import asyncio
import json

import websockets


def dispatch(backend, command):
    c = command.get("cmd")
    try:
        if c == "identify":
            return backend.identify()
        if c == "set_mode":
            return backend.set_mode(command["pin"], command["mode"])
        if c == "read_pin":
            return backend.read_pin(command["pin"])
        if c == "write_pin":
            return backend.write_pin(command["pin"], command["value"])
        if c == "read_adc":
            return backend.read_adc(command["channel"])
        if c == "pwm":
            return backend.pwm(command["pin"], command["freq"], command["duty"])
        if c == "sample_pin":
            return backend.sample_pin(command["pin"], command["durationMs"], command["rateHz"])
        if c == "i2c_scan":
            return backend.i2c_scan()
        if c == "i2c_read":
            return backend.i2c_read(command["addr"], command["reg"], command["length"])
        return {"ok": False, "error": f"unknown command {c}"}
    except NotImplementedError as e:
        return {"ok": False, "error": str(e) or "not supported by this probe"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


async def run(url, token, name, backend):
    caps = backend.capabilities()
    while True:
        try:
            async with websockets.connect(url, max_size=4_000_000) as ws:
                await ws.send(json.dumps({"type": "register", "token": token, "name": name, "capabilities": caps}))
                print(f"[probe] connected to {url} as '{name}' ({caps.get('board')})")
                async for raw in ws:
                    msg = json.loads(raw)
                    if msg.get("type") == "registered":
                        print(f"[probe] registered, id={msg['probeId']}")
                    elif msg.get("type") == "command":
                        result = dispatch(backend, msg["command"])
                        await ws.send(json.dumps({"type": "result", "id": msg["id"], "result": result}))
                    elif msg.get("type") == "error":
                        print(f"[probe] server error: {msg.get('text')}")
        except Exception as e:
            print(f"[probe] disconnected ({e}); retrying in 3s")
            await asyncio.sleep(3)
