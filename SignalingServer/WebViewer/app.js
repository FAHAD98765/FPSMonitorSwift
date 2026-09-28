const viewerParams = new URLSearchParams(window.location.search);

const sessionId =
    viewerParams.get("session")
 ||
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

// Fetch TURN credentials from Metered
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
        console.log("[ICE] TURN Servers Received:", turnServers);
        
        if (Array.isArray(turnServers) && turnServers.length > 0) {
            rtcConfig.iceServers = [
                { urls: "stun:stun.l.google.com:19302" },
                ...turnServers
            ];
            console.log("[ICE] ✅ Metered TURN Loaded! Config:", rtcConfig.iceServers);
            return true;
        } else {
            console.warn("[ICE] ⚠️ No TURN servers returned");
            return false;
        }
    } catch (error) {
        console.error("[ICE] ❌ Metered TURN Fetch Failed:", error);
        return false;
    }
}

// Use fallback OpenRelay TURN
function useFallbackTurn() {
    console.log("[ICE] 🔄 Switching to fallback OpenRelay TURN...");
    
    rtcConfig.iceServers = [
        { urls: "stun:stun.l.google.com:19302" },
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
    console.log("[ICE] ✅ Fallback TURN Active! Config:", rtcConfig.iceServers);
}

// Initialize TURN on startup
async function initializeTurn() {
    console.log("[ICE] Starting TURN initialization...");
    
    const success = await fetchTurnCredentials();
    
    if (!success) {
        console.warn("[ICE] Metered failed, using OpenRelay fallback");
        useFallbackTurn();
    }
}

// ============================================================
// STATUS
// ============================================================

function setStatus(message) {
    statusElement.textContent = message;
    console.log("[WebViewer]", message);
}

// ============================================================
// CONNECTION UI STATE
//
//   "connected"    -> green dot  (host video is connected)
//   "disconnected" -> red dot    (host left / connection lost)
//   "connecting"   -> amber dot  (waiting / negotiating)
//
// The actual colors + bottom "Connected/Disconnected" text are
// handled by window.setConnectionState() in index.html.
// ============================================================

let uiConnectionState = "connecting";

function updateConnectionUI(state) {
    uiConnectionState = state;

    if (typeof window.setConnectionState === "function") {
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
        setStatus("Missing session ID");
        updateConnectionUI("disconnected");
    } else {
        updateConnectionUI("connecting");
        setStatus("Initializing TURN...");
        await initializeTurn();
        setStatus(`Connecting to session: ${sessionId}`);
        connectSignaling();
    }
}

start();

// ============================================================
// WEBSOCKET SIGNALING
// ============================================================

function connectSignaling() {
    const protocol =
        window.location.protocol === "https:" ? "wss:" : "ws:";

    const wsURL =
        `${protocol}//${window.location.host}`;

    console.log("[WS] Connecting:", wsURL);

    socket = new WebSocket(wsURL);

    socket.onopen = () => {
        console.log("[WS] Connected");

        socket.send(JSON.stringify({
            type: "register",
            sessionId: sessionId,
            role: "viewer"
        }));

        setStatus(
            "Connected to signaling server. Waiting for host..."
        );
    };

    socket.onmessage = async (event) => {
        try {
            const message = JSON.parse(event.data);

            console.log("[WS] Message:", message.type, message);

            switch (message.type) {

                case "registered":
                    console.log(
                        "[WS] Registered as viewer:",
                        message.clientId
                    );
                    break;

                case "producer-available":
                    updateConnectionUI("connecting");
                    setStatus(
                        "Host available. Waiting for video..."
                    );
                    break;

                case "offer":
                    await handleOffer(message);
                    break;

                case "ice-candidate":
                    await handleRemoteCandidate(message);
                    break;

                case "producer-left":
                    stopPeerConnection();
                    updateConnectionUI("disconnected");
                    setStatus("Host disconnected");
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
        console.error("[WS] Error:", error);

        // If video is not live, a signaling error means we are disconnected.
        if (
            !peerConnection ||
            peerConnection.connectionState !== "connected"
        ) {
            updateConnectionUI("disconnected");
        }

        setStatus(
            "WebSocket connection error"
        );
    };

    socket.onclose = () => {
        console.log("[WS] Disconnected");

        // If the video is still live over WebRTC, keep showing "Connected".
        if (
            !peerConnection ||
            peerConnection.connectionState !== "connected"
        ) {
            updateConnectionUI("disconnected");
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

    console.log("[WebRTC] Creating PeerConnection with config:", rtcConfig);

    if (peerConnection) {
        console.log(
            "[WebRTC] Closing previous PeerConnection"
        );

        peerConnection.close();
    }

    peerConnection = new RTCPeerConnection(rtcConfig);

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
                new MediaStream([event.track]);

            videoElement.srcObject = stream;
        }

        videoElement
            .play()
            .then(() => {

                console.log(
                    "[Video] Playback started"
                );

                updateConnectionUI("connected");
                setStatus("LIVE");

            })
            .catch((error) => {

                console.warn(
                    "[Video] Autoplay prevented:",
                    error
                );

                updateConnectionUI("connected");
                setStatus(
                    "Tap the video to start playback"
                );
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

        socket.send(JSON.stringify({
            type: "ice-candidate",
            sessionId: sessionId,
            targetId: producerId,

            sdpMLineIndex:
                event.candidate.sdpMLineIndex,

            sdpMid:
                event.candidate.sdpMid,

            candidate:
                event.candidate.candidate
        }));
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

                updateConnectionUI("connecting");
                setStatus(
                    "Preparing video connection..."
                );

                break;

            case "checking":

                updateConnectionUI("connecting");
                setStatus(
                    "Connecting video..."
                );

                break;

            case "connected":

                updateConnectionUI("connected");
                setStatus("LIVE");

                break;

            case "completed":

                updateConnectionUI("connected");
                setStatus("LIVE");

                break;

            case "disconnected":

                updateConnectionUI("disconnected");
                setStatus(
                    "Video connection disconnected"
                );

                break;

            case "failed":

                updateConnectionUI("disconnected");
                setStatus(
                    "❌ WebRTC connection failed - Check console for details"
                );

                break;

            case "closed":

                updateConnectionUI("disconnected");
                setStatus(
                    "Video connection closed"
                );

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

                updateConnectionUI("connected");
                setStatus("LIVE");

                break;

            case "connecting":

                updateConnectionUI("connecting");
                setStatus(
                    "Connecting video..."
                );

                break;

            case "disconnected":

                updateConnectionUI("disconnected");
                setStatus(
                    "Video connection disconnected"
                );

                break;

            case "failed":

                updateConnectionUI("disconnected");
                setStatus(
                    "❌ Connection failed"
                );

                break;

            case "closed":

                updateConnectionUI("disconnected");
                setStatus(
                    "Video connection closed"
                );

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

        producerId = message.fromId;

        console.log(
            "[WebRTC] Offer received from Host:",
            producerId
        );

        updateConnectionUI("connecting");

        // Reset old ICE candidates for this new connection.
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

        // Some candidates may have arrived while
        // setRemoteDescription was being processed.
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

            socket.send(JSON.stringify({
                type: "answer",
                sessionId: sessionId,
                targetId: producerId,
                sdp: answer.sdp
            }));

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

            updateConnectionUI("disconnected");
            setStatus(
                "Signaling connection lost"
            );
        }

    } catch (error) {

        console.error(
            "[WebRTC] Offer handling failed:",
            error
        );

        updateConnectionUI("disconnected");
        setStatus(
            "Failed to establish WebRTC connection"
        );
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

        const candidate = new RTCIceCandidate({
            candidate: message.candidate,
            sdpMid: message.sdpMid,
            sdpMLineIndex: message.sdpMLineIndex
        });

        // ----------------------------------------------------
        // If PeerConnection or remote description isn't ready,
        // queue the candidate instead of losing it.
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

            pendingIceCandidates.push(candidate);

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

    // Handlers are removed above, so update the UI explicitly.
    updateConnectionUI("disconnected");
}

// ============================================================
// VIDEO FPS
// ============================================================

function updateFPS() {

    const now = performance.now();

    const elapsed =
        now - lastFPSCheck;

    if (elapsed >= 1000) {

        const fps =
            renderedFrames * 1000 / elapsed;

        // Only show a real FPS number while connected.
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
// LINE CALL (polls the tracknet API, shows IN / OUT for 1 second)
// ============================================================

// NOTE: page HTTPS pe ho to browser http:// API ko block kar deta hai
// (mixed content). Us surat mein yahan apne server ka proxy path do.
const LINECALL_API_BASE = "http://13.60.246.31:8000";
const LINECALL_POLL_MS = 500;   // API kitni dair baad hit ho
const LINECALL_SHOW_MS = 1000;  // line call kitni dair screen par rahe

const lineCallElement = document.getElementById("lineCall");
const lineCallResultElement = document.getElementById("lineCallResult");
const lineCallDetailElement = document.getElementById("lineCallDetail");

let lastLineCallEventId = null;
let lineCallFirstPoll = true;
let lineCallHideTimer = null;
let lineCallRequestInFlight = false;

function showLineCall(event) {

    const result = String(event.in_out || "").toLowerCase();

    lineCallElement.dataset.result =
        result === "in" || result === "out" ? result : "";

    lineCallResultElement.textContent =
        result ? result.toUpperCase() : String(event.type || "EVENT").toUpperCase();

    const details = [];

    if (event.nearest_line) {
        details.push(event.nearest_line);
    }

    if (typeof event.nearest_line_distance === "number") {
        details.push(`${event.nearest_line_distance} ft`);
    }

    lineCallDetailElement.textContent = details.join(" \u00b7 ");

    lineCallElement.classList.add("show");

    // New event aaye to timer dobara 1 second se shuru
    clearTimeout(lineCallHideTimer);

    lineCallHideTimer = setTimeout(() => {
        lineCallElement.classList.remove("show");
    }, LINECALL_SHOW_MS);
}

async function pollLineCall() {

    if (!sessionId || lineCallRequestInFlight) {
        return;
    }

    lineCallRequestInFlight = true;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    try {

        const url =
            `${LINECALL_API_BASE}/tracknet/realtime/notifications/` +
            `${encodeURIComponent(sessionId)}/latest`;

        const response = await fetch(url, {
            cache: "no-store",
            signal: controller.signal
        });

        if (response.status === 404) {
            // Abhi koi event nahi hai
            lineCallFirstPoll = false;
            return;
        }

        if (!response.ok) {
            return;
        }

        const data = await response.json();

        const event =
            data && data.event_id
                ? data
                : (data && (data.event || data.data)) || null;

        if (!event || !event.event_id) {
            lineCallFirstPoll = false;
            return;
        }

        // Page khulte hi purana latest event dobara na dikhe
        if (lineCallFirstPoll) {
            lineCallFirstPoll = false;
            lastLineCallEventId = event.event_id;
            return;
        }

        if (event.event_id !== lastLineCallEventId) {
            lastLineCallEventId = event.event_id;

            console.log("[LineCall] New event:", event);

            showLineCall(event);
        }

    } catch (error) {

        console.warn("[LineCall] Poll failed:", error);

    } finally {

        clearTimeout(timeout);
        lineCallRequestInFlight = false;
    }
}

setInterval(pollLineCall, LINECALL_POLL_MS);
pollLineCall();

// ============================================================
// CLEANUP
// ============================================================

window.addEventListener(
    "beforeunload",
    () => {

        stopPeerConnection();

        if (socket) {
            socket.close();
        }
    }
);