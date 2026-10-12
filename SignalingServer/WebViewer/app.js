const viewerParams = new URLSearchParams(window.location.search);

const sessionId =
    viewerParams.get("session") ||
    viewerParams.get("sessionId") ||
    "fpsmonitor-session";

console.log(
    "[Init] Page loaded. URL params:",
    Object.fromEntries(viewerParams.entries())
);

console.log(
    "[Init] Resolved sessionId:",
    sessionId
);

const statusElement = document.getElementById("status");
const videoElement = document.getElementById("remoteVideo");
const fpsElement = document.getElementById("fps");

let socket = null;
let peerConnection = null;
let producerId = null;

// Set to true when the page is closing so the WebSocket
// auto-reconnect doesn't kick in.
let pageUnloading = false;

// ============================================================
// ICE CANDIDATE QUEUE
// ============================================================

let pendingIceCandidates = [];

// ============================================================
// FPS
// ============================================================

let renderedFrames = 0;
let lastFPSCheck = performance.now();

// ============================================================
// WEBRTC CONFIG - STUN + TURN
// ============================================================

let rtcConfig = {
    iceServers: [
        {
            urls: "stun:stun.l.google.com:19302"
        }
    ]
};

// ============================================================
// TURN - METERED
//
// NOTE: this API key is visible to anyone who opens the page.
// In the Metered dashboard, restrict it to your domain(s) or
// rotate it.
// ============================================================

async function fetchTurnCredentials() {
    try {
        console.log("[ICE] 🔄 Fetching TURN credentials from Metered...");

        const response = await fetch(
            "https://fpsmonitor-turn.metered.live/api/v1/turn/credentials?apiKey=64926152b434b88fcdf288be2869c08e12a1"
        );

        console.log("[ICE] API Response Status:", response.status);

        if (!response.ok) {
            throw new Error(`API returned ${response.status}`);
        }

        const turnServers = await response.json();

        console.log(
            "[ICE] TURN Servers Received:",
            turnServers
        );

        if (
            Array.isArray(turnServers) &&
            turnServers.length > 0
        ) {
            rtcConfig.iceServers = [
                {
                    urls: "stun:stun.l.google.com:19302"
                },
                ...turnServers
            ];

            console.log(
                "[ICE] ✅ Metered TURN Loaded! Config:",
                rtcConfig.iceServers
            );

            return true;
        }

        console.warn(
            "[ICE] ⚠️ No TURN servers returned"
        );

        return false;

    } catch (error) {

        console.error(
            "[ICE] ❌ Metered TURN Fetch Failed:",
            error
        );

        return false;
    }
}

// ============================================================
// FALLBACK TURN
// ============================================================

function useFallbackTurn() {

    console.log(
        "[ICE] 🔄 Switching to fallback OpenRelay TURN..."
    );

    rtcConfig.iceServers = [
        {
            urls: "stun:stun.l.google.com:19302"
        },
        {
            urls: "turn:openrelay.metered.ca:443?transport=tcp",
            username: "openrelayproject",
            credential: "openrelayproject"
        },
        {
            urls: "turn:openrelay.metered.ca:443?transport=udp",
            username: "openrelayproject",
            credential: "openrelayproject"
        }
    ];

    console.log(
        "[ICE] ✅ Fallback TURN Active! Config:",
        rtcConfig.iceServers
    );
}

// ============================================================
// INITIALIZE TURN
// ============================================================

async function initializeTurn() {

    console.log(
        "[ICE] Starting TURN initialization..."
    );

    const success =
        await fetchTurnCredentials();

    if (!success) {

        console.warn(
            "[ICE] Metered failed, using OpenRelay fallback"
        );

        useFallbackTurn();
    }
}

// ============================================================
// STATUS
// ============================================================

function setStatus(message) {

    statusElement.textContent = message;

    console.log(
        "[WebViewer]",
        message
    );
}

// ============================================================
// CONNECTION UI
//
// connected    -> green
// disconnected -> red
// connecting   -> amber
// ============================================================

let uiConnectionState = "connecting";

function updateConnectionUI(state) {

    console.log(
        "[UI] Connection state change:",
        uiConnectionState,
        "->",
        state
    );

    uiConnectionState = state;

    if (
        typeof window.setConnectionState === "function"
    ) {
        window.setConnectionState(state);
    } else {
        console.warn(
            "[UI] window.setConnectionState is not defined (index.html script missing?)"
        );
    }

    if (state !== "connected") {

        fpsElement.textContent = "FPS: --";
    }
}

// ============================================================
// TAP VIDEO TO START PLAYBACK
// (used when the browser blocked autoplay)
// ============================================================

videoElement.addEventListener(
    "click",
    () => {

        if (!videoElement.srcObject) {
            return;
        }

        videoElement
            .play()
            .then(() => {

                if (uiConnectionState === "connected") {
                    setStatus("LIVE");
                }
            })
            .catch((error) => {

                console.warn(
                    "[Video] Manual play failed:",
                    error
                );
            });
    }
);

// ============================================================
// START
// ============================================================

