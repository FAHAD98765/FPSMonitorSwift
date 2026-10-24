/* ============================================================
   FPS MONITOR WEB VIEWER
   Updated:
   - Every valid bounce updates the 2D court map.
   - UNCERTAIN badge + replay show for any bounce event whose
     confidence_level is not "high" and that carries a clip URL.
     (No special "linecall"/"event_kind" marker is required — the
     backend sends plain bounce events, so confidence is the only
     signal we have for "uncertain".)
   ============================================================ */

// NOTE: named viewerParams (not params): index.html's inline script
// already declares a global "params", and declaring it twice stops
// this whole file from running.
const viewerParams = new URLSearchParams(window.location.search);
const sessionId =
    viewerParams.get("session") ||
    viewerParams.get("sessionId");

// ============================================================
// DEBUG FLAGS
// ============================================================

const LINECALL_DEBUG = false;
const WEBRTC_DEBUG = false;

function dlog(...args) {
    if (LINECALL_DEBUG) {
        console.log(...args);
    }
}

function wlog(...args) {
    if (WEBRTC_DEBUG) {
        console.log(...args);
    }
}

const statusElement = document.getElementById("status");
const videoElement = document.getElementById("remoteVideo");
const fpsElement = document.getElementById("fps");

let socket = null;
let peerConnection = null;
let producerId = null;
let viewerRejected = false;

const TARGET_FPS = 25;
const STATS_INTERVAL_MS = 1000;

let renderedFrames = 0;
let lastFPSCheck = performance.now();

let fpsIntervalId = null;
let videoFrameCallbackId = null;
let statsIntervalId = null;

