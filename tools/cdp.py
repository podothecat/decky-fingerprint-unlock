#!/usr/bin/env python3
"""Minimal Chrome DevTools Protocol client for Steam's SharedJSContext.

Stdlib only -- no pip installs. Steam runs its UI in CEF with
--remote-debugging-port=8080, so this gives us a REPL into the same JS context
that Decky plugins live in. Used here to find out whether the gaming-mode lock
screen can be observed and dismissed programmatically.

Usage:
    ./cdp.py 'Object.keys(SteamClient)'
    echo 'SteamClient.User' | ./cdp.py
    ./cdp.py --target-list
"""
import base64
import json
import os
import socket
import struct
import sys
import urllib.request

HOST, PORT = "127.0.0.1", 8080
TARGET_TITLE = os.environ.get("CDP_TARGET", "SharedJSContext")
# Raise this for probes that await something slow, e.g. a fingerprint verify loop:
#     CDP_TIMEOUT=120 ./cdp.py '...'
TIMEOUT = float(os.environ.get("CDP_TIMEOUT", "15"))


def http_targets():
    with urllib.request.urlopen(f"http://{HOST}:{PORT}/json/list", timeout=5) as r:
        return json.load(r)


def find_ws_url(title):
    for t in http_targets():
        if t.get("title") == title and t.get("webSocketDebuggerUrl"):
            return t["webSocketDebuggerUrl"]
    raise SystemExit(f"!! no CDP target titled {title!r}")


class WS:
    """Just enough RFC6455 to talk to a local CEF instance."""

    def __init__(self, url):
        path = url.split(f"{HOST}:{PORT}", 1)[1]
        self.sock = socket.create_connection((HOST, PORT), timeout=TIMEOUT)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(
            f"GET {path} HTTP/1.1\r\nHost: {HOST}:{PORT}\r\n"
            f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode()
        )
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise SystemExit("!! handshake closed early")
            buf += chunk
        if b"101" not in buf.split(b"\r\n", 1)[0]:
            raise SystemExit(f"!! upgrade refused: {buf.split(chr(13).encode())[0]!r}")
        self.rest = buf.split(b"\r\n\r\n", 1)[1]

    def send(self, obj):
        payload = json.dumps(obj).encode()
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            hdr = struct.pack("!BB", 0x81, 0x80 | n)
        elif n < 1 << 16:
            hdr = struct.pack("!BBH", 0x81, 0x80 | 126, n)
        else:
            hdr = struct.pack("!BBQ", 0x81, 0x80 | 127, n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(hdr + mask + masked)

    def _read(self, n):
        while len(self.rest) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise SystemExit("!! connection closed")
            self.rest += chunk
        out, self.rest = self.rest[:n], self.rest[n:]
        return out

    def recv(self):
        while True:
            b0, b1 = self._read(2)
            opcode, ln = b0 & 0x0F, b1 & 0x7F
            if ln == 126:
                ln = struct.unpack("!H", self._read(2))[0]
            elif ln == 127:
                ln = struct.unpack("!Q", self._read(8))[0]
            data = self._read(ln)
            if opcode == 0x8:
                raise SystemExit("!! server closed connection")
            if opcode == 0x9:  # ping -> ignore, CEF does not need our pong here
                continue
            if opcode in (0x1, 0x2):
                return json.loads(data)


def evaluate(expr):
    ws = WS(find_ws_url(TARGET_TITLE))
    ws.send({
        "id": 1,
        "method": "Runtime.evaluate",
        "params": {
            "expression": expr,
            "awaitPromise": True,
            "returnByValue": True,
            "allowUnsafeEvalBlockedByCSP": True,
        },
    })
    while True:
        msg = ws.recv()
        if msg.get("id") == 1:
            return msg


def main():
    if "--target-list" in sys.argv:
        for t in http_targets():
            print(f"{t.get('type'):8} {t.get('title')}")
        return
    expr = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else sys.stdin.read()
    if not expr.strip():
        raise SystemExit("!! nothing to evaluate")
    msg = evaluate(expr)
    if "error" in msg:
        print("PROTOCOL ERROR:", json.dumps(msg["error"], indent=2))
        raise SystemExit(1)
    res = msg.get("result", {})
    if res.get("exceptionDetails"):
        print("JS EXCEPTION:", json.dumps(res["exceptionDetails"], indent=2)[:2000])
        raise SystemExit(1)
    val = res.get("result", {})
    print(json.dumps(val.get("value", val), indent=2, ensure_ascii=False)[:8000])


if __name__ == "__main__":
    main()