async function start() {

    if (!sessionId) {

        setStatus(
            "Missing session ID"
        );

        updateConnectionUI(
            "disconnected"
        );

        return;
    }

    console.log(
        "[Session] Using Session ID:",
        sessionId
    );

    updateConnectionUI(
        "connecting"
    );

    setStatus(
        "Initializing TURN..."
    );

    await initializeTurn();

    setStatus(
        `Connecting to session: ${sessionId}`
    );

    connectSignaling();
}

start();

// ============================================================
// WEBSOCKET SIGNALING
//
// Auto-reconnects with backoff (1s, 2s, 4s ... max 10s) and sends
// a ping every 25s so idle proxies don't drop the connection.
// ============================================================

const WS_PING_INTERVAL_MS = 25000;
const WS_RECONNECT_BASE_MS = 1000;
const WS_RECONNECT_MAX_MS = 10000;

let wsReconnectAttempts = 0;
let wsReconnectTimer = null;
let wsPingTimer = null;

function stopWsPing() {

    if (wsPingTimer) {

        clearInterval(wsPingTimer);

        wsPingTimer = null;
    }
}

function startWsPing(ws) {

    stopWsPing();

    wsPingTimer = setInterval(
        () => {

            if (
                ws.readyState === WebSocket.OPEN
            ) {

                ws.send(
                    JSON.stringify({
                        type: "ping"
                    })
                );
            }
        },
        WS_PING_INTERVAL_MS
    );
}

function scheduleSignalingReconnect() {

    if (
        pageUnloading ||
        wsReconnectTimer
    ) {
        return;
    }

    const delay =
        Math.min(
            WS_RECONNECT_BASE_MS *
                Math.pow(2, wsReconnectAttempts),
            WS_RECONNECT_MAX_MS
        );

    wsReconnectAttempts++;

    console.log(
        `[WS] Reconnecting in ${delay}ms (attempt ${wsReconnectAttempts})`
    );

    wsReconnectTimer =
        setTimeout(
            () => {

                wsReconnectTimer = null;

                connectSignaling();
            },
            delay
        );
}

function connectSignaling() {

    const protocol =
        window.location.protocol === "https:"
            ? "wss:"
            : "ws:";

    const wsURL =
        `${protocol}//${window.location.host}`;

    console.log(
        "[WS] Connecting:",
        wsURL
    );

    const ws = new WebSocket(wsURL);

    socket = ws;

    ws.onopen = () => {

        if (socket !== ws) {
            return;
        }

        console.log(
            "[WS] Connected"
        );

        wsReconnectAttempts = 0;

        startWsPing(ws);

        ws.send(
            JSON.stringify({
                type: "register",
                sessionId: sessionId,
                role: "viewer"
            })
        );

        console.log(
            "[WS] Sent register message for sessionId:",
            sessionId
        );

        // Don't overwrite a live video status.
        if (
            !peerConnection ||
            peerConnection.connectionState !== "connected"
        ) {

            setStatus(
                "Connected to signaling server. Waiting for host..."
            );
        }
    };

    ws.onmessage = async (event) => {

        if (socket !== ws) {
            return;
        }

        try {

            const message =
                JSON.parse(event.data);

            console.log(
                "[WS] Message:",
                message.type,
                message
            );

            switch (message.type) {

                case "registered":

                    console.log(
                        "[WS] Registered as viewer:",
                        message.clientId
                    );

                    break;

                case "producer-available":

                    console.log(
                        "[WS] Host/producer is available."
                    );

                    updateConnectionUI(
                        "connecting"
                    );

                    setStatus(
                        "Host available. Waiting for video..."
                    );

                    break;

                case "offer":

                    console.log(
                        "[WS] Received offer from host, handling..."
                    );

                    await handleOffer(
                        message
                    );

                    break;

                case "ice-candidate":

                    await handleRemoteCandidate(
                        message
                    );

                    break;

                case "producer-left":

                    console.log(
                        "[WS] Host/producer left the session."
                    );

                    stopPeerConnection();

                    updateConnectionUI(
                        "disconnected"
                    );

                    setStatus(
                        "Host disconnected"
                    );

                    break;

                case "error":

                    console.error(
                        "[WS] Server sent an error message:",
                        message.message
                    );

                    setStatus(
                        `Server error: ${message.message}`
                    );

                    break;

                case "pong":

                    break;

                default:

                    console.log(
                        "[WS] Unknown message:",
                        message
                    );
            }

        } catch (error) {

            console.error(
                "[WS] Message handling error:",
                error
            );
        }
    };

    ws.onerror = (error) => {

        if (socket !== ws) {
            return;
        }

        console.error(
            "[WS] Error:",
            error
        );

        if (
            !peerConnection ||
            peerConnection.connectionState !== "connected"
        ) {

            updateConnectionUI(
                "disconnected"
            );

            // IMPORTANT:
            // Stop API polling when connection is lost.
            stopLineCallPolling();
        }

        setStatus(
            "WebSocket connection error"
        );
    };

    ws.onclose = () => {

        if (socket !== ws) {
            return;
        }

        console.log(
            "[WS] Disconnected"
        );

        stopWsPing();

        if (
            !peerConnection ||
            peerConnection.connectionState !== "connected"
        ) {

            updateConnectionUI(
                "disconnected"
            );

            // IMPORTANT:
            // Stop API polling when connection is lost.
            stopLineCallPolling();
        }

        if (!pageUnloading) {

            setStatus(
                "Signaling server disconnected. Reconnecting..."
            );

            scheduleSignalingReconnect();
        }
    };
}

