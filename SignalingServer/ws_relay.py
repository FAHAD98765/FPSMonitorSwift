
"""
FPSMonitor Signaling + Web Viewer Server (Python)
==================================================

This server provides:

1. HTTP server
   - Serves WebViewer/index.html
   - Serves WebViewer/app.js
   - Browser URL:
       http://SERVER_IP:8765/view?session=fpsmonitor-session

2. WebSocket signaling
   - Producer registration
   - Multiple viewer registration
   - SDP offers / answers
   - ICE candidates
   - Per-viewer targetId
   - fromId sender tagging
   - producer-available
   - producer-left
   - viewer-joined
   - producer-fps

3. WebRTC media is NEVER handled by this server.
   Video/audio travels directly between Producer and Viewer.

Architecture:

    Producer iPhone
          |
          | WebSocket signaling
          v
      Python Server
          ^
          | WebSocket signaling
          |
     Browser Viewers

    Producer -------- WebRTC P2P -------- Viewer 1
    Producer -------- WebRTC P2P -------- Viewer 2
    Producer -------- WebRTC P2P -------- Viewer 3

Run:

    pip install -r requirements.txt
    python3 ws_relay.py
"""

import asyncio
import json
import os
import random
import socket
import string
from pathlib import Path

from aiohttp import web, WSMsgType


# ============================================================
# CONFIGURATION
# ============================================================

PORT = int(os.environ.get("PORT", "8765"))

BASE_DIR = Path(__file__).resolve().parent
WEB_ROOT = BASE_DIR.parent / "WebViewer"


# ============================================================
# SESSION MODEL
# ============================================================

class Session:
    def __init__(self):
        # One producer per session
        self.producer = None

        # Multiple viewers
        # viewer_id -> websocket
        self.viewers = {}


sessions = {}


def get_session(session_id):
    if session_id not in sessions:
        sessions[session_id] = Session()

    return sessions[session_id]


# ============================================================
# CLIENT ID
# ============================================================

def random_id(length=8):
    return "".join(
        random.choices(
            string.ascii_lowercase + string.digits,
            k=length
        )
    )


# ============================================================
# LOCAL IP DETECTION
# ============================================================

def local_ips():
    ips = []

    try:
        hostname = socket.gethostname()

        for info in socket.getaddrinfo(hostname, None):
            address = info[4][0]

            if ":" in address:
                continue

            if address.startswith("127."):
                continue

            if address not in ips:
                ips.append(address)

    except Exception:
        pass

    return ips


# ============================================================
# SAFE WEBSOCKET SEND
# ============================================================

async def safe_send(ws, payload):
    if ws is None:
        return

    if ws.closed:
        return

    try:
        await ws.send_json(payload)

    except Exception as error:
        print(f"[!] send error: {error}")


# ============================================================
# HTTP WEB VIEWER
# ============================================================

async def serve_web_file(request):
    """
    Serves files from ../WebViewer
    """

    requested_path = request.match_info.get("path", "")

    if requested_path == "":
        requested_path = "index.html"

    file_path = (WEB_ROOT / requested_path).resolve()

    # Security: prevent path traversal
    try:
        file_path.relative_to(WEB_ROOT.resolve())
    except ValueError:
        return web.Response(
            status=403,
            text="Forbidden"
        )

    if not file_path.exists() or not file_path.is_file():
        return web.Response(
            status=404,
            text="Web Viewer file not found"
        )

    content_types = {
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
    }

    content_type = content_types.get(
        file_path.suffix.lower(),
        "application/octet-stream"
    )

    try:
        data = file_path.read_bytes()

        return web.Response(
            body=data,
            content_type=content_type.split(";")[0],
            headers={
                "Cache-Control": "no-cache"
            }
        )

    except Exception as error:
        print(f"[!] HTTP file error: {error}")

        return web.Response(
            status=500,
            text="Internal server error"
        )


async def handle_root(request):
    return await serve_web_file(
        type(
            "Request",
            (),
            {
                "match_info": {
                    "path": "index.html"
                }
            }
        )()
    )


