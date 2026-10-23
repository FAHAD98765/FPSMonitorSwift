// NOTE: named viewerParams (not params): index.html's inline script
// already declares a global "params", and declaring it twice stops
// this whole file from running.
const viewerParams = new URLSearchParams(window.location.search);
const sessionId =
    viewerParams.get("session") ||
    viewerParams.get("sessionId");

// ============================================================
// DEBUG FLAGS
//
// Both are OFF by default so the page stays smooth. Chrome
// serialises every logged object (especially with DevTools open),
// which keeps the main thread busy and competes with video
// decode/render. Errors, warnings and new line-call events are
// always logged, whatever these flags say.
//
//   LINECALL_DEBUG -> per-poll API logs, map / replay / badge details
//   WEBRTC_DEBUG   -> signaling + ICE chatter, and the once-a-second
//                     getStats() monitor
//
// To debug, change the one you need to true.
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
// ICE SERVERS - KEEP STUN + TURN FOR DIFFERENT NETWORKS
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

// Updates the green/amber/grey connection dot + the small
// "Connected"/"Connecting..."/"Disconnected" text in the footer.
// Defined by the inline script in index.html; safe to call even if
// that script hasn't run yet (checked each time).
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

                // Line calls pushed by the server (no polling needed).
                case "line-call":
                    handlePushedLineCall(message.event, false);
                    break;

                // The server's current latest event when we join or
                // reconnect: remembered as "old", not shown.
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

                // Video is live -> start polling for line calls.
                startLineCallPolling();
            })
            .catch((error) => {
                console.warn("[Video] Playback could not start:", error);

                if (!viewerRejected) {
                    setStatus("Tap the video to start playback");
                    setConnectionIndicator("connected");
                }

                // The WebRTC connection itself is still live even
                // though autoplay was blocked, so line calls should
                // keep coming in.
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

        // Apply ICE candidates that arrived before the offer was ready.
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
    // Line calls only make sense while connected to the stream.
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

    // Nothing is playing -> leave the "FPS: --" text alone and
    // skip the DOM write.
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

    // Fallback is approximate, not a reliable actual FPS measurement.
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

// Once a second is enough for the FPS text. (It used to run a
// callback on every screen frame, ~60 times a second.)
fpsIntervalId = setInterval(updateFPS, 1000);

// ============================================================
// WEBRTC STATS - RECEIVE FPS, DROPS, PACKET LOSS, RTT
// ============================================================

function startStatsMonitoring() {
    // getStats() every second + two console logs per tick is
    // debug-only work, skipped entirely unless WEBRTC_DEBUG is on.
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
// LINE CALL API
//
// Polls the tracking backend for the latest line call event while
// the viewer is connected, shows a big IN/OUT/UNCERTAIN badge on
// the video, adds a replay card (if the event has a clip), and
// plots the ball's landing spot on the 2D bounce map — but ONLY for
// events whose type/categories say "bounce" (see isBounceEvent()).
// Any other event type still shows the badge/replay, but is left
// off the map.
// ============================================================

// IMPORTANT: if this viewer page is served over HTTPS, this MUST be
// an https:// URL too (browsers block http:// requests from an
// https:// page = "mixed content"), and the API must allow this
// page's origin via CORS.
// TEST SWITCH: false = line call API is never hit (use this to check
// whether polling is what drops the FPS). Set back to true afterwards.
const LINECALL_POLLING_ENABLED = false;

const LINECALL_API_BASE =
    "http://13.60.246.31:8000";

if (
    window.location.protocol === "https:" &&
    LINECALL_API_BASE.startsWith("http://")
) {
    console.error(
        "[LineCall] ❌ Viewer is on HTTPS but LINECALL_API_BASE is HTTP. " +
        "The browser will block line call requests (mixed content). " +
        "Serve the API over HTTPS."
    );
}

const LINECALL_SHOW_MS = 2000;
// Pause between polls. 500ms is plenty for line calls and keeps
// the page quiet (it was 200ms = ~5 requests every second).
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

dlog(
    "[LineCall] DOM elements found:",
    {
        lineCallElement: !!lineCallElement,
        lineCallResultElement: !!lineCallResultElement,
        lineCallDetailElement: !!lineCallDetailElement,
        replaysListElement: !!replaysListElement,
        replaysEmptyElement: !!replaysEmptyElement,
        courtMapWrapElement: !!courtMapWrapElement,
        courtMapEmptyElement: !!courtMapEmptyElement
    }
);

let lastLineCallEventId = null;
let lineCallFirstPoll = true;
let lineCallHideTimer = null;

// Not a session ID — just whether the polling loop is running.
let lineCallLoopRunning = false;

// Every startLineCallPolling() call gets a new loop ID; an older
// loop still winding down notices it's stale and exits, so a quick
// disconnect -> reconnect never runs two loops at once.
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

// Only https:// links are accepted for a clip, so a bad/odd API
// value (e.g. "javascript:...") can never reach <video src> or
// <a href>.
function getSafeClipUrl(rawUrl) {
    if (typeof rawUrl !== "string" || !rawUrl) {
        return null;
    }

    try {
        const parsed = new URL(rawUrl);

        if (parsed.protocol !== "https:") {
            console.warn(
                "[LineCall] Ignoring non-https clip url:",
                rawUrl
            );
            return null;
        }

        return parsed.href;

    } catch (error) {
        console.warn(
            "[LineCall] Ignoring invalid clip url:",
            rawUrl
        );
        return null;
    }
}

// An event counts as a "bounce" (and therefore gets plotted on the
// 2D map) if its type is "bounce" or its categories list includes
// "bounce". Everything else (badge + replay) still shows normally,
// it's just left off the court map.
function isBounceEvent(event) {
    if (event.type === "bounce") {
        return true;
    }

    if (
        Array.isArray(event.categories) &&
        event.categories.includes("bounce")
    ) {
        return true;
    }

    return false;
}

function hideLineCall() {
    dlog("[LineCall] Hiding badge (timer expired).");

    lineCallElement.classList.remove("show");
}

// ============================================================
// 2D BOUNCE MAP
//
// Every bounce stays on the map for the whole session (unlike the
// badge above, which auto-hides). Court size comes from the
// backend's court_dimensions (court_w_ft, court_h_ft, net_offset,
// kitchen_ft) on the event itself, not a hardcoded size, and the
// map rebuilds itself if those numbers ever change mid-session.
// ============================================================

const COURT_MAP_SCALE = 10; // SVG units per foot

// Keeps the SVG light on very long sessions (oldest dots go first).
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
    dlog(
        "[CourtMap] Building court map with dimensions:",
        dims
    );

    courtMapDims = dims;

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

    // No center line inside the kitchen itself, only net-to-kitchen
    // on each side.
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
        !isFinite(courtLocation.x) ||
        !isFinite(courtLocation.y)
    ) {
        console.warn(
            "[CourtMap] Event has no usable court_location, skipping dot.",
            event
        );
        return;
    }

    const dims =
        event.court_dimensions ||
        courtMapDims ||
        DEFAULT_COURT_DIMENSIONS;

    if (
        !courtMapSvgElement ||
        dimensionsChanged(dims, courtMapDims)
    ) {
        buildCourtMap(dims);
    }

    // A small margin outside the lines so an OUT ball is visibly
    // outside instead of being squashed onto the edge.
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

    courtMapEmptyElement.style.display = "none";

    dlog("[CourtMap] 🟢 Plotted bounce:", {
        x: courtLocation.x,
        y: courtLocation.y,
        result: dotClass
    });
}

// ============================================================
// REPLAY LIST
// ============================================================

const MAX_REPLAYS = 40;

// "none": a new clip does NOT start downloading by itself. The clips
// are .mov files, and downloading them while the live stream is
// running steals bandwidth and makes the live video stutter every
// time a line call arrives. A clip loads when you press play.
// Use "metadata" if you want a thumbnail frame on every card
// (costs bandwidth + decoder memory for each clip).
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
        // Keep the default file name.
    }

    dlog("[Replay] ⬇ Downloading clip:", clipUrl);

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
        // Usually CORS: the S3 bucket doesn't allow this origin.
        console.warn(
            "[Replay] ⬇ fetch download failed, opening in new tab:",
            error
        );

        window.open(clipUrl, "_blank", "noopener");

    } finally {
        button.classList.remove("busy");
        button.textContent = "⬇";
    }
}