// ============================================================
// CREATE PEER CONNECTION
// ============================================================

async function createPeerConnection() {

    console.log(
        "[WebRTC] Creating PeerConnection with config:",
        rtcConfig
    );

    if (peerConnection) {

        console.log(
            "[WebRTC] Closing previous PeerConnection"
        );

        peerConnection.close();
    }

    peerConnection =
        new RTCPeerConnection(
            rtcConfig
        );

    // --------------------------------------------------------
    // REMOTE TRACK
    // --------------------------------------------------------

    peerConnection.ontrack = (event) => {

        console.log(
            "[WebRTC] Remote track received:",
            event.track.kind
        );

        if (
            event.streams &&
            event.streams.length > 0
        ) {

            videoElement.srcObject =
                event.streams[0];

        } else {

            const stream =
                new MediaStream([
                    event.track
                ]);

            videoElement.srcObject =
                stream;
        }

        videoElement
            .play()
            .then(() => {

                console.log(
                    "[Video] Playback started"
                );

                updateConnectionUI(
                    "connected"
                );

                setStatus(
                    "LIVE"
                );

                // ====================================================
                // IMPORTANT:
                // User/Host connected -> START API POLLING
                // ====================================================

                startLineCallPolling();

            })
            .catch((error) => {

                console.warn(
                    "[Video] Autoplay prevented:",
                    error
                );

                updateConnectionUI(
                    "connected"
                );

                setStatus(
                    "Tap the video to start playback"
                );

                // Start API polling because WebRTC is connected.
                startLineCallPolling();
            });
    };

    // --------------------------------------------------------
    // LOCAL ICE CANDIDATE
    // --------------------------------------------------------

    peerConnection.onicecandidate = (event) => {

        if (!event.candidate) {

            console.log(
                "[ICE] Candidate gathering completed"
            );

            return;
        }

        console.log(
            "[ICE] Local candidate:",
            event.candidate.candidate
        );

        if (
            !socket ||
            socket.readyState !== WebSocket.OPEN
        ) {

            console.warn(
                "[ICE] WebSocket not ready; local candidate cannot be sent"
            );

            return;
        }

        socket.send(
            JSON.stringify({
                type: "ice-candidate",
                sessionId: sessionId,
                targetId: producerId,

                sdpMLineIndex:
                    event.candidate.sdpMLineIndex,

                sdpMid:
                    event.candidate.sdpMid,

                candidate:
                    event.candidate.candidate
            })
        );
    };

    // --------------------------------------------------------
    // ICE GATHERING STATE
    // --------------------------------------------------------

    peerConnection.onicegatheringstatechange = () => {

        console.log(
            "[ICE] Gathering state:",
            peerConnection.iceGatheringState
        );
    };

    // --------------------------------------------------------
    // ICE CONNECTION STATE
    // --------------------------------------------------------

    peerConnection.oniceconnectionstatechange = () => {

        console.log(
            "[ICE] Connection state:",
            peerConnection.iceConnectionState
        );

        switch (
            peerConnection.iceConnectionState
        ) {

            case "new":

                updateConnectionUI(
                    "connecting"
                );

                setStatus(
                    "Preparing video connection..."
                );

                break;

            case "checking":

                updateConnectionUI(
                    "connecting"
                );

                setStatus(
                    "Connecting video..."
                );

                break;

            case "connected":

                updateConnectionUI(
                    "connected"
                );

                setStatus(
                    "LIVE"
                );

                // ====================================================
                // IMPORTANT:
                // WebRTC connected -> START API
                // ====================================================

                startLineCallPolling();

                break;

            case "completed":

                updateConnectionUI(
                    "connected"
                );

                setStatus(
                    "LIVE"
                );

                startLineCallPolling();

                break;

            case "disconnected":

                updateConnectionUI(
                    "disconnected"
                );

                setStatus(
                    "Video connection disconnected"
                );

                // ====================================================
                // IMPORTANT:
                // WebRTC disconnected -> STOP API
                // ====================================================

                stopLineCallPolling();

                break;

            case "failed":

                updateConnectionUI(
                    "disconnected"
                );

                setStatus(
                    "❌ WebRTC connection failed - Check console for details"
                );

                // Stop API polling.
                stopLineCallPolling();

                break;

            case "closed":

                updateConnectionUI(
                    "disconnected"
                );

                setStatus(
                    "Video connection closed"
                );

                // Stop API polling.
                stopLineCallPolling();

                break;
        }
    };

    // --------------------------------------------------------
    // CONNECTION STATE
    // --------------------------------------------------------

    peerConnection.onconnectionstatechange = () => {

        console.log(
            "[WebRTC] Connection state:",
            peerConnection.connectionState
        );

        switch (
            peerConnection.connectionState
        ) {

            case "connected":

                updateConnectionUI(
                    "connected"
                );

                setStatus(
                    "LIVE"
                );

                // ====================================================
                // IMPORTANT:
                // USER CONNECTED -> API START
                // ====================================================

                startLineCallPolling();

                break;

            case "connecting":

                updateConnectionUI(
                    "connecting"
                );

                setStatus(
                    "Connecting video..."
                );

                break;

            case "disconnected":

                updateConnectionUI(
                    "disconnected"
                );

                setStatus(
                    "Video connection disconnected"
                );

                // ====================================================
                // IMPORTANT:
                // USER DISCONNECTED -> API STOP
                // ====================================================

                stopLineCallPolling();

                break;

            case "failed":

                updateConnectionUI(
                    "disconnected"
                );

                setStatus(
                    "❌ Connection failed"
                );

                // Stop API polling.
                stopLineCallPolling();

                break;

            case "closed":

                updateConnectionUI(
                    "disconnected"
                );

                setStatus(
                    "Video connection closed"
                );

                // Stop API polling.
                stopLineCallPolling();

                break;
        }
    };

    // --------------------------------------------------------
    // SIGNALING STATE
    // --------------------------------------------------------

    peerConnection.onsignalingstatechange = () => {

        console.log(
            "[WebRTC] Signaling state:",
            peerConnection.signalingState
        );
    };

    // --------------------------------------------------------
    // FLUSH QUEUED ICE CANDIDATES
    // --------------------------------------------------------

    await flushPendingIceCandidates();
}

