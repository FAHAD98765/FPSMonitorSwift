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

const rtcConfig = {
    iceServers: [
        {
            urls: "stun:stun.l.google.com:19302"
        }
    ]
};

function setStatus(message) {
    statusElement.textContent = message;
    console.log("[WebViewer]", message);
}

if (!sessionId) {
    setStatus("Missing session ID");
} else {
    setStatus(`Connecting to session: ${sessionId}`);
    connectSignaling();
}

function connectSignaling() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
   const wsURL = `${protocol}//${window.location.host}/ws`;

    console.log("WebSocket:", wsURL);

    socket = new WebSocket(wsURL);

    socket.onopen = () => {
        console.log("[WS] Connected");

        socket.send(JSON.stringify({
            type: "register",
            sessionId: sessionId,
            role: "viewer"
        }));

        setStatus("Connected to signaling server. Waiting for producer...");
    };

    socket.onmessage = async (event) => {
        try {
            const message = JSON.parse(event.data);

            console.log("[WS] Message:", message.type);

            switch (message.type) {
                case "registered":
                    console.log("[WS] Registered as viewer:", message.clientId);
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
                    setStatus("Producer disconnected");
                    stopPeerConnection();
                    break;

                case "error":
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
        console.log("[WS] Disconnected");
        setStatus("Signaling server disconnected");
    };
}

async function createPeerConnection() {
    if (peerConnection) {
        peerConnection.close();
    }

    peerConnection = new RTCPeerConnection(rtcConfig);

    peerConnection.ontrack = (event) => {
        console.log("[WebRTC] Remote track received");

        if (event.streams && event.streams.length > 0) {
            videoElement.srcObject = event.streams[0];
        } else {
            const stream = new MediaStream([event.track]);
            videoElement.srcObject = stream;
        }

        videoElement
            .play()
            .catch(error => {
                console.warn("[Video] Autoplay prevented:", error);
                setStatus("Tap the video to start playback");
            });

        setStatus("LIVE");
    };

    peerConnection.onicecandidate = (event) => {
        if (!event.candidate || !socket || socket.readyState !== WebSocket.OPEN) {
            return;
        }

        socket.send(JSON.stringify({
            type: "ice-candidate",
            sessionId: sessionId,
            targetId: producerId,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            sdpMid: event.candidate.sdpMid,
            candidate: event.candidate.candidate
        }));
    };

    peerConnection.onconnectionstatechange = () => {
        console.log(
            "[WebRTC] Connection state:",
            peerConnection.connectionState
        );

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
        console.log(
            "[WebRTC] ICE state:",
            peerConnection.iceConnectionState
        );
    };
}

async function handleOffer(message) {
    try {
        producerId = message.fromId;

        console.log("[WebRTC] Offer received from producer:", producerId);

        await createPeerConnection();

        await peerConnection.setRemoteDescription(
            new RTCSessionDescription({
                type: "offer",
                sdp: message.sdp
            })
        );

        const answer = await peerConnection.createAnswer();

        await peerConnection.setLocalDescription(answer);

        socket.send(JSON.stringify({
            type: "answer",
            sessionId: sessionId,
            targetId: producerId,
            sdp: answer.sdp
        }));

        setStatus("Answer sent. Connecting video...");

    } catch (error) {
        console.error("[WebRTC] Offer handling failed:", error);
        setStatus("Failed to establish WebRTC connection");
    }
}

async function handleRemoteCandidate(message) {
    try {
        if (!peerConnection) {
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

function stopPeerConnection() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }

    videoElement.srcObject = null;
    producerId = null;
}

function updateFPS() {
    const now = performance.now();
    const elapsed = now - lastFPSCheck;

    if (elapsed >= 1000) {
        const fps = renderedFrames * 1000 / elapsed;

        fpsElement.textContent = `FPS: ${fps.toFixed(1)}`;

        renderedFrames = 0;
        lastFPSCheck = now;
    }

    requestAnimationFrame(updateFPS);
}

if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
    function countVideoFrame() {
        renderedFrames++;
        videoElement.requestVideoFrameCallback(countVideoFrame);
    }

    videoElement.requestVideoFrameCallback(countVideoFrame);
} else {
    console.warn(
        "requestVideoFrameCallback not supported; using playback event fallback"
    );

    videoElement.addEventListener("timeupdate", () => {
        renderedFrames++;
    });
}

requestAnimationFrame(updateFPS);

window.addEventListener("beforeunload", () => {
    stopPeerConnection();

    if (socket) {
        socket.close();
    }
});
