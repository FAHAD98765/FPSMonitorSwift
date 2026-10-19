
const params = new URLSearchParams(window.location.search);
const sessionId = params.get("session");

const statusElement = document.getElementById("status");
const videoElement = document.getElementById("remoteVideo");
const fpsElement = document.getElementById("fps");

let socket = null;
let peerConnection = null;
let producerId = null;

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

        const turnServers = await response.json();

        if (Array.isArray(turnServers) && turnServers.length > 0) {
            rtcConfig.iceServers = [
                { urls: "stun:stun.l.google.com:19302" },
                ...turnServers
            ];

            console.log("[ICE] TURN servers loaded");
        }
    } catch (error) {
        console.error("[ICE] Failed to fetch TURN credentials:", error);
        console.log("[ICE] Continuing with STUN only");
    }
}

// ============================================================
// STATUS
// ============================================================

function setStatus(message) {
    console.log("[WebViewer]", message);

    if (statusElement) {
        statusElement.textContent = message;
    }
}

// ============================================================
// INITIALIZATION
// ============================================================

async function initializeViewer() {
    if (!sessionId) {
        setStatus("Missing session ID");
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

    console.log("[WS] Connecting to:", wsURL);

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
                    setStatus("Connected. Waiting for producer...");
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
                    console.log("[WS] Producer disconnected");

                    stopPeerConnection();

                    setStatus("Host disconnected");
                    break;

                case "error":
                    console.error("[WS] Server error:", message.message);
                    setStatus(`Server error: ${message.message}`);
                    break;

                case "pong":
                    console.log("[WS] Pong received");
                    break;

                default:
                    console.log("[WS] Unknown message:", message);
                    break;
            }
        } catch (error) {
            console.error("[WS] Message parsing error:", error);
        }
    };

    socket.onerror = (error) => {
        console.error("[WS] Error:", error);
        setStatus("WebSocket connection error");
    };

    socket.onclose = (event) => {
        console.log("[WS] Disconnected", {
            code: event.code,
            reason: event.reason
        });

        stopPeerConnection();
        setStatus("Signaling server disconnected");
    };
}

// ============================================================
// CREATE PEER CONNECTION
// ============================================================

async function createPeerConnection() {
    stopPeerConnection();

    peerConnection = new RTCPeerConnection(rtcConfig);

    peerConnection.ontrack = (event) => {
        console.log("[WebRTC] Remote track received");

        if (event.streams && event.streams.length > 0) {
            videoElement.srcObject = event.streams[0];
        } else {
            videoElement.srcObject = new MediaStream([event.track]);
        }

        videoElement.play()
            .then(() => {
                console.log("[Video] Playback started");
                setStatus("LIVE");
            })
            .catch((error) => {
                console.warn("[Video] Autoplay prevented:", error);
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

        const state = peerConnection.connectionState;

        console.log("[WebRTC] Connection state:", state);

        switch (state) {
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
        if (!peerConnection) return;

        console.log(
            "[WebRTC] ICE state:",
            peerConnection.iceConnectionState
        );
    };
}

// ============================================================
// HANDLE OFFER
// ============================================================

async function handleOffer(message) {
    try {
        producerId = message.fromId;

        console.log("[WebRTC] Offer from producer:", producerId);

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

        console.log("[WebRTC] Answer sent");

        setStatus("Answer sent. Connecting video...");
    } catch (error) {
        console.error("[WebRTC] Offer handling failed:", error);
        setStatus("Failed to establish WebRTC connection");
    }
}

// ============================================================
// HANDLE REMOTE ICE CANDIDATE
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

        console.log("[ICE] Remote candidate added");
    } catch (error) {
        console.error("[ICE] Failed to add candidate:", error);
    }
}

// ============================================================
// STOP WEBRTC
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

        if (fpsElement) {
            fpsElement.textContent = `FPS: ${fps.toFixed(1)}`;
        }

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
        if (!videoElement.srcObject) {
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
    console.warn("requestVideoFrameCallback not supported");

    videoElement.addEventListener("timeupdate", () => {
        if (!videoElement.paused) {
            renderedFrames++;
        }
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