// ============================================================
// HANDLE OFFER
// ============================================================

async function handleOffer(message) {

    try {

        producerId =
            message.fromId;

        console.log(
            "[WebRTC] Offer received from Host:",
            producerId
        );

        updateConnectionUI(
            "connecting"
        );

        // NOTE: pendingIceCandidates is intentionally NOT cleared
        // here. The host may send ICE candidates right after the
        // offer, and clearing would drop ones that already arrived.
        // It is cleared in stopPeerConnection() instead.

        await createPeerConnection();

        console.log(
            "[WebRTC] Setting remote description"
        );

        await peerConnection.setRemoteDescription(
            new RTCSessionDescription({
                type: "offer",
                sdp: message.sdp
            })
        );

        console.log(
            "[WebRTC] Remote description set"
        );

        await flushPendingIceCandidates();

        console.log(
            "[WebRTC] Creating answer"
        );

        const answer =
            await peerConnection.createAnswer();

        await peerConnection.setLocalDescription(
            answer
        );

        console.log(
            "[WebRTC] Local description set"
        );

        if (
            socket &&
            socket.readyState === WebSocket.OPEN
        ) {

            socket.send(
                JSON.stringify({
                    type: "answer",
                    sessionId: sessionId,
                    targetId: producerId,
                    sdp: answer.sdp
                })
            );

            console.log(
                "[WebRTC] Answer sent to producer"
            );

            setStatus(
                "Answer sent. Connecting video..."
            );

        } else {

            console.error(
                "[WebRTC] WebSocket is not connected"
            );

            updateConnectionUI(
                "disconnected"
            );

            setStatus(
                "Signaling connection lost"
            );

            stopLineCallPolling();
        }

    } catch (error) {

        console.error(
            "[WebRTC] Offer handling failed:",
            error
        );

        updateConnectionUI(
            "disconnected"
        );

        setStatus(
            "Failed to establish WebRTC connection"
        );

        stopLineCallPolling();
    }
}

// ============================================================
// HANDLE REMOTE ICE CANDIDATE
// ============================================================

async function handleRemoteCandidate(message) {

    try {

        console.log(
            "[ICE] Remote candidate received:",
            message.candidate
        );

        const candidate =
            new RTCIceCandidate({
                candidate:
                    message.candidate,

                sdpMid:
                    message.sdpMid,

                sdpMLineIndex:
                    message.sdpMLineIndex
            });

        // ----------------------------------------------------
        // If PeerConnection or remote description isn't ready,
        // queue the candidate.
        // ----------------------------------------------------

        if (
            !peerConnection ||
            !peerConnection.remoteDescription
        ) {

            console.log(
                "[ICE] PeerConnection/remote description not ready."
            );

            console.log(
                "[ICE] Queueing remote candidate."
            );

            pendingIceCandidates.push(
                candidate
            );

            return;
        }

        await peerConnection.addIceCandidate(
            candidate
        );

        console.log(
            "[ICE] Remote candidate added successfully"
        );

    } catch (error) {

        console.error(
            "[ICE] Failed to handle remote candidate:",
            error
        );
    }
}

// ============================================================
// FLUSH QUEUED ICE CANDIDATES
// ============================================================

async function flushPendingIceCandidates() {

    if (
        !peerConnection ||
        !peerConnection.remoteDescription
    ) {

        return;
    }

    if (
        pendingIceCandidates.length === 0
    ) {

        return;
    }

    console.log(
        `[ICE] Flushing ${pendingIceCandidates.length} queued candidates`
    );

    const candidates =
        [...pendingIceCandidates];

    pendingIceCandidates = [];

    for (
        const candidate of candidates
    ) {

        try {

            await peerConnection.addIceCandidate(
                candidate
            );

            console.log(
                "[ICE] Queued candidate added successfully"
            );

        } catch (error) {

            console.error(
                "[ICE] Failed to add queued candidate:",
                error
            );
        }
    }
}