function addReplay(clipUrl, callNumber, result) {
    dlog("[Replay] 🎬 Adding replay card:", callNumber, clipUrl);

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
            "[Replay] Clip <video> errored (unsupported format?), showing link instead:",
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

function showLineCall(event) {
    dlog("[LineCall] 📣 Displaying event on screen:", event);

    const rawResult =
        String(event.in_out || "").toLowerCase();

    const isUncertain =
        !!event.confidence_level &&
        event.confidence_level !== "high";

    const result = isUncertain ? "uncertain" : rawResult;

    dlog("[LineCall] Result resolution:", {
        rawResult,
        confidence_level: event.confidence_level,
        isUncertain,
        result
    });

    lineCallElement.dataset.result =
        ["in", "out", "uncertain"].includes(result) ? result : "";

    const labelText =
        isUncertain
            ? `UNCERTAIN ${rawResult.toUpperCase()}`
            : (
                rawResult
                    ? rawResult.toUpperCase()
                    : String(event.type || "EVENT").toUpperCase()
            );

    lineCallResultElement.textContent = labelText;

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

    // Only plot BOUNCE events on the 2D map.
    if (isBounceEvent(event)) {
        addCourtMapDot(event, result);
    } else {
        dlog(
            "[CourtMap] Skipping non-bounce event (type:",
            event.type,
            ", categories:",
            event.categories,
            ")"
        );
    }

    const clipUrl = getSafeClipUrl(event.url);

    if (clipUrl) {
        addReplay(clipUrl, totalCalls, result);
    }

    clearTimeout(lineCallHideTimer);

    dlog(
        "[LineCall] Badge will auto-hide after",
        LINECALL_SHOW_MS,
        "ms"
    );

    lineCallHideTimer = setTimeout(hideLineCall, LINECALL_SHOW_MS);
}

async function pollLineCallOnce(loopId) {
    if (!isLoopActive(loopId)) {
        dlog("[LineCall] Skipping poll, loop is not active.");
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
            dlog(
                "[LineCall] Loop stopped while request was in flight, discarding response."
            );
            return;
        }

        if (response.status === 404) {
            dlog(
                "[LineCall] 404 - no event available yet for this session."
            );
            lineCallFirstPoll = false;
            return;
        }

        if (!response.ok) {
            throw new Error(`API returned ${response.status}`);
        }

        const data = await response.json();

        if (!isLoopActive(loopId)) {
            dlog(
                "[LineCall] Loop stopped while parsing JSON, discarding response."
            );
            return;
        }

        dlog("[LineCall] Raw response:", data);

        // The API sometimes returns 200 with a plain empty object
        // ("{}") instead of a 404 when there's no event yet. Treat
        // that the same as a 404 instead of warning every poll.
        const isEmptyObject =
            data &&
            typeof data === "object" &&
            !Array.isArray(data) &&
            Object.keys(data).length === 0;

        if (isEmptyObject) {
            dlog(
                "[LineCall] Empty {} response - no event yet for this session."
            );
            lineCallFirstPoll = false;
            return;
        }

        const event =
            data && data.event_id
                ? data
                : (data && (data.event || data.data)) || null;

        if (!event || !event.event_id) {
            console.warn(
                "[LineCall] No usable event_id found in response. " +
                "Check the raw response logged above — the shape " +
                "may not match what the code expects.",
                data
            );

            lineCallFirstPoll = false;
            return;
        }

        dlog(
            "[LineCall] event_id from API:",
            event.event_id,
            "| last seen:",
            lastLineCallEventId,
            "| firstPoll:",
            lineCallFirstPoll,
            "| has clip url:",
            !!event.url
        );

        if (lineCallFirstPoll) {
            lineCallFirstPoll = false;
            lastLineCallEventId = event.event_id;

            dlog(
                "[LineCall] Initial event remembered (not shown):",
                event.event_id
            );
            return;
        }

        if (event.event_id !== lastLineCallEventId) {
            lastLineCallEventId = event.event_id;

            console.log("[LineCall] 🟢 NEW EVENT DETECTED:", event);

            showLineCall(event);

        } else {
            dlog(
                "[LineCall] Same event as last poll, nothing new. event_id:",
                event.event_id
            );
        }

    } finally {
        clearTimeout(timeout);

        if (activeLineCallController === controller) {
            activeLineCallController = null;
        }
    }
}

