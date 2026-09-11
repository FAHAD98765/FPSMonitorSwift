"""
FPSMonitor Complete Server (Python)
Fixed WebSocket + WebViewer Server
"""

import asyncio
import json
import os
import random
import socket
import string

from aiohttp import web


# ============================================================
# CONFIGURATION
# ============================================================

PORT = 8765

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

WEB_ROOT = os.path.abspath(
    os.path.join(BASE_DIR, "..", "WebViewer")
)


# ============================================================
# HELPERS
# ============================================================

def random_id(n: int = 8) -> str:
    return "".join(
        random.choices(
            string.ascii_lowercase + string.digits,
            k=n
        )
    )


def local_ips() -> list[str]:

    ips: list[str] = []

    try:

        hostname = socket.gethostname()

        for info in socket.getaddrinfo(
            hostname,
            None
        ):

            addr = info[4][0]

            if (
                ":" not in addr
                and not addr.startswith("127.")
            ):

                if addr not in ips:
                    ips.append(addr)

    except Exception:
        pass

    return ips


# ============================================================
# SESSION
# ============================================================

class Session:

    def __init__(self) -> None:

        self.producer = None

        self.viewers: dict[str, object] = {}


sessions: dict[str, Session] = {}


def get_session(session_id: str) -> Session:

    if session_id not in sessions:

        sessions[session_id] = Session()

    return sessions[session_id]


# ============================================================
# WEBSOCKET SEND
# ============================================================

async def safe_send(
    ws,
    obj: dict
) -> None:

    if ws is None:
        return

    try:

        await ws.send_json(obj)

    except Exception as e:

        print(
            f"[!] WebSocket send failed: {e}"
        )


# ============================================================
# WEBSOCKET HANDLER
# ============================================================