// ============================================================
// STOP PEER CONNECTION
// ============================================================

function stopPeerConnection() {

    console.log(
        "[WebRTC] Stopping PeerConnection"
    );

    // IMPORTANT:
    // Stop API immediately when PeerConnection stops.
    stopLineCallPolling();

    if (peerConnection) {

        peerConnection.ontrack = null;
        peerConnection.onicecandidate = null;
        peerConnection.onconnectionstatechange = null;
        peerConnection.oniceconnectionstatechange = null;

        peerConnection.close();

        peerConnection = null;
    }

    pendingIceCandidates = [];

    videoElement.srcObject = null;

    producerId = null;

    updateConnectionUI(
        "disconnected"
    );
}

// ============================================================
// VIDEO FPS
// ============================================================

function updateFPS() {

    const now =
        performance.now();

    const elapsed =
        now - lastFPSCheck;

    if (elapsed >= 1000) {

        const fps =
            renderedFrames * 1000 / elapsed;

        fpsElement.textContent =
            uiConnectionState === "connected"
                ? `FPS: ${fps.toFixed(1)}`
                : "FPS: --";

        renderedFrames = 0;

        lastFPSCheck = now;
    }

    requestAnimationFrame(
        updateFPS
    );
}

// ============================================================
// VIDEO FRAME CALLBACK
// ============================================================

if (
    "requestVideoFrameCallback"
    in HTMLVideoElement.prototype
) {

    function countVideoFrame() {

        renderedFrames++;

        videoElement.requestVideoFrameCallback(
            countVideoFrame
        );
    }

    videoElement.requestVideoFrameCallback(
        countVideoFrame
    );

} else {

    console.warn(
        "[Video] requestVideoFrameCallback not supported; using fallback"
    );

    videoElement.addEventListener(
        "timeupdate",
        () => {
            renderedFrames++;
        }
    );
}

// ============================================================
// START FPS LOOP
// ============================================================

requestAnimationFrame(
    updateFPS
);

// ============================================================
// LINE CALL API
//
// IMPORTANT BEHAVIOR:
//
// CONNECTED:
//   API continuously hit hoti hai.
//
// DISCONNECTED:
//   API polling completely stop hoti hai.
//   Current request bhi abort hoti hai.
//   Jo line call / clip screen par hai woh apne normal timer
//   tak wahin rehta hai (hide nahi hota).
//
// RECONNECTED:
//   API polling dobara start hoti hai (naya loop ID, purana
//   loop khud band ho jata hai).
//
// Session ID:
//   URL se jo ONE sessionId mili hai, wahi use hoti hai.
// ============================================================

// IMPORTANT: if this viewer page is served over HTTPS, this MUST
// be an https:// URL too (browsers block http:// requests from an
// https:// page = "mixed content"), and the API must allow this
// page's origin via CORS.
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

// How long the big IN/OUT badge stays on the video.
const LINECALL_SHOW_MS =
    2000;

// Small gap between polls so a fast/404 response doesn't turn the
// loop into hundreds of requests per second.
const LINECALL_MIN_GAP_MS =
    200;

const LINECALL_ERROR_RETRY_MS =
    300;

// Bumped up from 2000ms: the tracking pipeline can take a bit to
// finish processing a frame before the "latest" event is ready, and
// a request that legitimately takes >2s was being treated as a fatal
// timeout (see the AbortError handling below), which made the whole
// polling loop die. Increasing this reduces how often we even hit
// that edge case in the first place.
const LINECALL_REQUEST_TIMEOUT_MS =
    5000;

const lineCallElement =
    document.getElementById("lineCall");

const lineCallResultElement =
    document.getElementById("lineCallResult");

const lineCallDetailElement =
    document.getElementById("lineCallDetail");

// Replay list (one card per line call that carries a clip url)
const replaysListElement =
    document.getElementById("replaysList");

const replaysEmptyElement =
    document.getElementById("replaysEmpty");

console.log(
    "[LineCall] DOM elements found:",
    {
        lineCallElement: !!lineCallElement,
        lineCallResultElement: !!lineCallResultElement,
        lineCallDetailElement: !!lineCallDetailElement,
        replaysListElement: !!replaysListElement,
        replaysEmptyElement: !!replaysEmptyElement
    }
);

// ============================================================
// LINE CALL STATE
// ============================================================

let lastLineCallEventId = null;

let lineCallFirstPoll = true;

let lineCallHideTimer = null;

// IMPORTANT:
// This is NOT a Session ID.
// This only controls whether the API polling loop is running.
let lineCallLoopRunning = false;

// Every call to startLineCallPolling() gets a new loop ID. An older
// loop that is still sleeping/awaiting notices its ID is stale and
// exits, so a quick disconnect -> reconnect never leaves two loops
// polling at the same time.
let lineCallLoopId = 0;

// Current API request controller.
// Used to immediately cancel request on disconnect.
let activeLineCallController = null;

// Counts every /latest API hit, purely for debugging in the console.
let lineCallPollCount = 0;

function isLoopActive(loopId) {

    return (
        lineCallLoopRunning &&
        loopId === lineCallLoopId
    );
}

// ============================================================
// SLEEP
// ============================================================