async def handle_view(request):
    return await serve_web_file(
        type(
            "Request",
            (),
            {
                "match_info": {
                    "path": "index.html"
                }
            }
        )()
    )


# ============================================================
# WEBSOCKET SIGNALING
# ============================================================

async def websocket_handler(request):

    ws = web.WebSocketResponse()
    await ws.prepare(request)

    client_id = random_id()

    role = None
    session_id = None

    print(f"[+] client connected: {client_id}")

    try:

        async for message in ws:

            # ------------------------------------------------
            # TEXT MESSAGE
            # ------------------------------------------------

            if message.type == WSMsgType.TEXT:

                try:
                    msg = json.loads(message.data)

                except json.JSONDecodeError:

                    print(
                        f"[!] invalid JSON from {client_id}"
                    )

                    continue

                msg_type = msg.get("type")

                # ------------------------------------------------
                # PING
                # ------------------------------------------------

                if msg_type == "ping":

                    await safe_send(
                        ws,
                        {
                            "type": "pong"
                        }
                    )

                    continue

                # ------------------------------------------------
                # SESSION ID
                # ------------------------------------------------

                sid = msg.get("sessionId")

                if not sid:

                    await safe_send(
                        ws,
                        {
                            "type": "error",
                            "message": "sessionId is required"
                        }
                    )

                    continue

                # ------------------------------------------------
                # REGISTER
                # ------------------------------------------------

                if msg_type == "register":

                    session_id = sid
                    role = msg.get("role")

                    session = get_session(session_id)

                    # ============================================
                    # PRODUCER
                    # ============================================

                    if role == "producer":

                        # If another producer exists,
                        # replace it.

                        if (
                            session.producer is not None
                            and session.producer is not ws
                        ):

                            print(
                                f'[i] replacing existing producer '
                                f'for session "{session_id}"'
                            )

                        session.producer = ws

                        print(
                            f'[i] {client_id} registered as '
                            f'PRODUCER for session "{session_id}"'
                        )

                        # Tell existing viewers that producer
                        # is now available.

                        for viewer_id, viewer_ws in list(
                            session.viewers.items()
                        ):

                            await safe_send(
                                viewer_ws,
                                {
                                    "type": "producer-available",
                                    "sessionId": session_id
                                }
                            )

                            # Tell producer about existing viewer.

                            await safe_send(
                                ws,
                                {
                                    "type": "viewer-joined",
                                    "sessionId": session_id,
                                    "viewerId": viewer_id
                                }
                            )

                    # ============================================
                    # VIEWER
                    # ============================================

                    elif role == "viewer":

                        session.viewers[client_id] = ws

                        print(
                            f'[i] {client_id} registered as '
                            f'VIEWER for session "{session_id}"'
                        )

                        # If producer already exists,
                        # notify both sides.

                        if session.producer is not None:

                            await safe_send(
                                ws,
                                {
                                    "type": "producer-available",
                                    "sessionId": session_id
                                }
                            )

                            await safe_send(
                                session.producer,
                                {
                                    "type": "viewer-joined",
                                    "sessionId": session_id,
                                    "viewerId": client_id
                                }
                            )

                    # ------------------------------------------------
                    # REGISTERED RESPONSE
                    # ------------------------------------------------

                    await safe_send(
                        ws,
                        {
                            "type": "registered",
                            "sessionId": session_id,
                            "role": role,
                            "clientId": client_id
                        }
                    )

                    continue

                # ------------------------------------------------
                # PRODUCER FPS
                # ------------------------------------------------

                if msg_type == "producer-fps":

                    session = get_session(session_id)

                    fps = msg.get("fps")

                    if session.producer is ws:

                        # Send FPS to all viewers.

                        for viewer_ws in list(
                            session.viewers.values()
                        ):

                            await safe_send(
                                viewer_ws,
                                {
                                    "type": "producer-fps",
                                    "sessionId": session_id,
                                    "fps": fps
                                }
                            )

                    continue

                # ------------------------------------------------
                # OFFER / ANSWER / ICE
                # ------------------------------------------------

                if msg_type in (
                    "offer",
                    "answer",
                    "ice-candidate"
                ):

                    session = get_session(session_id)

                    target_id = msg.get("targetId")

                    outgoing = {
                        **msg,
                        "fromId": client_id
                    }

                    # ============================================
                    # PRODUCER -> VIEWER
                    # ============================================

                    if role == "producer":

                        if target_id:

                            target_ws = session.viewers.get(
                                target_id
                            )

                            await safe_send(
                                target_ws,
                                outgoing
                            )

                        else:

                            # Optional broadcast

                            for viewer_ws in list(
                                session.viewers.values()
                            ):

                                await safe_send(
                                    viewer_ws,
                                    outgoing
                                )

                    # ============================================
                    # VIEWER -> PRODUCER
                    # ============================================

                    elif role == "viewer":

                        await safe_send(
                            session.producer,
                            outgoing
                        )

                    continue

                # ------------------------------------------------
                # UNKNOWN MESSAGE
                # ------------------------------------------------

                print(
                    f'[!] unknown message type '
                    f'"{msg_type}" from {client_id}'
                )

            # ------------------------------------------------
            # CLOSE
            # ------------------------------------------------

            elif message.type == WSMsgType.ERROR:

                print(
                    f"[!] websocket error "
                    f"on {client_id}: {ws.exception()}"
                )

    except Exception as error:

        print(
            f"[!] socket error on {client_id}: {error}"
        )

    finally:

        print(
            f"[-] client disconnected: {client_id} "
            f"(role={role})"
        )

        # ------------------------------------------------
        # CLEANUP
        # ------------------------------------------------

        if session_id:

            session = get_session(session_id)

            # ============================================
            # PRODUCER DISCONNECTED
            # ============================================

            if (
                role == "producer"
                and session.producer is ws
            ):

                session.producer = None

                # Tell every viewer.

                for viewer_ws in list(
                    session.viewers.values()
                ):

                    await safe_send(
                        viewer_ws,
                        {
                            "type": "producer-left",
                            "sessionId": session_id
                        }
                    )

            # ============================================
            # VIEWER DISCONNECTED
            # ============================================

            elif role == "viewer":

                session.viewers.pop(
                    client_id,
                    None
                )

            # ============================================
            # DELETE EMPTY SESSION
            # ============================================

            if (
                session.producer is None
                and not session.viewers
            ):

                sessions.pop(
                    session_id,
                    None
                )

    return ws