async def websocket_handler(websocket):

    client_id = random_id()

    role = None

    session_id = None

    print(
        f"[+] client connected: {client_id}"
    )

    try:

        async for msg in websocket:

            # =================================================
            # TEXT MESSAGE
            # =================================================

            if msg.type == web.WSMsgType.TEXT:

                raw = msg.data

                try:

                    data = json.loads(raw)

                except Exception:

                    print(
                        f"[!] Invalid JSON from {client_id}"
                    )

                    continue


                msg_type = data.get("type")


                print(
                    f"[WS] {client_id} -> {msg_type}"
                )


                # =================================================
                # PING
                # =================================================

                if msg_type == "ping":

                    await safe_send(
                        websocket,
                        {
                            "type": "pong"
                        }
                    )

                    continue


                # =================================================
                # SESSION ID
                # =================================================

                sid = data.get("sessionId")

                if not sid:

                    print(
                        f"[!] {client_id}: Missing session ID"
                    )

                    continue


                # =================================================
                # REGISTER
                # =================================================

                if msg_type == "register":

                    session_id = sid

                    role = data.get("role")

                    session = get_session(
                        session_id
                    )


                    # =================================================
                    # PRODUCER
                    # =================================================

                    if role == "producer":

                        session.producer = websocket

                        print(
                            f'[i] {client_id} PRODUCER '
                            f'for "{session_id}"'
                        )


                        # Notify existing viewers

                        for (
                            viewer_id,
                            viewer_ws
                        ) in session.viewers.items():

                            await safe_send(
                                viewer_ws,
                                {
                                    "type":
                                        "producer-available",

                                    "sessionId":
                                        session_id
                                }
                            )


                            await safe_send(
                                websocket,
                                {
                                    "type":
                                        "viewer-joined",

                                    "sessionId":
                                        session_id,

                                    "viewerId":
                                        viewer_id
                                }
                            )


                    # =================================================
                    # VIEWER
                    # =================================================

                    elif role == "viewer":

                        session.viewers[
                            client_id
                        ] = websocket


                        print(
                            f'[i] {client_id} VIEWER '
                            f'for "{session_id}"'
                        )


                        # Producer already connected

                        if session.producer is not None:

                            await safe_send(
                                websocket,
                                {
                                    "type":
                                        "producer-available",

                                    "sessionId":
                                        session_id
                                }
                            )


                            await safe_send(
                                session.producer,
                                {
                                    "type":
                                        "viewer-joined",

                                    "sessionId":
                                        session_id,

                                    "viewerId":
                                        client_id
                                }
                            )


                    else:

                        print(
                            f"[!] {client_id}: "
                            f"Unknown role: {role}"
                        )


                    # Registration confirmation

                    await safe_send(
                        websocket,
                        {
                            "type":
                                "registered",

                            "sessionId":
                                session_id,

                            "role":
                                role,

                            "clientId":
                                client_id
                        }
                    )

                    continue


                # =================================================
                # WEBRTC SIGNALING
                # =================================================

                if msg_type in (
                    "offer",
                    "answer",
                    "ice-candidate"
                ):

                    if not session_id:

                        print(
                            f"[!] {client_id}: "
                            f"Not registered"
                        )

                        continue


                    session = get_session(
                        session_id
                    )


                    target_id = data.get(
                        "targetId"
                    )


                    outgoing = {
                        **data,
                        "fromId": client_id
                    }


                    # =================================================
                    # PRODUCER -> VIEWER
                    # =================================================

                    if role == "producer":

                        if target_id:

                            target_ws = (
                                session.viewers.get(
                                    target_id
                                )
                            )


                            await safe_send(
                                target_ws,
                                outgoing
                            )

                        else:

                            for viewer_ws in (
                                session.viewers.values()
                            ):

                                await safe_send(
                                    viewer_ws,
                                    outgoing
                                )


                    # =================================================
                    # VIEWER -> PRODUCER
                    # =================================================

                    elif role == "viewer":

                        await safe_send(
                            session.producer,
                            outgoing
                        )


            # =================================================
            # WEBSOCKET ERROR
            # =================================================

            elif msg.type == web.WSMsgType.ERROR:

                print(
                    f"[!] WebSocket error "
                    f"for {client_id}: "
                    f"{websocket.exception()}"
                )


            # =================================================
            # CLOSE
            # =================================================

            elif msg.type in (
                web.WSMsgType.CLOSE,
                web.WSMsgType.CLOSED
            ):

                break


    except Exception as e:

        print(
            f"[!] WebSocket exception "
            f"for {client_id}: {e}"
        )


    finally:

        print(
            f"[-] disconnected: {client_id}"
        )


        # =========================================================
        # SESSION CLEANUP
        # =========================================================

        if session_id:

            session = get_session(
                session_id
            )


            # =================================================
            # PRODUCER
            # =================================================

            if (
                role == "producer"
                and session.producer == websocket
            ):

                session.producer = None


                print(
                    f'[i] Producer left '
                    f'"{session_id}"'
                )


                for viewer_ws in (
                    session.viewers.values()
                ):

                    await safe_send(
                        viewer_ws,
                        {
                            "type":
                                "producer-left",

                            "sessionId":
                                session_id
                        }
                    )


            # =================================================
            # VIEWER
            # =================================================

            elif role == "viewer":

                session.viewers.pop(
                    client_id,
                    None
                )


                print(
                    f'[i] Viewer {client_id} left '
                    f'"{session_id}"'
                )


            # =================================================
            # REMOVE EMPTY SESSION
            # =================================================

            if (
                session.producer is None
                and not session.viewers
            ):

                sessions.pop(
                    session_id,
                    None
                )


                print(
                    f'[i] Removed empty session '
                    f'"{session_id}"'
                )


# ============================================================
# WEBSOCKET HTTP ROUTE
# ============================================================

async def websocket_http_handler(request):

    print(
        f"[WS] WebSocket request from "
        f"{request.remote}"
    )


    ws = web.WebSocketResponse()


    await ws.prepare(request)


    print(
        "[WS] Handshake successful"
    )


    await websocket_handler(ws)


    return ws


# ============================================================
# STATIC WEBVIEWER FILES
# ============================================================

