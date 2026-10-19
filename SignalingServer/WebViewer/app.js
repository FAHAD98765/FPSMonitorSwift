
const params = new URLSearchParams(window.location.search);
const sessionId = params.get("session");

const statusElement = document.getElementById("status");
const videoElement = document.getElementById("remoteVideo");
const fpsElement = document.getElementById("fps");
const disconnectButton = document.getElementById("disconnectButton");

let socket = null;
let peerConnection = null;
let producerId = null;
let registered = false;
let sessionEnded = false;

let renderedFrames = 0;
let lastFPSCheck = performance.now();
let animationFrameId = null;
let videoFrameCallbackId = null;

// ============================================================
// ICE SERVERS — STUN + TURN
// ============================================================

let rtcConfig = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" }
    ]
};

async function fetchTurnCredentials() {
    try {
        const response = await fetch(
            "https://fpsmonitor-turn.metered.live/api/v1/turn/credentials?apiKey=64926152b434b88fcdf288be2869c08e12a1"
        );

        if (!response.ok) {
            throw new Error(`TURN request failed: ${response.status}`);
        }

        const turnServers = await response.json();

        if (Array.isArray(turnServers) && turnServers.length > 0) {
            rtcConfig.iceServers = [
                { urls: "stun:stun.l.google.com:19302" },
                ...turnServers
            ];

            console.log("[ICE] TURN servers loaded");
        }
    } catch (error) {
        console.error("[ICE] TURN fetch failed:", error);
        console.log("[ICE] Continuing with STUN only");
    }
}

// ============================================================
// STATUS
// ============================================================

function setStatus(message) {
    console.log("[WebViewer]", message);
    statusElement.textContent = message;
}

// ============================================================
// INITIALIZATION
// ============================================================

async function initializeViewer() {
    if (!sessionId) {
        setStatus("Missing session ID");
        disconnectButton.disabled = true;
        return;
    }

    setStatus("Fetching TURN credentials...");

    await fetchTurnCredentials();

    setStatus(`Connecting to session: ${sessionId}`);

    connectSignaling();
}

initializeViewer();

// ============================================================
// SIGNALING SERVER
// ============================================================

function connectSignaling() {
    const protocol =
        window.location.protocol === "https:" ? "wss:" : "ws:";

    const wsURL = `${protocol}//${window.location.host}/ws`;

    console.log("[WS] Connecting:", wsURL);

    socket = new WebSocket(wsURL);

    socket.onopen = () => {
        if (sessionEnded) return;

        socket.send(JSON.stringify({
            type: "register",
            sessionId,
            role: "viewer"
        }));
    };

    socket.onmessage = async (event) => {
        try {
            const message = JSON.parse(event.data);

            console.log("[WS] Message:", message);

            switch (message.type) {
                case "registered":
                    registered = true;
                    setStatus("Connected. Waiting for host...");
                    break;

                case "producer-available":
                    setStatus("Host available. Waiting for video...");
                    break;

                case "offer":
                    await handleOffer(message);
                    break;

                case "ice-candidate":
                    await handleRemoteCandidate(message);
                    break;

                case "producer-left":
                    stopPeerConnection();
                    setStatus("Host disconnected");
                    break;

                case "session-ended":
                    finishViewer("Session ended by Disconnect");
                    break;

                case "error":
                    console.error("[WS] Server error:", message.message);
                    setStatus(`Server error: ${message.message}`);
                    break;

                case "pong":
                    break;

                default:
                    console.log("[WS] Unknown message:", message);
            }
        } catch (error) {
            console.error("[WS] Message parsing error:", error);
        }
    };

    socket.onerror = (error) => {
        console.error("[WS] Error:", error);

        if (!sessionEnded) {
            setStatus("WebSocket connection error");
        }
    };

    socket.onclose = () => {
        registered = false;
        stopPeerConnection();

        if (!sessionEnded) {
            setStatus("Signaling server disconnected");
        }
    };
}

// ============================================================
// DISCONNECT — END ENTIRE SESSION
// ============================================================

disconnectButton.addEventListener("click", () => {
    if (sessionEnded) return;

    const confirmed = window.confirm(
        "Disconnect this session for both host and viewer?"
    );

    if (!confirmed) return;

    disconnectButton.disabled = true;

    if (
        registered &&
        socket &&
        socket.readyState === WebSocket.OPEN
    ) {
        // Send the session-ending request before closing the socket.
        socket.send(JSON.stringify({
            type: "end-session",
            sessionId
        }));

        setStatus("Ending session...");
    } else {
        // Without a server connection, the host cannot be notified.
        setStatus("Server unavailable. Host may still be streaming.");
    }

    // Wait for the server's session-ended message when possible.
    // Use a short fallback so the viewer does not remain connected.
    window.setTimeout(() => {
        finishViewer("Disconnected");
    }, 1000);
});

function finishViewer(message) {
    if (sessionEnded) return;

    sessionEnded = true;
    registered = false;

    stopPeerConnection();

    if (socket) {
        socket.onclose = null;
        socket.close();
        socket = null;
    }

    disconnectButton.disabled = true;
    setStatus(message);
}

// ============================================================
// CREATE PEER CONNECTION
// ============================================================