# ============================================================
# APPLICATION
# ============================================================

def create_app():

    app = web.Application()

    # Web Viewer
    app.router.add_get("/", handle_root)
    app.router.add_get("/view", handle_view)

    # Static files
    app.router.add_get(
        "/{path:.*}",
        serve_web_file
    )

    # WebSocket
    app.router.add_get(
        "/ws",
        websocket_handler
    )

    return app


# ============================================================
# START SERVER
# ============================================================

def main():

    print("=" * 60)
    print("FPSMonitor Python Server")
    print("=" * 60)

    print(
        f"HTTP/Web Viewer : http://localhost:{PORT}"
    )

    print(
        f"WebSocket       : ws://localhost:{PORT}/ws"
    )

    print()

    print("Reachable on LAN:")

    ips = local_ips()

    if not ips:

        print(
            "  Could not automatically detect LAN IP."
        )

    for ip in ips:

        print(
            f"  Web Viewer : "
            f"http://{ip}:{PORT}/view"
        )

        print(
            f"  WebSocket  : "
            f"ws://{ip}:{PORT}/ws"
        )

    print()

    print(
        f"WebViewer root: {WEB_ROOT}"
    )

    print("=" * 60)

    web.run_app(
        create_app(),
        host="0.0.0.0",
        port=PORT
    )


if __name__ == "__main__":
    main()