async def serve_file(request):

    request_path = request.path


    # Root
    if request_path in (
        "/",
        "/view"
    ):

        request_path = "/index.html"


    # Remove leading slash

    relative_path = request_path.lstrip("/")


    # Build absolute path

    file_path = os.path.abspath(
        os.path.join(
            WEB_ROOT,
            relative_path
        )
    )


    # =========================================================
    # SECURITY CHECK
    # =========================================================

    try:

        common_path = os.path.commonpath(
            [
                WEB_ROOT,
                file_path
            ]
        )

    except ValueError:

        return web.Response(
            status=403,
            text="Forbidden"
        )


    if common_path != WEB_ROOT:

        print(
            f"[!] Forbidden path: "
            f"{request_path}"
        )

        return web.Response(
            status=403,
            text="Forbidden"
        )


    # =========================================================
    # FILE EXISTS?
    # =========================================================

    if not os.path.isfile(file_path):

        print(
            f"[404] File not found: "
            f"{file_path}"
        )

        return web.Response(
            status=404,
            text="File not found"
        )


    # =========================================================
    # CONTENT TYPE
    # =========================================================

    ext = os.path.splitext(
        file_path
    )[1].lower()


    content_types = {

        ".html":
            "text/html",

        ".js":
            "application/javascript",

        ".css":
            "text/css",

        ".json":
            "application/json",

        ".png":
            "image/png",

        ".jpg":
            "image/jpeg",

        ".jpeg":
            "image/jpeg",

        ".gif":
            "image/gif",

        ".svg":
            "image/svg+xml",

        ".ico":
            "image/x-icon",

        ".webp":
            "image/webp",

        ".mp4":
            "video/mp4",

        ".mov":
            "video/quicktime"
    }


    content_type = content_types.get(
        ext,
        "application/octet-stream"
    )


    # =========================================================
    # READ FILE
    # =========================================================

    try:

        with open(
            file_path,
            "rb"
        ) as f:

            body = f.read()


    except Exception as e:

        print(
            f"[!] File read error: {e}"
        )

        return web.Response(
            status=500,
            text="Error reading file"
        )


    # =========================================================
    # RESPONSE
    # =========================================================

    if (
        content_type.startswith("text/")
        or content_type in (
            "application/javascript",
            "application/json",
            "image/svg+xml"
        )
    ):

        return web.Response(
            body=body,
            content_type=content_type,
            charset="utf-8"
        )


    return web.Response(
        body=body,
        content_type=content_type
    )


# ============================================================
# MAIN
# ============================================================

async def main():

    print()

    print(
        f"[i] WebViewer root: {WEB_ROOT}"
    )


    if os.path.isdir(WEB_ROOT):

        print(
            "[i] WebViewer directory: OK"
        )

    else:

        print(
            "[!] WARNING: WebViewer directory "
            "does not exist!"
        )


    app = web.Application()


    # =========================================================
    # IMPORTANT:
    # WebSocket MUST COME FIRST
    # =========================================================

    app.router.add_route(
        "*",
        "/ws",
        websocket_http_handler
    )


    # =========================================================
    # STATIC WEBVIEWER
    # =========================================================

    app.router.add_get(
        "/{path_info:.*}",
        serve_file
    )


    # =========================================================
    # SERVER
    # =========================================================

    runner = web.AppRunner(
        app
    )


    await runner.setup()


    site = web.TCPSite(
        runner,
        "0.0.0.0",
        PORT
    )


    await site.start()


    # =========================================================
    # SERVER INFO
    # =========================================================

    print()
    print("=" * 60)
    print("FPSMonitor Server (Python)")
    print("=" * 60)

    print(
        f"HTTP: http://localhost:{PORT}"
    )

    print(
        f"WS:   ws://localhost:{PORT}/ws"
    )

    print()

    print(
        "Reachable on LAN:"
    )


    for ip in local_ips():

        print(
            f"  HTTP: http://{ip}:{PORT}"
        )

        print(
            f"  WS:   ws://{ip}:{PORT}/ws"
        )


    print("=" * 60)
    print()


    # Keep server alive

    await asyncio.Future()


# ============================================================
# START
# ============================================================

if __name__ == "__main__":

    asyncio.run(main())