async function createPeerConnection() {
    stopPeerConnection();

    peerConnection = new RTCPeerConnection(rtcConfig);

    peerConnection.ontrack = (event) => {
        if (sessionEnded) return;

        if (event.streams && event.streams.length > 0) {
            videoElement.srcObject = event.streams[0];
        } else {
            videoElement.srcObject = new MediaStream([event.track]);
        }

        videoElement.play()
            .then(() => setStatus("LIVE"))
            .catch((error) => {
                console.warn("[Video] Playback blocked:", error);
                setStatus("Tap the video to start playback");
            });
    };

    peerConnection.onicecandidate = (event) => {
        if (
            !event.candidate ||
            !socket ||
            socket.readyState !== WebSocket.OPEN ||
            sessionEnded
        ) {
            return;
        }

        socket.send(JSON.stringify({
            type: "ice-candidate",
            sessionId,
            targetId: producerId,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            sdpMid: event.candidate.sdpMid,
            candidate: event.candidate.candidate
        }));
    };

    peerConnection.onconnectionstatechange = () => {
        if (!peerConnection || sessionEnded) return;

        switch (peerConnection.connectionState) {
            case "connected":
                setStatus("LIVE");
                break;

            case "connecting":
                setStatus("Connecting video...");
                break;

            case "disconnected":
                setStatus("Video connection disconnected");
                break;

            case "failed":
                setStatus("WebRTC connection failed");
                break;

            case "closed":
                setStatus("Video connection closed");
                break;
        }
    };
}

// ============================================================
// HANDLE OFFER
// ============================================================

async function handleOffer(message) {
    try {
        if (sessionEnded) return;

        producerId = message.fromId;

        await createPeerConnection();

        await peerConnection.setRemoteDescription(
            new RTCSessionDescription({
                type: "offer",
                sdp: message.sdp
            })
        );

        if (sessionEnded || !peerConnection) return;

        const answer = await peerConnection.createAnswer();

        await peerConnection.setLocalDescription(answer);

        if (
            !socket ||
            socket.readyState !== WebSocket.OPEN ||
            sessionEnded
        ) {
            return;
        }

        socket.send(JSON.stringify({
            type: "answer",
            sessionId,
            targetId: producerId,
            sdp: answer.sdp
        }));

        setStatus("Answer sent. Connecting video...");
    } catch (error) {
        console.error("[WebRTC] Offer failed:", error);
        setStatus("Failed to establish WebRTC connection");
    }
}

// ============================================================
// HANDLE REMOTE ICE CANDIDATE
// ============================================================

async function handleRemoteCandidate(message) {
    try {
        if (!peerConnection || !peerConnection.remoteDescription) {
            return;
        }

        await peerConnection.addIceCandidate(
            new RTCIceCandidate({
                candidate: message.candidate,
                sdpMid: message.sdpMid,
                sdpMLineIndex: message.sdpMLineIndex
            })
        );
    } catch (error) {
        console.error("[ICE] Failed to add candidate:", error);
    }
}

// ============================================================
// STOP PEER CONNECTION
// ============================================================

function stopPeerConnection() {
    if (peerConnection) {
        peerConnection.ontrack = null;
        peerConnection.onicecandidate = null;
        peerConnection.onconnectionstatechange = null;

        peerConnection.close();
        peerConnection = null;
    }

    if (videoElement) {
        videoElement.pause();
        videoElement.srcObject = null;
    }

    producerId = null;
}

// ============================================================
// FPS COUNTER
// ============================================================

function updateFPS() {
    const now = performance.now();
    const elapsed = now - lastFPSCheck;

    if (elapsed >= 1000) {
        const fps = renderedFrames * 1000 / elapsed;

        fpsElement.textContent = `FPS: ${fps.toFixed(1)}`;

        renderedFrames = 0;
        lastFPSCheck = now;
    }

    animationFrameId = requestAnimationFrame(updateFPS);
}

// ============================================================
// VIDEO FRAME COUNTING
// ============================================================

if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
    function countVideoFrame() {
        if (
            sessionEnded ||
            !videoElement.srcObject ||
            videoElement.paused
        ) {
            videoFrameCallbackId = null;
            return;
        }

        renderedFrames++;

        videoFrameCallbackId =
            videoElement.requestVideoFrameCallback(countVideoFrame);
    }

    videoElement.addEventListener("playing", () => {
        if (videoFrameCallbackId === null && !sessionEnded) {
            videoFrameCallbackId =
                videoElement.requestVideoFrameCallback(countVideoFrame);
        }
    });
} else {
    videoElement.addEventListener("timeupdate", () => {
        if (!videoElement.paused) {
            renderedFrames++;
        }
    });
}

requestAnimationFrame(updateFPS);

// ============================================================
// PAGE CLEANUP
// ============================================================

window.addEventListener("beforeunload", () => {
    stopPeerConnection();

    if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
    }

    if (
        videoFrameCallbackId !== null &&
        typeof videoElement.cancelVideoFrameCallback === "function"
    ) {
        videoElement.cancelVideoFrameCallback(videoFrameCallbackId);
    }

    if (socket) {
        socket.close();
        socket = null;
    }
});
