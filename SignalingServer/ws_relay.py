"""
FPSMonitor Signaling Relay (Python)
====================================
Pure signaling relay for WebRTC pairing between a "producer" (camera
broadcaster) and one or more "viewers" on the SAME local WiFi network.

This mirrors SignalingServer/server.js message-for-message, so the iOS
app works identically no matter which relay you run — Node or Python.
It never touches media (video/audio); it only relays:
  - registration (session + role)
  - SDP offers/answers
  - ICE candidates
  - per-viewer targeting (targetId) + sender tagging (fromId)
  - producer-available / producer-left / viewer-joined events

Run:
    pip install -r requirements.txt
    python3 ws_relay.py

The server prints the LAN IP + port to use in the iOS app / QR code.
"""

import asyncio
import json
import random
import socket
import string
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

PORT = 8765


def random_id(n: int = 8) -> str:
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def local_ips() -> list[str]:
    ips: list[str] = []
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None):
            addr = info[4][0]
            if ":" not in addr and not addr.startswith("127."):
                if addr not in ips:
                    ips.append(addr)
    except Exception:
        pass
    return ips


class Session:
    def __init__(self) -> None:
        self.producer = None            # websocket | None
        self.viewers: dict[str, object] = {}  # viewer_id -> websocket


sessions: dict[str, Session] = {}


def get_session(session_id: str) -> Session:
    if session_id not in sessions:
        sessions[session_id] = Session()
    return sessions[session_id]


async def safe_send(ws, obj: dict) -> None:
    if ws is None:
        return
    try:
        await ws.send(json.dumps(obj))
    except ConnectionClosed:
        pass


async def handler(websocket):
    client_id = random_id()
    role = None
    session_id = None

    print(f"[+] client connected: {client_id}")

    try:
        async for raw in websocket:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                print(f"[!] invalid JSON from {client_id}")
                continue

            msg_type = msg.get("type")

            if msg_type == "ping":
                await safe_send(websocket, {"type": "pong"})
                continue

            sid = msg.get("sessionId")
            if not sid:
                await safe_send(websocket, {"type": "error", "message": "sessionId is required"})
                continue

            if msg_type == "register":
                session_id = sid
                role = msg.get("role")
                session = get_session(session_id)

                if role == "producer":
                    session.producer = websocket
                    print(f'[i] {client_id} registered as PRODUCER for session "{session_id}"')
                    # Let existing viewers know a producer is available, and let
                    # the producer know about viewers that were already waiting.
                    for viewer_id, viewer_ws in session.viewers.items():
                        await safe_send(viewer_ws, {"type": "producer-available", "sessionId": session_id})
                        await safe_send(websocket, {"type": "viewer-joined", "sessionId": session_id, "viewerId": viewer_id})

                elif role == "viewer":
                    session.viewers[client_id] = websocket
                    print(f'[i] {client_id} registered as VIEWER for session "{session_id}"')
                    if session.producer is not None:
                        await safe_send(websocket, {"type": "producer-available", "sessionId": session_id})
                        await safe_send(session.producer, {"type": "viewer-joined", "sessionId": session_id, "viewerId": client_id})

                await safe_send(websocket, {"type": "registered", "sessionId": session_id, "role": role, "clientId": client_id})

            elif msg_type in ("offer", "answer", "ice-candidate"):
                if not session_id:
                    continue
                session = get_session(session_id)
                target_id = msg.get("targetId")
                out = {**msg, "fromId": client_id}

                if role == "producer":
                    if target_id:
                        target_ws = session.viewers.get(target_id)
                        await safe_send(target_ws, out)
                    else:
                        for viewer_ws in session.viewers.values():
                            await safe_send(viewer_ws, out)
                elif role == "viewer":
                    await safe_send(session.producer, out)

            else:
                print(f'[!] unknown message type "{msg_type}" from {client_id}')

    except ConnectionClosed:
        pass
    except Exception as e:
        print(f"[!] socket error on {client_id}: {e}")
    finally:
        print(f"[-] client disconnected: {client_id} (role={role})")
        if session_id:
            session = get_session(session_id)
            if role == "producer" and session.producer == websocket:
                session.producer = None
                for viewer_ws in session.viewers.values():
                    await safe_send(viewer_ws, {"type": "producer-left", "sessionId": session_id})
            elif role == "viewer":
                session.viewers.pop(client_id, None)

            if session.producer is None and not session.viewers:
                sessions.pop(session_id, None)


async def main():
    print("=" * 60)
    print("FPSMonitor Signaling Relay (Python)")
    print("=" * 60)
    print(f"Listening on port {PORT}")
    print("Reachable at (use one of these on BOTH phones):")
    for ip in local_ips():
        print(f"  ws://{ip}:{PORT}")
    print("=" * 60)

    async with serve(handler, "0.0.0.0", PORT):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