// ------------------------------------------------------------
// PUSH MODE: the server sends line calls over the WebSocket.
// ------------------------------------------------------------
function handlePushedLineCall(event, isInitial) {
    if (!event || !event.event_id) {
        console.warn("[LineCall] Pushed message had no event_id:", event);
        return;
    }

    if (isInitial) {
        lastLineCallEventId = event.event_id;
        dlog("[LineCall] Latest event remembered (not shown):", event.event_id);
        return;
    }

    if (event.event_id === lastLineCallEventId) {
        dlog("[LineCall] Duplicate pushed event ignored:", event.event_id);
        return;
    }

    lastLineCallEventId = event.event_id;

    console.log("[LineCall] 🟢 NEW EVENT (pushed):", event);

    showLineCall(event);
}

function startLineCallPolling() {
    if (!LINECALL_POLLING_ENABLED) {
        console.log("[LineCall] Polling DISABLED for FPS test");
        return;
    }

    if (!sessionId) {
        return;
    }

    if (lineCallLoopRunning) {
        dlog("[LineCall] Polling already running.");
        return;
    }

    console.log("[LineCall] 🟢 Starting API polling");
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

    // On every new connection, the current latest event is treated
    // as old; a genuinely newer event will still be shown.
    lineCallFirstPoll = true;

    // New loop ID -> any older loop still winding down will exit.
    lineCallLoopId++;

    lineCallLoop(lineCallLoopId);
}