let remoteCandidatesQueue = [];
let lastStats = null;

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
        } else {
            console.warn("[ICE] No TURN servers returned");
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

function setConnectionIndicator(state) {
    if (typeof window.setConnectionState === "function") {
        window.setConnectionState(state);
    }
}

// ============================================================
// INITIALIZATION
// ============================================================

async function initializeViewer() {
    if (!sessionId) {
        setStatus("Missing session ID");
        setConnectionIndicator("disconnected");
        return;
    }

    setConnectionIndicator("connecting");
    setStatus("Fetching TURN credentials...");

    await fetchTurnCredentials();

    if (viewerRejected) return;

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

        if (viewerRejected) {
            socket.close();
            return;
        }

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

            wlog("[WS] Message:", message.type);

            switch (message.type) {
                case "registered":
                    setStatus("Connected. Waiting for producer...");
                    break;

                case "producer-available":
                    setStatus("Producer available. Waiting for video...");
                    break;

                case "offer":
                    if (viewerRejected) return;
                    await handleOffer(message);
                    break;

                case "ice-candidate":
                    if (viewerRejected) return;
                    await handleRemoteCandidate(message);
                    break;

                case "producer-left":
                    console.log("[WS] Producer disconnected");

                    stopPeerConnection();
                    setStatus("Host disconnected");
                    setConnectionIndicator("disconnected");
                    break;

                case "error": {
                    console.error("[WS] Server error:", message.message);

                    const errorMessage = message.message || "";

                    if (
                        errorMessage ===
                        "Stream is busy. Another viewer is already connected."
                    ) {
                        viewerRejected = true;

                        stopPeerConnection();

                        setStatus(
                            "Stream is busy. Another user is already connected."
                        );

                        setConnectionIndicator("disconnected");

                        if (socket && socket.readyState === WebSocket.OPEN) {
                            socket.close(4003, "Viewer limit reached");
                        }
                    } else {
                        setStatus(`Server error: ${errorMessage}`);
                    }

                    break;
                }

                case "pong":
                    wlog("[WS] Pong received");
                    break;

                // New LineCall events pushed by the server.
                case "line-call":
                    handlePushedLineCall(message.event, false);
                    break;

                // Existing latest event is remembered, not displayed.
                case "line-call-latest":
                    handlePushedLineCall(message.event, true);
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

        if (!viewerRejected) {
            setStatus("WebSocket connection error");
            setConnectionIndicator("disconnected");
        }
    };

    socket.onclose = (event) => {
        console.log("[WS] Disconnected", {
            code: event.code,
            reason: event.reason
        });

        stopPeerConnection();

        if (!viewerRejected) {
            setStatus("Signaling server disconnected");
            setConnectionIndicator("disconnected");
        }
    };
}

// ============================================================
// CREATE PEER CONNECTION
// ============================================================

async function createPeerConnection() {
    stopPeerConnection();

    peerConnection = new RTCPeerConnection(rtcConfig);

    peerConnection.ontrack = (event) => {
        if (viewerRejected || !peerConnection) return;

        console.log("[WebRTC] Remote track received");

        if (event.streams && event.streams.length > 0) {
            videoElement.srcObject = event.streams[0];
        } else {
            videoElement.srcObject = new MediaStream([event.track]);
        }

        videoElement.play()
            .then(() => {
                console.log("[Video] Playback started");

                if (!viewerRejected) {
                    setStatus("LIVE");
                    setConnectionIndicator("connected");
                }

                startStatsMonitoring();
                startLineCallPolling();
            })
            .catch((error) => {
                console.warn("[Video] Playback could not start:", error);

                if (!viewerRejected) {
                    setStatus("Tap the video to start playback");
                    setConnectionIndicator("connected");
                }

                startLineCallPolling();
            });
    };

    peerConnection.onicecandidate = (event) => {
        if (
            !event.candidate ||
            !socket ||
            socket.readyState !== WebSocket.OPEN ||
            viewerRejected
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
        if (!peerConnection || viewerRejected) return;

        const state = peerConnection.connectionState;

        console.log("[WebRTC] Connection state:", state);

        switch (state) {
            case "connected":
                setStatus("LIVE");
                setConnectionIndicator("connected");
                startStatsMonitoring();
                startLineCallPolling();
                break;

            case "connecting":
                setStatus("Connecting video...");
                setConnectionIndicator("connecting");
                break;

            case "disconnected":
                setStatus("Video connection disconnected");
                setConnectionIndicator("disconnected");
                stopLineCallPolling();
                break;

            case "failed":
                setStatus("WebRTC connection failed");
                setConnectionIndicator("disconnected");
                stopLineCallPolling();
                break;

            case "closed":
                setStatus("Video connection closed");
                setConnectionIndicator("disconnected");
                stopLineCallPolling();
                break;
        }
    };

    peerConnection.oniceconnectionstatechange = () => {
        if (!peerConnection) return;

        wlog(
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
        if (viewerRejected) return;

        producerId = message.fromId;

        console.log("[WebRTC] Offer from producer:", producerId);

        await createPeerConnection();

        if (!peerConnection || viewerRejected) return;

        await peerConnection.setRemoteDescription(
            new RTCSessionDescription({
                type: "offer",
                sdp: message.sdp
            })
        );

        await flushRemoteCandidates();

        if (viewerRejected || !peerConnection) return;

        const answer = await peerConnection.createAnswer();

        await peerConnection.setLocalDescription(answer);

        if (
            viewerRejected ||
            !socket ||
            socket.readyState !== WebSocket.OPEN
        ) {
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

        if (!viewerRejected) {
            setStatus("Failed to establish WebRTC connection");
        }
    }
}

// ============================================================
// HANDLE REMOTE ICE CANDIDATES
// ============================================================

async function handleRemoteCandidate(message) {
    try {
        if (viewerRejected || !peerConnection) return;

        const candidate = new RTCIceCandidate({
            candidate: message.candidate,
            sdpMid: message.sdpMid,
            sdpMLineIndex: message.sdpMLineIndex
        });

        if (!peerConnection.remoteDescription) {
            remoteCandidatesQueue.push(candidate);

            wlog(
                "[ICE] Candidate queued:",
                remoteCandidatesQueue.length
            );

            return;
        }

        await peerConnection.addIceCandidate(candidate);
        wlog("[ICE] Remote candidate added");
    } catch (error) {
        console.error("[ICE] Failed to add candidate:", error);
    }
}

async function flushRemoteCandidates() {
    if (!peerConnection || !peerConnection.remoteDescription) return;

    const queuedCandidates = remoteCandidatesQueue.splice(0);

    for (const candidate of queuedCandidates) {
        try {
            if (!peerConnection || viewerRejected) return;

            await peerConnection.addIceCandidate(candidate);
            wlog("[ICE] Queued candidate added");
        } catch (error) {
            console.error("[ICE] Failed to add queued candidate:", error);
        }
    }
}

// ============================================================
// STOP WEBRTC
// ============================================================

function stopPeerConnection() {
    stopLineCallPolling();
    stopStatsMonitoring();

    if (peerConnection) {
        peerConnection.ontrack = null;
        peerConnection.onicecandidate = null;
        peerConnection.onconnectionstatechange = null;
        peerConnection.oniceconnectionstatechange = null;

        peerConnection.close();
        peerConnection = null;
    }

    remoteCandidatesQueue = [];
    lastStats = null;
    renderedFrames = 0;
    lastFPSCheck = performance.now();

    stopFrameCounting();

    if (videoElement) {
        videoElement.pause();
        videoElement.srcObject = null;
    }

    if (fpsElement) {
        fpsElement.textContent = `FPS: -- / ${TARGET_FPS}`;
    }

    producerId = null;
}

// ============================================================
// RENDERED FPS COUNTER
// ============================================================

function updateFPS() {
    const now = performance.now();
    const elapsed = now - lastFPSCheck;

    if (
        !videoElement.srcObject ||
        videoElement.paused
    ) {
        renderedFrames = 0;
        lastFPSCheck = now;
        return;
    }

    if (elapsed <= 0) {
        return;
    }

    const fps = renderedFrames * 1000 / elapsed;

    if (fpsElement) {
        const currentFPS = fps.toFixed(1);

        const targetStatus =
            fps >= TARGET_FPS - 0.5 ? "TARGET" : "BELOW TARGET";

        fpsElement.textContent =
            `FPS: ${currentFPS} / ${TARGET_FPS} (${targetStatus})`;
    }

    renderedFrames = 0;
    lastFPSCheck = now;
}

// ============================================================
// VIDEO FRAME COUNTING
// ============================================================

function countVideoFrame() {
    if (
        viewerRejected ||
        !videoElement.srcObject ||
        videoElement.paused ||
        videoElement.ended
    ) {
        videoFrameCallbackId = null;
        return;
    }

    renderedFrames++;

    videoFrameCallbackId =
        videoElement.requestVideoFrameCallback(countVideoFrame);
}

function startFrameCounting() {
    if (
        !("requestVideoFrameCallback" in HTMLVideoElement.prototype) ||
        videoFrameCallbackId !== null ||
        !videoElement.srcObject ||
        videoElement.paused
    ) {
        return;
    }

    videoFrameCallbackId =
        videoElement.requestVideoFrameCallback(countVideoFrame);
}

function stopFrameCounting() {
    if (
        videoFrameCallbackId !== null &&
        typeof videoElement.cancelVideoFrameCallback === "function"
    ) {
        videoElement.cancelVideoFrameCallback(videoFrameCallbackId);
    }

    videoFrameCallbackId = null;
}

if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
    videoElement.addEventListener("playing", () => {
        renderedFrames = 0;
        lastFPSCheck = performance.now();
        startFrameCounting();
    });

    videoElement.addEventListener("pause", stopFrameCounting);
    videoElement.addEventListener("ended", stopFrameCounting);
} else {
    console.warn(
        "[Video] requestVideoFrameCallback unsupported; using fallback"
    );

    let lastMediaTime = -1;

    videoElement.addEventListener("timeupdate", () => {
        if (
            !videoElement.paused &&
            videoElement.currentTime !== lastMediaTime
        ) {
            lastMediaTime = videoElement.currentTime;
            renderedFrames++;
        }
    });
}

fpsIntervalId = setInterval(updateFPS, 1000);

// ============================================================
// WEBRTC STATS
// ============================================================

function startStatsMonitoring() {
    if (!WEBRTC_DEBUG) return;
    if (statsIntervalId !== null) return;

    statsIntervalId = setInterval(
        logWebRTCStats,
        STATS_INTERVAL_MS
    );

    logWebRTCStats();
}

function stopStatsMonitoring() {
    if (statsIntervalId !== null) {
        clearInterval(statsIntervalId);
        statsIntervalId = null;
    }
}

async function logWebRTCStats() {
    const pc = peerConnection;

    if (
        !pc ||
        viewerRejected ||
        pc.connectionState === "closed"
    ) {
        return;
    }

    try {
        const stats = await pc.getStats();

        let inboundVideo = null;
        let selectedCandidatePair = null;
        let transportStats = null;

        stats.forEach((report) => {
            if (
                report.type === "inbound-rtp" &&
                (report.kind === "video" || report.mediaType === "video")
            ) {
                inboundVideo = report;
            }

            if (
                report.type === "transport" &&
                report.selectedCandidatePairId
            ) {
                transportStats = stats.get(
                    report.selectedCandidatePairId
                );
            }

            if (
                report.type === "candidate-pair" &&
                report.state === "succeeded" &&
                report.nominated
            ) {
                if (
                    !selectedCandidatePair ||
                    (report.bytesReceived || 0) >
                    (selectedCandidatePair.bytesReceived || 0)
                ) {
                    selectedCandidatePair = report;
                }
            }
        });

        if (transportStats) {
            selectedCandidatePair = transportStats;
        }

        if (inboundVideo) {
            const receivedFPS =
                inboundVideo.framesPerSecond ?? null;

            const framesReceived =
                inboundVideo.framesReceived ?? null;

            const framesDecoded =
                inboundVideo.framesDecoded ?? null;

            const framesDropped =
                inboundVideo.framesDropped ?? null;

            const packetsLost =
                inboundVideo.packetsLost ?? null;

            const jitter =
                inboundVideo.jitter ?? null;

            const width =
                inboundVideo.frameWidth ?? null;

            const height =
                inboundVideo.frameHeight ?? null;

            let bitrateKbps = null;

            if (
                lastStats &&
                lastStats.timestamp &&
                inboundVideo.bytesReceived !== undefined
            ) {
                const elapsedSeconds =
                    (inboundVideo.timestamp - lastStats.timestamp) / 1000;

                const bytesDelta =
                    inboundVideo.bytesReceived - lastStats.bytesReceived;

                if (elapsedSeconds > 0 && bytesDelta >= 0) {
                    bitrateKbps =
                        (bytesDelta * 8) / elapsedSeconds / 1000;
                }
            }

            lastStats = {
                timestamp: inboundVideo.timestamp,
                bytesReceived: inboundVideo.bytesReceived || 0
            };

            console.log("[Stats] Incoming video", {
                receivedFPS,
                framesReceived,
                framesDecoded,
                framesDropped,
                packetsLost,
                jitterMs: jitter !== null
                    ? (jitter * 1000).toFixed(1)
                    : null,
                resolution: width && height
                    ? `${width}x${height}`
                    : "Unknown",
                bitrateKbps: bitrateKbps !== null
                    ? bitrateKbps.toFixed(0)
                    : "Measuring..."
            });
        } else {
            console.log("[Stats] Waiting for inbound video stats");
        }

        if (selectedCandidatePair) {
            console.log("[Stats] Selected connection", {
                currentRoundTripTimeMs:
                    selectedCandidatePair.currentRoundTripTime !== undefined
                        ? (
                            selectedCandidatePair.currentRoundTripTime * 1000
                        ).toFixed(1)
                        : "Unknown",
                availableIncomingBitrateKbps:
                    selectedCandidatePair.availableIncomingBitrate !== undefined
                        ? (
                            selectedCandidatePair.availableIncomingBitrate / 1000
                        ).toFixed(0)
                        : "Unknown",
                localCandidateType:
                    selectedCandidatePair.localCandidateId
                        ? stats.get(
                            selectedCandidatePair.localCandidateId
                        )?.candidateType
                        : "Unknown",
                remoteCandidateType:
                    selectedCandidatePair.remoteCandidateId
                        ? stats.get(
                            selectedCandidatePair.remoteCandidateId
                        )?.candidateType
                        : "Unknown"
            });
        }
    } catch (error) {
        console.error("[Stats] Failed to collect WebRTC stats:", error);
    }
}

// ============================================================
// LINE CALL CONFIGURATION
// ============================================================

// Polling stays disabled; events arrive through the WebSocket push.
const LINECALL_POLLING_ENABLED = false;

const LINECALL_API_BASE =
    "http://13.60.246.31:8000";

if (
    window.location.protocol === "https:" &&
    LINECALL_API_BASE.startsWith("http://")
) {
    console.error(
        "[LineCall] Viewer is HTTPS but LINECALL_API_BASE is HTTP. " +
        "The browser will block these requests as mixed content."
    );
}

const LINECALL_SHOW_MS = 2000;
const LINECALL_MIN_GAP_MS = 500;
const LINECALL_ERROR_RETRY_MS = 300;
const LINECALL_REQUEST_TIMEOUT_MS = 5000;

const lineCallElement =
    document.getElementById("lineCall");

const lineCallResultElement =
    document.getElementById("lineCallResult");

const lineCallDetailElement =
    document.getElementById("lineCallDetail");

const replaysListElement =
    document.getElementById("replaysList");

const replaysEmptyElement =
    document.getElementById("replaysEmpty");

const courtMapWrapElement =
    document.getElementById("courtMapWrap");

const courtMapEmptyElement =
    document.getElementById("courtMapEmpty");

dlog("[LineCall] DOM elements found:", {
    lineCallElement: !!lineCallElement,
    lineCallResultElement: !!lineCallResultElement,
    lineCallDetailElement: !!lineCallDetailElement,
    replaysListElement: !!replaysListElement,
    replaysEmptyElement: !!replaysEmptyElement,
    courtMapWrapElement: !!courtMapWrapElement,
    courtMapEmptyElement: !!courtMapEmptyElement
});

let lastLineCallEventId = null;
let lineCallFirstPoll = true;
let lineCallHideTimer = null;

let lineCallLoopRunning = false;
let lineCallLoopId = 0;
let activeLineCallController = null;
let lineCallPollCount = 0;

function isLoopActive(loopId) {
    return (
        lineCallLoopRunning &&
        loopId === lineCallLoopId
    );
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Only valid HTTPS URLs are allowed for replay.
function getSafeClipUrl(rawUrl) {
    if (typeof rawUrl !== "string" || !rawUrl) {
        return null;
    }

    try {
        const parsed = new URL(rawUrl);

        if (parsed.protocol !== "https:") {
            console.warn(
                "[LineCall] Ignoring non-HTTPS clip URL:",
                rawUrl
            );
            return null;
        }

        return parsed.href;
    } catch (error) {
        console.warn(
            "[LineCall] Ignoring invalid clip URL:",
            rawUrl
        );
        return null;
    }
}

// A bounce is identified by its type or categories.
function isBounceEvent(event) {
    if (!event || typeof event !== "object") {
        return false;
    }

    if (
        String(event.type || "").toLowerCase() === "bounce"
    ) {
        return true;
    }

    if (
        Array.isArray(event.categories) &&
        event.categories.some(
            category => String(category).toLowerCase() === "bounce"
        )
    ) {
        return true;
    }

    return false;
}

function hideLineCall() {
    dlog("[LineCall] Hiding badge (timer expired).");

    if (lineCallElement) {
        lineCallElement.classList.remove("show");
    }
}

// ============================================================
// 2D BOUNCE MAP
// ============================================================

const COURT_MAP_SCALE = 10;
const MAX_MAP_DOTS = 300;

const DEFAULT_COURT_DIMENSIONS = {
    court_w_ft: 20,
    court_h_ft: 44,
    net_offset: 22,
    kitchen_ft: 7
};

let courtMapDims = null;
let courtMapSvgElement = null;
let courtMapDotsGroup = null;

function dimensionsChanged(a, b) {
    if (!a || !b) {
        return true;
    }

    return (
        a.court_w_ft !== b.court_w_ft ||
        a.court_h_ft !== b.court_h_ft ||
        a.net_offset !== b.net_offset ||
        a.kitchen_ft !== b.kitchen_ft
    );
}

function buildCourtMap(dims) {
    if (!courtMapWrapElement) {
        console.warn("[CourtMap] Court map container not found.");
        return;
    }

    dlog("[CourtMap] Building court map:", dims);

    courtMapDims = { ...dims };

    const w = dims.court_w_ft * COURT_MAP_SCALE;
    const h = dims.court_h_ft * COURT_MAP_SCALE;

    const netY = dims.net_offset * COURT_MAP_SCALE;

    const kitchenTopY =
        (dims.net_offset - dims.kitchen_ft) * COURT_MAP_SCALE;

    const kitchenBottomY =
        (dims.net_offset + dims.kitchen_ft) * COURT_MAP_SCALE;

    const centerX = w / 2;
    const svgNS = "http://www.w3.org/2000/svg";

    const svg = document.createElementNS(svgNS, "svg");

    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

    function addLine(cls, x1, y1, x2, y2) {
        const line = document.createElementNS(svgNS, "line");

        line.setAttribute("class", cls);
        line.setAttribute("x1", x1);
        line.setAttribute("y1", y1);
        line.setAttribute("x2", x2);
        line.setAttribute("y2", y2);

        svg.appendChild(line);
    }

    const outline = document.createElementNS(svgNS, "rect");

    outline.setAttribute("class", "court-map-outline");
    outline.setAttribute("x", 1);
    outline.setAttribute("y", 1);
    outline.setAttribute("width", Math.max(0, w - 2));
    outline.setAttribute("height", Math.max(0, h - 2));

    svg.appendChild(outline);

    addLine("court-map-net", 0, netY, w, netY);
    addLine("court-map-kitchen", 0, kitchenTopY, w, kitchenTopY);
    addLine("court-map-kitchen", 0, kitchenBottomY, w, kitchenBottomY);

    addLine("court-map-center", centerX, 0, centerX, kitchenTopY);
    addLine("court-map-center", centerX, kitchenBottomY, centerX, h);

    const dotsGroup = document.createElementNS(svgNS, "g");
    dotsGroup.setAttribute("id", "courtMapDots");

    svg.appendChild(dotsGroup);

    courtMapWrapElement.innerHTML = "";
    courtMapWrapElement.appendChild(svg);

    courtMapSvgElement = svg;
    courtMapDotsGroup = dotsGroup;
}

function addCourtMapDot(event, result) {
    const courtLocation = event.court_location;

    if (
        !courtLocation ||
        typeof courtLocation.x !== "number" ||
        typeof courtLocation.y !== "number" ||
        !Number.isFinite(courtLocation.x) ||
        !Number.isFinite(courtLocation.y)
    ) {
        console.warn(
            "[CourtMap] Bounce has no usable court_location; skipping map point.",
            event
        );
        return;
    }

    const suppliedDims = event.court_dimensions;

    const dims = suppliedDims &&
        typeof suppliedDims.court_w_ft === "number" &&
        typeof suppliedDims.court_h_ft === "number" &&
        typeof suppliedDims.net_offset === "number" &&
        typeof suppliedDims.kitchen_ft === "number"
        ? suppliedDims
        : (courtMapDims || DEFAULT_COURT_DIMENSIONS);

    if (
        !courtMapSvgElement ||
        dimensionsChanged(dims, courtMapDims)
    ) {
        buildCourtMap(dims);
    }

    if (!courtMapDotsGroup) {
        return;
    }

    const marginFt = 2.5;

    const clampedX = Math.max(
        -marginFt,
        Math.min(courtMapDims.court_w_ft + marginFt, courtLocation.x)
    );

    const clampedY = Math.max(
        -marginFt,
        Math.min(courtMapDims.court_h_ft + marginFt, courtLocation.y)
    );

    const cx = clampedX * COURT_MAP_SCALE;
    const cy = clampedY * COURT_MAP_SCALE;

    const svgNS = "http://www.w3.org/2000/svg";
    const dot = document.createElementNS(svgNS, "circle");

    const dotClass =
        ["in", "out", "uncertain"].includes(result)
            ? result
            : "out";

    dot.setAttribute("class", `court-map-dot ${dotClass} new`);
    dot.setAttribute("cx", cx);
    dot.setAttribute("cy", cy);
    dot.setAttribute("r", 4.5);

    const title = document.createElementNS(svgNS, "title");

    const titleParts = [
        dotClass.toUpperCase(),
        event.nearest_line,
        typeof event.nearest_line_distance === "number"
            ? `${event.nearest_line_distance} ft from line`
            : null
    ].filter(Boolean);

    title.textContent = titleParts.join(" · ");
    dot.appendChild(title);

    courtMapDotsGroup.appendChild(dot);

    while (courtMapDotsGroup.childNodes.length > MAX_MAP_DOTS) {
        courtMapDotsGroup.removeChild(courtMapDotsGroup.firstChild);
    }

    setTimeout(() => dot.classList.remove("new"), 600);

    if (courtMapEmptyElement) {
        courtMapEmptyElement.style.display = "none";
    }

    dlog("[CourtMap] Plotted bounce:", {
        x: courtLocation.x,
        y: courtLocation.y,
        result: dotClass
    });
}

// ============================================================
// REPLAY LIST
// ============================================================

const MAX_REPLAYS = 40;
const REPLAY_PRELOAD = "none";

let totalCalls = 0;

async function downloadClip(clipUrl, button) {
    if (button.classList.contains("busy")) {
        return;
    }

    let fileName = "line-call-clip.mov";

    try {
        fileName = decodeURIComponent(
            clipUrl.split("?")[0].split("/").pop() || fileName
        );
    } catch (error) {
        // Use the fallback filename.
    }

    dlog("[Replay] Downloading clip:", clipUrl);

    button.classList.add("busy");
    button.textContent = "...";

    try {
        const response = await fetch(clipUrl);

        if (!response.ok) {
            throw new Error(`Download returned ${response.status}`);
        }

        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);

        const link = document.createElement("a");

        link.href = blobUrl;
        link.download = fileName;

        document.body.appendChild(link);
        link.click();
        link.remove();

        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    } catch (error) {
        console.warn(
            "[Replay] Download failed; opening clip in a new tab:",
            error
        );

        window.open(clipUrl, "_blank", "noopener");
    } finally {
        button.classList.remove("busy");
        button.textContent = "⬇";
    }
}

function addReplay(clipUrl, callNumber, result) {
    if (!replaysListElement || !replaysEmptyElement) {
        console.warn("[Replay] Replay container not found.");
        return;
    }

    dlog("[Replay] Adding replay card:", callNumber, clipUrl);

    const card = document.createElement("div");

    card.className = "replay-card";
    card.dataset.result = result || "";

    const video = document.createElement("video");

    video.controls = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = REPLAY_PRELOAD;
    video.src =
        REPLAY_PRELOAD === "none"
            ? clipUrl
            : clipUrl + "#t=0.1";

    video.addEventListener("error", () => {
        console.warn(
            "[Replay] Video playback failed; showing link instead:",
            clipUrl
        );

        const fallback = document.createElement("a");

        fallback.className = "replay-fallback";
        fallback.href = clipUrl;
        fallback.target = "_blank";
        fallback.rel = "noopener";
        fallback.textContent = "Open clip";

        video.replaceWith(fallback);
    });

    const footer = document.createElement("div");
    footer.className = "replay-footer";

    const title = document.createElement("span");
    title.className = "replay-title";
    title.textContent = `Call #${callNumber}`;

    const downloadButton = document.createElement("button");

    downloadButton.type = "button";
    downloadButton.className = "replay-download";
    downloadButton.title = "Download clip";
    downloadButton.textContent = "⬇";

    downloadButton.addEventListener(
        "click",
        () => downloadClip(clipUrl, downloadButton)
    );

    footer.appendChild(title);
    footer.appendChild(downloadButton);

    card.appendChild(video);
    card.appendChild(footer);

    replaysListElement.appendChild(card);
    replaysEmptyElement.style.display = "none";

    while (replaysListElement.children.length > MAX_REPLAYS) {
        replaysListElement.removeChild(replaysListElement.firstChild);
    }
}

// ============================================================
// EVENT DISPLAY LOGIC
//
// Flow confirmed by the client:
//   - A NORMAL bounce (confidence_level === "high") only updates
//     the 2D map. No badge, no replay card.
//   - An UNCERTAIN bounce (confidence_level is present and is NOT
//     "high") updates the map AND shows the big centered badge AND
//     adds a replay card — but only if it has a usable clip URL
//     (no clip = nothing to replay, so the badge is skipped too).
// ============================================================

function showLineCall(event) {
    if (!event || typeof event !== "object") {
        console.warn("[LineCall] Ignoring invalid event:", event);
        return;
    }

    dlog("[LineCall] Received event:", event);

    const rawResult = String(event.in_out || "").toLowerCase();
    const confidence = String(event.confidence_level || "").toLowerCase();

    const isBounce = isBounceEvent(event);
    const isUncertain = !!confidence && confidence !== "high";
    const clipUrl = getSafeClipUrl(event.url);

    // --------------------------------------------------------
    // MAP: EVERY BOUNCE, uncertain or not, with or without a clip.
    // --------------------------------------------------------

    if (isBounce) {
        const mapResult = ["in", "out"].includes(rawResult)
            ? rawResult
            : (isUncertain ? "uncertain" : "out");

        addCourtMapDot(event, mapResult);
    }

    // --------------------------------------------------------
    // BADGE + REPLAY: only an UNCERTAIN bounce with a clip URL.
    // A normal (high-confidence) bounce never shows a badge.
    // --------------------------------------------------------

    const shouldShowUncertain =
        isBounce &&
        isUncertain &&
        !!clipUrl;

    if (!shouldShowUncertain) {
        dlog("[LineCall] Badge/replay suppressed:", {
            event_id: event.event_id,
            isBounce,
            isUncertain,
            hasClipUrl: !!clipUrl
        });

        return;
    }

    if (
        !lineCallElement ||
        !lineCallResultElement ||
        !lineCallDetailElement
    ) {
        console.warn("[LineCall] Badge elements not found.");
        return;
    }

    lineCallElement.dataset.result = "uncertain";

    lineCallResultElement.textContent =
        `UNCERTAIN ${rawResult.toUpperCase() || "BOUNCE"}`;

    const details = [];

    if (event.nearest_line) {
        details.push(event.nearest_line);
    }

    if (typeof event.nearest_line_distance === "number") {
        details.push(`${event.nearest_line_distance} ft`);
    }

    lineCallDetailElement.textContent = details.join(" · ");
    lineCallElement.classList.add("show");

    totalCalls++;

    addReplay(clipUrl, totalCalls, "uncertain");

    clearTimeout(lineCallHideTimer);

    dlog(
        "[LineCall] UNCERTAIN badge will auto-hide after",
        LINECALL_SHOW_MS,
        "ms"
    );

    lineCallHideTimer = setTimeout(
        hideLineCall,
        LINECALL_SHOW_MS
    );
}

// ============================================================
// OPTIONAL LINECALL API POLLING
// ============================================================

async function pollLineCallOnce(loopId) {
    if (!isLoopActive(loopId)) {
        dlog("[LineCall] Skipping poll; loop is inactive.");
        return;
    }

    lineCallPollCount++;

    const controller = new AbortController();
    activeLineCallController = controller;

    const timeout = setTimeout(
        () => controller.abort(),
        LINECALL_REQUEST_TIMEOUT_MS
    );

    try {
        const url =
            `${LINECALL_API_BASE}/tracknet/realtime/notifications/` +
            `${encodeURIComponent(sessionId)}/latest`;

        dlog(`[LineCall] API HIT #${lineCallPollCount}:`, url);

        const response = await fetch(url, {
            cache: "no-store",
            signal: controller.signal
        });

        dlog(
            `[LineCall] API response status #${lineCallPollCount}:`,
            response.status
        );

        if (!isLoopActive(loopId)) {
            dlog("[LineCall] Loop stopped; discarding response.");
            return;
        }

        if (response.status === 404) {
            dlog("[LineCall] No event available yet.");
            lineCallFirstPoll = false;
            return;
        }

        if (!response.ok) {
            throw new Error(`API returned ${response.status}`);
        }

        const data = await response.json();

        if (!isLoopActive(loopId)) {
            dlog("[LineCall] Loop stopped while parsing; discarding response.");
            return;
        }

        dlog("[LineCall] Raw response:", data);

        const isEmptyObject =
            data &&
            typeof data === "object" &&
            !Array.isArray(data) &&
            Object.keys(data).length === 0;

        if (isEmptyObject) {
            lineCallFirstPoll = false;
            return;
        }

        const event =
            data && data.event_id
                ? data
                : (data && (data.event || data.data)) || null;

        if (!event || !event.event_id) {
            console.warn(
                "[LineCall] No usable event_id in API response:",
                data
            );

            lineCallFirstPoll = false;
            return;
        }

        if (lineCallFirstPoll) {
            lineCallFirstPoll = false;
            lastLineCallEventId = event.event_id;

            dlog(
                "[LineCall] Initial event remembered, not displayed:",
                event.event_id
            );

            return;
        }

        if (event.event_id !== lastLineCallEventId) {
            lastLineCallEventId = event.event_id;

            console.log("[LineCall] NEW EVENT DETECTED:", event);
            showLineCall(event);
        }
    } finally {
        clearTimeout(timeout);

        if (activeLineCallController === controller) {
            activeLineCallController = null;
        }
    }
}

// ============================================================
// PUSH MODE: SERVER -> WEBSOCKET -> VIEWER
// ============================================================

function handlePushedLineCall(event, isInitial) {
    if (!event || !event.event_id) {
        console.warn("[LineCall] Pushed event has no event_id:", event);
        return;
    }

    if (isInitial) {
        lastLineCallEventId = event.event_id;

        dlog(
            "[LineCall] Latest event remembered, not displayed:",
            event.event_id
        );

        return;
    }

    if (event.event_id === lastLineCallEventId) {
        dlog("[LineCall] Duplicate event ignored:", event.event_id);
        return;
    }

    lastLineCallEventId = event.event_id;

    console.log("[LineCall] NEW EVENT (pushed):", event);
    showLineCall(event);
}

// ============================================================
// POLLING START / STOP
// ============================================================

function startLineCallPolling() {
    if (!LINECALL_POLLING_ENABLED) {
        console.log("[LineCall] Polling disabled; using WebSocket push.");
        return;
    }

    if (!sessionId) return;
    if (lineCallLoopRunning) return;

    console.log("[LineCall] Starting API polling");
    dlog("[LineCall] Session ID:", sessionId);

    dlog("[LineCall] Config:", {
        LINECALL_API_BASE,
        LINECALL_SHOW_MS,
        LINECALL_MIN_GAP_MS,
        LINECALL_ERROR_RETRY_MS,
        LINECALL_REQUEST_TIMEOUT_MS
    });

    lineCallLoopRunning = true;
    lineCallPollCount = 0;
    lineCallFirstPoll = true;

    lineCallLoopId++;
    lineCallLoop(lineCallLoopId);
}

function stopLineCallPolling() {
    if (!lineCallLoopRunning) {
        if (activeLineCallController) {
            activeLineCallController.abort();
            activeLineCallController = null;
        }

        return;
    }

    console.log(
        "[LineCall] Stopping API polling. Polls:",
        lineCallPollCount
    );

    lineCallLoopRunning = false;

    if (activeLineCallController) {
        activeLineCallController.abort();
        activeLineCallController = null;
    }
}

async function lineCallLoop(myLoopId) {
    dlog("[LineCall] Polling loop starting:", myLoopId);

    while (isLoopActive(myLoopId)) {
        try {
            await pollLineCallOnce(myLoopId);

            if (!isLoopActive(myLoopId)) {
                break;
            }

            if (LINECALL_MIN_GAP_MS > 0) {
                await sleep(LINECALL_MIN_GAP_MS);
            }
        } catch (error) {
            if (error && error.name === "AbortError") {
                if (!isLoopActive(myLoopId)) {
                    break;
                }

                console.warn(
                    "[LineCall] Request timed out; retrying..."
                );

                await sleep(LINECALL_ERROR_RETRY_MS);
                continue;
            }

            console.warn("[LineCall] Poll failed:", error);

            if (!isLoopActive(myLoopId)) {
                break;
            }

            await sleep(LINECALL_ERROR_RETRY_MS);
        }
    }

    dlog("[LineCall] Polling loop stopped:", myLoopId);
}

// ============================================================
// CLEANUP
// ============================================================

window.addEventListener("beforeunload", () => {
    stopPeerConnection();

    lineCallLoopRunning = false;

    if (activeLineCallController) {
        activeLineCallController.abort();
        activeLineCallController = null;
    }

    if (fpsIntervalId !== null) {
        clearInterval(fpsIntervalId);
        fpsIntervalId = null;
    }

    if (socket) {
        socket.close();
        socket = null;
    }
});