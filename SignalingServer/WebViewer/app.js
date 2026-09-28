```javascript
const viewerParams = new URLSearchParams(window.location.search);

const sessionId =
    viewerParams.get("session") ||
    viewerParams.get("sessionId") ||
    "fpsmonitor-session";

const statusElement = document.getElementById("status");
const videoElement = document.getElementById("remoteVideo");
const fpsElement = document.getElementById("fps");

let socket = null;
let peerConnection = null;
let producerId = null;

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

    uiConnectionState = state;

    if (
        typeof window.setConnectionState === "function"
    ) {
        window.setConnectionState(state);
    }

    if (state !== "connected") {

        fpsElement.textContent = "FPS: --";
    }
}

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
// ============================================================

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

    socket = new WebSocket(wsURL);

    socket.onopen = () => {

        console.log(
            "[WS] Connected"
        );

        socket.send(
            JSON.stringify({
                type: "register",
                sessionId: sessionId,
                role: "viewer"
            })
        );

        setStatus(
            "Connected to signaling server. Waiting for host..."
        );
    };

    socket.onmessage = async (event) => {

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

                    updateConnectionUI(
                        "connecting"
                    );

                    setStatus(
                        "Host available. Waiting for video..."
                    );

                    break;

                case "offer":

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

                    stopPeerConnection();

                    updateConnectionUI(
                        "disconnected"
                    );

                    setStatus(
                        "Host disconnected"
                    );

                    break;

                case "error":

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

    socket.onerror = (error) => {

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

    socket.onclose = () => {

        console.log(
            "[WS] Disconnected"
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
            "Signaling server disconnected"
        );
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

        // Reset old ICE candidates.
        pendingIceCandidates = [];

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
//
// RECONNECTED:
//   API polling dobara start hoti hai.
//
// Session ID:
//   URL se jo ONE sessionId mili hai, wahi use hoti hai.
// ============================================================

const LINECALL_API_BASE =
    "http://13.60.246.31:8000";

const LINECALL_SHOW_MS =
    1000;

const LINECALL_MIN_GAP_MS =
    0;

const LINECALL_ERROR_RETRY_MS =
    300;

const LINECALL_REQUEST_TIMEOUT_MS =
    2000;

const lineCallElement =
    document.getElementById("lineCall");

const lineCallResultElement =
    document.getElementById("lineCallResult");

const lineCallDetailElement =
    document.getElementById("lineCallDetail");

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

// Current API request controller.
// Used to immediately cancel request on disconnect.
let activeLineCallController = null;

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
// DISPLAY
// ============================================================

function hideLineCall() {

    lineCallElement.classList.remove(
        "show"
    );
}

function showLineCall(event) {

    const result =
        String(
            event.in_out || ""
        ).toLowerCase();

    lineCallElement.dataset.result =
        [
            "in",
            "out",
            "uncertain"
        ].includes(result)
            ? result
            : "";

    lineCallResultElement.textContent =
        result
            ? result.toUpperCase()
            : String(
                event.type || "EVENT"
            ).toUpperCase();

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

    clearTimeout(
        lineCallHideTimer
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

async function pollLineCallOnce() {

    // Do not make API request if user is not connected.
    if (!lineCallLoopRunning) {
        return;
    }

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
            "[LineCall] API HIT:",
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

        // If connection was lost while
        // request was running, don't process it.
        if (!lineCallLoopRunning) {
            return;
        }

        if (
            response.status === 404
        ) {

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
        if (!lineCallLoopRunning) {
            return;
        }

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

            lineCallFirstPoll = false;

            return;
        }

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
                "[LineCall] Initial event remembered:",
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
                "[LineCall] 🟢 NEW EVENT:",
                event
            );

            showLineCall(
                event
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

    lineCallLoopRunning = true;

    // On every new connection, the current
    // latest event is treated as old.
    // A genuinely newer event will be shown.
    lineCallFirstPoll = true;

    lineCallLoop();
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

            activeLineCallController.abort();

            activeLineCallController = null;
        }

        return;
    }

    console.log(
        "[LineCall] 🔴 User disconnected -> STOP API polling"
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

    // Hide any currently visible Line Call badge.
    clearTimeout(
        lineCallHideTimer
    );

    hideLineCall();
}

// ============================================================
// CONTINUOUS API POLLING LOOP
// ============================================================

async function lineCallLoop() {

    while (
        lineCallLoopRunning
    ) {

        try {

            await pollLineCallOnce();

            // Connection could have been lost
            // while the request was running.
            if (!lineCallLoopRunning) {
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

            // AbortController is expected on disconnect.
            if (
                error &&
                error.name === "AbortError"
            ) {

                console.log(
                    "[LineCall] Request aborted."
                );

                break;
            }

            console.warn(
                "[LineCall] Poll failed:",
                error
            );

            // IMPORTANT:
            // Don't retry after disconnect.
            if (!lineCallLoopRunning) {
                break;
            }

            await sleep(
                LINECALL_ERROR_RETRY_MS
            );
        }
    }

    console.log(
        "[LineCall] Polling loop stopped."
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
```