function stopLineCallPolling() {
    if (!lineCallLoopRunning) {
        if (activeLineCallController) {
            dlog(
                "[LineCall] Loop already stopped, but aborting a stray in-flight request."
            );
            activeLineCallController.abort();
            activeLineCallController = null;
        }
        return;
    }

    console.log(
        "[LineCall] 🔴 Stopping API polling (total polls made:",
        lineCallPollCount,
        ")"
    );

    lineCallLoopRunning = false;

    if (activeLineCallController) {
        dlog("[LineCall] Aborting active API request...");
        activeLineCallController.abort();
        activeLineCallController = null;
    }

    // NOTE: we deliberately do NOT clear/hide the line call badge
    // here (replay cards and bounce-map dots are never removed). If
    // the badge is currently showing, it stays on screen (and still
    // auto-hides on its own normal timer from showLineCall) even
    // though the stream disconnected.
    dlog(
        "[LineCall] Leaving any currently visible line call as-is."
    );
}

async function lineCallLoop(myLoopId) {
    dlog("[LineCall] Polling loop starting. Loop ID:", myLoopId);

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

            // AbortError fires in TWO different situations, and they
            // must NOT be treated the same:
            //
            //   1) Disconnect -> stopLineCallPolling() calls
            //      activeLineCallController.abort() AND sets
            //      lineCallLoopRunning = false. Real stop, break.
            //
            //   2) Per-request timeout -> a single slow API
            //      response, the loop is still active. NOT a
            //      disconnect. Must keep polling.
            if (error && error.name === "AbortError") {
                if (!isLoopActive(myLoopId)) {
                    dlog("[LineCall] Request aborted (disconnect).");
                    break;
                }

                console.warn(
                    "[LineCall] Request timed out (>",
                    LINECALL_REQUEST_TIMEOUT_MS,
                    "ms), retrying..."
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

    dlog(
        "[LineCall] Polling loop stopped. Loop ID:",
        myLoopId,
        "| Total polls made:",
        lineCallPollCount
    );
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