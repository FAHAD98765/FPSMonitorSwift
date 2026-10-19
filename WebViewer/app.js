
const params = new URLSearchParams(window.location.search);
const sessionId = params.get("session");

const statusElement = document.getElementById("status");
const videoElement = document.getElementById("remoteVideo");
const fpsElement = document.getElementById("fps");
const modeStatusElement = document.getElementById("modeStatus");

const modeInputs = document.querySelectorAll(
    'input[name="disconnectMode"]'
);

let socket = null;
let peerConnection = null;
let producerId = null;

let disconnectMode = "manual";
let registered = false;
let renderedFrames = 0;
let lastFPSCheck = performance.now();
let animationFrameId = null;
let videoFrameCallbackId = null;

// ============================================================
// ICE SERVERS
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

        const servers = await response.json();

        if (Array.isArray(servers) && servers.length > 0) {
            rtcConfig.iceServers = [
                { urls: "stun:stun.l.google.com:19302" },
                ...servers
            ];

            console.log("[ICE] TURN credentials loaded");
        }
    } catch (error) {
        console.error("[ICE] TURN unavailable:", error);
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
// DISCONNECT MODE
// ============================================================

function updateModeStatus(message) {
    modeStatusElement.textContent = message;
}

function sendDisconnectMode() {
    if (!registered || !socket ||
        socket.readyState !== WebSocket.OPEN) {
        updateModeStatus(
            "Preference selected. Waiting for server connection..."
        );
        return;
    }

    socket.send(JSON.stringify({
        type: "set-disconnect-mode",
        sessionId,
        mode: disconnectMode
    }));
}

modeInputs.forEach((input) => {
    input.addEventListener("change", () => {
        if (!input.checked) return;

        disconnectMode = input.value;

        if (disconnectMode === "auto") {
            updateModeStatus(
                "Auto Stop selected. Host will receive a stop request when this viewer disconnects."
            );
        } else {
            updateModeStatus(
                "Manual Stop selected. Host streaming will continue when this viewer disconnects."
            );
        }

        sendDisconnectMode();
    });
});

// ============================================================
// INITIALIZATION
// ============================================================

async function initializeViewer() {
    if (!sessionId) {
        setStatus("Missing session ID in URL");
        return;
    }

    setStatus("Fetching TURN credentials...");
    await fetchTurnCredentials();

    setStatus(`Connecting to session: ${sessionId}`);
    connectSignaling();
}

initializeViewer();

// ============================================================
// SIGNALING
// ============================================================

function connectSignaling() {
    const protocol =
        window.location.protocol === "https:" ? "wss:" : "ws:";

    const wsURL = `${protocol}//${window.location.host}/ws`;

    socket = new WebSocket(wsURL);

    socket.onopen = () => {
        console.log("[WS] Connected");

        socket.send(JSON.stringify({
            type: "register",
            sessionId,
            role: "viewer"
        }));

        setStatus("Connected. Waiting for producer...");
    };

    socket.onmessage = async (event) => {
        try {
            const message = JSON.parse(event.data);

            console.log("[WS] Message:", message);

            switch (message.type) {
                case "registered":
                    registered = true;
                    setStatus("Connected. Waiting for producer...");
                    sendDisconnectMode();
                    break;

                case "disconnect-mode-updated":
                    updateModeStatus(
                        message.mode === "auto"
                            ? "Auto Stop saved on server."
                            : "Manual Stop saved on server."
                    );
                    break;

                case "producer-available":
                    setStatus("Producer available. Waiting for video...");
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
            console.error("[WS] Message error:", error);
        }
    };

    socket.onerror = (error) => {
        console.error("[WS] Error:", error);
        setStatus("WebSocket connection error");
    };

    socket.onclose = () => {
        registered = false;
        stopPeerConnection();
        setStatus("Signaling server disconnected");
    };
}

// ============================================================
// PEER CONNECTION
// ============================================================

async function createPeerConnection() {
    stopPeerConnection();

    peerConnection = new RTCPeerConnection(rtcConfig);

    peerConnection.ontrack = (event) => {
        if (event.streams && event.streams.length > 0) {
            videoElement.srcObject = event.streams[0];
        } else {
            videoElement.srcObject = new MediaStream([event.track]);
        }

        videoElement.play()
            .then(() => setStatus("LIVE"))
            .catch((error) => {
                console.warn("[Video] Playback needs user interaction", error);
                setStatus("Tap the video to start playback");
            });
    };

    peerConnection.onicecandidate = (event) => {
        if (
            !event.candidate ||
            !socket ||
            socket.readyState !== WebSocket.OPEN
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
        if (!peerConnection) return;

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

    peerConnection.oniceconnectionstatechange = () => {
        if (peerConnection) {
            console.log(
                "[ICE] State:",
                peerConnection.iceConnectionState
            );
        }
    };
}

// ============================================================
// OFFER / ANSWER
// ============================================================

async function handleOffer(message) {
    try {
        producerId = message.fromId;

        await createPeerConnection();

        await peerConnection.setRemoteDescription(
            new RTCSessionDescription({
                type: "offer",
                sdp: message.sdp
            })
        );

        const answer = await peerConnection.createAnswer();

        await peerConnection.setLocalDescription(answer);

        if (!socket || socket.readyState !== WebSocket.OPEN) {
            setStatus("Signaling connection lost");
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
// REMOTE ICE
// ============================================================

async function handleRemoteCandidate(message) {
    try {
        if (!peerConnection || !peerConnection.remoteDescription) {
            console.warn("[ICE] Peer connection not ready");
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
        peerConnection.oniceconnectionstatechange = null;

        peerConnection.close();
        peerConnection = null;
    }

    videoElement.pause();
    videoElement.srcObject = null;
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

if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
    function countVideoFrame() {
        if (!videoElement.srcObject || videoElement.paused) {
            videoFrameCallbackId = null;
            return;
        }

        renderedFrames++;

        videoFrameCallbackId =
            videoElement.requestVideoFrameCallback(countVideoFrame);
    }

    videoElement.addEventListener("playing", () => {
        if (videoFrameCallbackId === null) {
            videoFrameCallbackId =
                videoElement.requestVideoFrameCallback(countVideoFrame);
        }
    });
} else {
    videoElement.addEventListener("timeupdate", () => {
        if (!videoElement.paused) renderedFrames++;
    });
}

requestAnimationFrame(updateFPS);

// ============================================================
// CLEANUP
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