function sleep(ms) {

    return new Promise(
        (resolve) => setTimeout(
            resolve,
            ms
        )
    );
}

// ============================================================
// SAFE CLIP URL
//
// Only https:// links are accepted for the clip, so a bad/odd API
// value (e.g. "javascript:...") can never reach <video src> or
// <a href>.
// ============================================================

function getSafeClipUrl(rawUrl) {

    if (
        typeof rawUrl !== "string" ||
        !rawUrl
    ) {
        return null;
    }

    try {

        const parsed =
            new URL(rawUrl);

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

// ============================================================
// DISPLAY
// ============================================================

function hideLineCall() {

    console.log(
        "[LineCall] Hiding badge (timer expired)."
    );

    lineCallElement.classList.remove(
        "show"
    );
}

// ============================================================
// REPLAY LIST
//
// Every new line call, if the event has a clip url, adds a
// "Call #N" replay card under the video (newest at the end).
// ============================================================

const MAX_REPLAYS = 40;

let totalCalls = 0;

// fetch -> blob -> save to device. If that fails (usually CORS on
// the S3 bucket), fall back to opening the clip in a new tab.
async function downloadClip(clipUrl, button) {

    if (button.classList.contains("busy")) {
        return;
    }

    let fileName = "line-call-clip.mov";

    try {

        fileName =
            decodeURIComponent(
                clipUrl.split("?")[0].split("/").pop() ||
                fileName
            );

    } catch (error) {

        // Keep the default file name.
    }

    console.log(
        "[Replay] ⬇ Downloading clip:",
        clipUrl
    );

    button.classList.add("busy");

    button.textContent = "...";

    try {

        const response =
            await fetch(clipUrl);

        if (!response.ok) {

            throw new Error(
                `Download returned ${response.status}`
            );
        }

        const blob =
            await response.blob();

        const blobUrl =
            URL.createObjectURL(blob);

        const link =
            document.createElement("a");

        link.href = blobUrl;
        link.download = fileName;

        document.body.appendChild(link);
        link.click();
        link.remove();

        setTimeout(
            () => URL.revokeObjectURL(blobUrl),
            10000
        );

    } catch (error) {

        // Usually CORS: the S3 bucket doesn't allow this origin.
        console.warn(
            "[Replay] ⬇ fetch download failed, opening in new tab:",
            error
        );

        window.open(
            clipUrl,
            "_blank",
            "noopener"
        );

    } finally {

        button.classList.remove("busy");

        button.textContent = "⬇";
    }
}

function addReplay(clipUrl, callNumber, result) {

    console.log(
        "[Replay] 🎬 Adding replay card:",
        callNumber,
        clipUrl
    );

    const card =
        document.createElement("div");

    card.className = "replay-card";

    card.dataset.result =
        result || "";

    // "#t=0.1" makes the browser show a frame as the thumbnail.
    const video =
        document.createElement("video");

    video.controls = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = clipUrl + "#t=0.1";

    // Browser can't decode this clip (e.g. .mov codec) -> show a link.
    video.addEventListener(
        "error",
        () => {

            console.warn(
                "[Replay] Clip <video> errored (unsupported format?), showing link instead:",
                clipUrl
            );

            const fallback =
                document.createElement("a");

            fallback.className = "replay-fallback";
            fallback.href = clipUrl;
            fallback.target = "_blank";
            fallback.rel = "noopener";
            fallback.textContent = "Open clip";

            video.replaceWith(fallback);
        }
    );

    const footer =
        document.createElement("div");

    footer.className = "replay-footer";

    const title =
        document.createElement("span");

    title.className = "replay-title";
    title.textContent = `Call #${callNumber}`;

    const downloadButton =
        document.createElement("button");

    downloadButton.type = "button";
    downloadButton.className = "replay-download";
    downloadButton.title = "Download clip";
    downloadButton.textContent = "⬇";

    downloadButton.addEventListener(
        "click",
        () => downloadClip(
            clipUrl,
            downloadButton
        )
    );

    footer.appendChild(title);
    footer.appendChild(downloadButton);

    card.appendChild(video);
    card.appendChild(footer);

    replaysListElement.appendChild(card);

    replaysEmptyElement.style.display =
        "none";

    // Keep memory/DOM in check on very long sessions.
    while (
        replaysListElement.children.length > MAX_REPLAYS
    ) {

        replaysListElement.removeChild(
            replaysListElement.firstChild
        );
    }
}

function showLineCall(event) {

    console.log(
        "[LineCall] 📣 Displaying event on screen:",
        event
    );

    const rawResult =
        String(
            event.in_out || ""
        ).toLowerCase();

    // Low/medium confidence detections are shown as "UNCERTAIN"
    // instead of a plain IN/OUT, so the viewer knows this call is
    // less reliable.
    const isUncertain =
        !!event.confidence_level &&
        event.confidence_level !== "high";

    const result =
        isUncertain
            ? "uncertain"
            : rawResult;

    console.log(
        "[LineCall] Result resolution:",
        {
            rawResult,
            confidence_level: event.confidence_level,
            isUncertain,
            result
        }
    );

    lineCallElement.dataset.result =
        [
            "in",
            "out",
            "uncertain"
        ].includes(result)
            ? result
            : "";

    const labelText =
        isUncertain
            ? `UNCERTAIN ${rawResult.toUpperCase()}`
            : (
                rawResult
                    ? rawResult.toUpperCase()
                    : String(
                        event.type || "EVENT"
                    ).toUpperCase()
            );

    lineCallResultElement.textContent =
        labelText;

    const details = [];

    if (event.nearest_line) {

        details.push(
            event.nearest_line
        );
    }

    if (
        typeof event.nearest_line_distance ===
        "number"
    ) {

        details.push(
            `${event.nearest_line_distance} ft`
        );
    }

    lineCallDetailElement.textContent =
        details.join(" · ");

    lineCallElement.classList.add(
        "show"
    );

    // Count this call (used only for the replay card's "Call #N"
    // label), and add its replay card if it has a clip.
    totalCalls++;

    const clipUrl =
        getSafeClipUrl(event.url);

    if (clipUrl) {

        addReplay(
            clipUrl,
            totalCalls,
            result
        );
    }

    clearTimeout(
        lineCallHideTimer
    );

    console.log(
        "[LineCall] Badge will auto-hide after",
        LINECALL_SHOW_MS,
        "ms"
    );

    lineCallHideTimer =
        setTimeout(
            hideLineCall,
            LINECALL_SHOW_MS
        );
}

// ============================================================
// POLL API ONCE
// ============================================================

async function pollLineCallOnce(loopId) {

    // Do not make API request if user is not connected
    // (or if this loop has been replaced by a newer one).
    if (!isLoopActive(loopId)) {
        console.log(
            "[LineCall] Skipping poll, loop is not active."
        );
        return;
    }

    lineCallPollCount++;

    const controller =
        new AbortController();

    activeLineCallController =
        controller;

    const timeout =
        setTimeout(
            () => controller.abort(),
            LINECALL_REQUEST_TIMEOUT_MS
        );

    try {

        const url =
            `${LINECALL_API_BASE}/tracknet/realtime/notifications/` +
            `${encodeURIComponent(sessionId)}/latest`;

        console.log(
            `[LineCall] API HIT #${lineCallPollCount}:`,
            url
        );

        const response =
            await fetch(
                url,
                {
                    cache: "no-store",
                    signal: controller.signal
                }
            );

        console.log(
            `[LineCall] API response status #${lineCallPollCount}:`,
            response.status
        );

        // If connection was lost while
        // request was running, don't process it.
        if (!isLoopActive(loopId)) {
            console.log(
                "[LineCall] Loop stopped while request was in flight, discarding response."
            );
            return;
        }

        if (
            response.status === 404
        ) {

            console.log(
                "[LineCall] 404 - no event available yet for this session."
            );

            // No event available.
            lineCallFirstPoll = false;

            return;
        }

        if (!response.ok) {

            throw new Error(
                `API returned ${response.status}`
            );
        }

        const data =
            await response.json();

        // Connection may have disappeared
        // while JSON was being processed.
        if (!isLoopActive(loopId)) {
            console.log(
                "[LineCall] Loop stopped while parsing JSON, discarding response."
            );
            return;
        }

        // ----------------------------------------------------
        // DEBUG:
        // Log the raw payload every time so we can see exactly
        // what shape the API is sending (top-level event_id?
        // wrapped in "event"/"data"? different field name?).
        // ----------------------------------------------------
        console.log(
            "[LineCall] Raw response:",
            data
        );

        const event =
            data && data.event_id
                ? data
                : (
                    data &&
                    (
                        data.event ||
                        data.data
                    )
                ) || null;

        if (
            !event ||
            !event.event_id
        ) {

            console.warn(
                "[LineCall] No usable event_id found in response. " +
                "Check the raw response logged above — the shape " +
                "may not match what the code expects.",
                data
            );

            lineCallFirstPoll = false;

            return;
        }

        // Log every event_id we compare against, even when it's the
        // same as before, so "no new event yet" is visibly different
        // from "we never detect changes".
        console.log(
            "[LineCall] event_id from API:",
            event.event_id,
            "| last seen:",
            lastLineCallEventId,
            "| firstPoll:",
            lineCallFirstPoll,
            "| has clip url:",
            !!event.url
        );

        // ----------------------------------------------------
        // First API hit after connection:
        // Don't show old/latest event.
        // Just remember its ID.
        // ----------------------------------------------------

        if (lineCallFirstPoll) {

            lineCallFirstPoll = false;

            lastLineCallEventId =
                event.event_id;

            console.log(
                "[LineCall] Initial event remembered (not shown):",
                event.event_id
            );

            return;
        }

        // ----------------------------------------------------
        // Only NEW event is displayed.
        // ----------------------------------------------------

        if (
            event.event_id !==
            lastLineCallEventId
        ) {

            lastLineCallEventId =
                event.event_id;

            console.log(
                "[LineCall] 🟢 NEW EVENT DETECTED:",
                event
            );

            showLineCall(
                event
            );

        } else {

            console.log(
                "[LineCall] Same event as last poll, nothing new. event_id:",
                event.event_id
            );
        }

    } finally {

        clearTimeout(
            timeout
        );

        if (
            activeLineCallController ===
            controller
        ) {

            activeLineCallController =
                null;
        }
    }
}

// ============================================================
// START LINE CALL POLLING
//
// Called ONLY when WebRTC becomes connected.
// ============================================================

function startLineCallPolling() {

    // Already running -> do nothing.
    // This prevents multiple loops.
    if (lineCallLoopRunning) {

        console.log(
            "[LineCall] Polling already running."
        );

        return;
    }

    console.log(
        "[LineCall] 🟢 User connected -> START API polling"
    );

    console.log(
        "[LineCall] Session ID:",
        sessionId
    );

    console.log(
        "[LineCall] Config:",
        {
            LINECALL_API_BASE,
            LINECALL_SHOW_MS,
            LINECALL_MIN_GAP_MS,
            LINECALL_ERROR_RETRY_MS,
            LINECALL_REQUEST_TIMEOUT_MS
        }
    );

    lineCallLoopRunning = true;

    lineCallPollCount = 0;

    // On every new connection, the current
    // latest event is treated as old.
    // A genuinely newer event will be shown.
    lineCallFirstPoll = true;

    // New loop ID -> any older loop still winding down will exit.
    lineCallLoopId++;

    lineCallLoop(lineCallLoopId);
}

// ============================================================
// STOP LINE CALL POLLING
//
// Called when WebRTC disconnects/fails/closes.
// ============================================================

function stopLineCallPolling() {

    if (!lineCallLoopRunning) {

        // Even if loop is already stopped,
        // make sure any active request is cancelled.
        if (activeLineCallController) {

            console.log(
                "[LineCall] Loop already stopped, but aborting a stray in-flight request."
            );

            activeLineCallController.abort();

            activeLineCallController = null;
        }

        return;
    }

    console.log(
        "[LineCall] 🔴 User disconnected -> STOP API polling",
        "(total polls made:",
        lineCallPollCount,
        ")"
    );

    lineCallLoopRunning = false;

    // Cancel current API request immediately.
    if (activeLineCallController) {

        console.log(
            "[LineCall] Aborting active API request..."
        );

        activeLineCallController.abort();

        activeLineCallController = null;
    }

    // NOTE: we deliberately do NOT clear/hide the line call badge
    // here (replay cards are never removed). If the badge is
    // currently showing, it stays on screen (and still auto-hides
    // on its own normal timer from showLineCall) even though the
    // host/stream disconnected — so the viewer doesn't lose the
    // last call the moment the connection drops.
    console.log(
        "[LineCall] Leaving any currently visible line call as-is."
    );
}

// ============================================================
// CONTINUOUS API POLLING LOOP
// ============================================================

async function lineCallLoop(myLoopId) {

    console.log(
        "[LineCall] Polling loop starting. Loop ID:",
        myLoopId
    );

    while (
        isLoopActive(myLoopId)
    ) {

        try {

            await pollLineCallOnce(myLoopId);

            // Connection could have been lost
            // while the request was running.
            if (!isLoopActive(myLoopId)) {
                break;
            }

            if (
                LINECALL_MIN_GAP_MS > 0
            ) {

                await sleep(
                    LINECALL_MIN_GAP_MS
                );
            }

        } catch (error) {

            // AbortError fires in TWO different situations, and they
            // must NOT be treated the same:
            //
            //   1) Disconnect -> stopLineCallPolling() calls
            //      activeLineCallController.abort() AND sets
            //      lineCallLoopRunning = false.
            //      -> real stop, loop should break.
            //
            //   2) Per-request timeout (LINECALL_REQUEST_TIMEOUT_MS)
            //      -> a single slow API response, the loop is still
            //      active.
            //      -> NOT a disconnect. Must keep polling.
            if (
                error &&
                error.name === "AbortError"
            ) {

                if (!isLoopActive(myLoopId)) {

                    console.log(
                        "[LineCall] Request aborted (disconnect)."
                    );

                    break;
                }

                console.warn(
                    "[LineCall] Request timed out (>",
                    LINECALL_REQUEST_TIMEOUT_MS,
                    "ms), retrying..."
                );

                await sleep(
                    LINECALL_ERROR_RETRY_MS
                );

                continue;
            }

            console.warn(
                "[LineCall] Poll failed:",
                error
            );

            // IMPORTANT:
            // Don't retry after disconnect.
            if (!isLoopActive(myLoopId)) {
                break;
            }

            await sleep(
                LINECALL_ERROR_RETRY_MS
            );
        }
    }

    console.log(
        "[LineCall] Polling loop stopped. Loop ID:",
        myLoopId,
        "| Total polls made:",
        lineCallPollCount
    );
}

// ============================================================
// CLEANUP
// ============================================================

window.addEventListener(
    "beforeunload",
    () => {

        console.log(
            "[WebViewer] Cleaning up..."
        );

        // Prevent WebSocket auto-reconnect while closing.
        pageUnloading = true;

        clearTimeout(wsReconnectTimer);

        stopWsPing();

        // Stop API polling.
        lineCallLoopRunning = false;

        if (
            activeLineCallController
        ) {

            activeLineCallController.abort();

            activeLineCallController = null;
        }

        stopPeerConnection();

        if (socket) {

            socket.close();
        }
    }
);