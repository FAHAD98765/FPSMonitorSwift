const params = new URLSearchParams(window.location.search);

const sessionId =
    params.get("session") ||
    params.get("sessionId") ||
    "fpsmonitor-session";

const statusElement = document.getElementById("status");
const videoElement = document.getElementById("remoteVideo");
const fpsElement = document.getElementById("fps");

let socket = null;
let peerConnection = null;
<<<<<<< HEAD

// Keep internal variable name because signaling protocol
// still uses producer terminology.
let producerId = null;


=======
let producerId = null;

>>>>>>> 77ab91f (Update WebViewer UI and host status)
// ============================================================
// ICE CANDIDATE QUEUE
// ============================================================

let pendingIceCandidates = [];

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
// ============================================================
// FPS
// ============================================================

let renderedFrames = 0;
let lastFPSCheck = performance.now();

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
// ============================================================
// WEBRTC CONFIG
// ============================================================

const rtcConfig = {
    iceServers: [
        {
            urls: "stun:stun.l.google.com:19302"
        }
    ]
};

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
// ============================================================
// STATUS
// ============================================================

function setStatus(message) {
<<<<<<< HEAD

    statusElement.textContent = message;

    console.log(
        "[WebViewer]",
        message
    );
}


// ============================================================
// SESSION CHECK
// ============================================================

if (!sessionId) {

    setStatus(
        "Missing session ID"
    );

} else {

    setStatus(
        `Connecting to session: ${sessionId}`
    );

    connectSignaling();
}


=======
    statusElement.textContent = message;
    console.log("[WebViewer]", message);
}

// ============================================================
// START
// ============================================================

if (!sessionId) {
    setStatus("Missing session ID");
} else {
    setStatus(`Connecting to session: ${sessionId}`);
    connectSignaling();
}

>>>>>>> 77ab91f (Update WebViewer UI and host status)
// ============================================================
// WEBSOCKET SIGNALING
// ============================================================

function connectSignaling() {
<<<<<<< HEAD

    const protocol =
        window.location.protocol === "https:"
            ? "wss:"
            : "ws:";

    // IMPORTANT:
    // Node signaling server uses the root WebSocket endpoint.
    // Do NOT add /ws here.
    const wsURL =
        `${protocol}//${window.location.host}`;

    console.log(
        "[WS] Connecting:",
        wsURL
    );

    socket = new WebSocket(wsURL);


    // --------------------------------------------------------
    // CONNECTED
    // --------------------------------------------------------

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

        console.log(
            "[WS] Viewer registration sent:",
            {
                sessionId: sessionId,
                role: "viewer"
            }
        );
=======
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
>>>>>>> 77ab91f (Update WebViewer UI and host status)

        setStatus(
            "Connected to signaling server. Waiting for host..."
        );
    };

<<<<<<< HEAD

    // --------------------------------------------------------
    // MESSAGE
    // --------------------------------------------------------

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


                // --------------------------------------------
                // REGISTERED
                // --------------------------------------------

                case "registered":

=======
    socket.onmessage = async (event) => {
        try {
            const message = JSON.parse(event.data);

            console.log("[WS] Message:", message.type, message);

            switch (message.type) {

                case "registered":
>>>>>>> 77ab91f (Update WebViewer UI and host status)
                    console.log(
                        "[WS] Registered as viewer:",
                        message.clientId
                    );
<<<<<<< HEAD

                    break;


                // --------------------------------------------
                // PRODUCER AVAILABLE
                //
                // IMPORTANT:
                // Protocol name stays unchanged.
                // --------------------------------------------

                case "producer-available":

                    console.log(
                        "[WS] Host available"
                    );

                    setStatus(
                        "Host available. Waiting for video..."
                    );

                    break;


                // --------------------------------------------
                // OFFER
                // --------------------------------------------

                case "offer":

                    await handleOffer(
                        message
                    );

                    break;


                // --------------------------------------------
                // ICE CANDIDATE
                // --------------------------------------------

                case "ice-candidate":

                    await handleRemoteCandidate(
                        message
                    );

                    break;


                // --------------------------------------------
                // PRODUCER LEFT
                //
                // IMPORTANT:
                // Protocol name stays unchanged.
                // --------------------------------------------

                case "producer-left":

                    console.log(
                        "[WS] Host disconnected"
                    );

                    setStatus(
                        "Host disconnected"
                    );

                    stopPeerConnection();

                    break;


                // --------------------------------------------
                // ERROR
                // --------------------------------------------

                case "error":

                    console.error(
                        "[WS] Server error:",
                        message.message
                    );

                    setStatus(
                        `Server error: ${message.message}`
                    );

                    break;


                // --------------------------------------------
                // PONG
                // --------------------------------------------

                case "pong":

                    break;


                // --------------------------------------------
                // UNKNOWN
                // --------------------------------------------

                default:

=======
                    break;

                case "producer-available":
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
    setStatus("Host disconnected");

    stopPeerConnection();
    break;

                case "error":
                    setStatus(
                        `Server error: ${message.message}`
                    );
                    break;

                case "pong":
                    break;

                default:
>>>>>>> 77ab91f (Update WebViewer UI and host status)
                    console.log(
                        "[WS] Unknown message:",
                        message
                    );
<<<<<<< HEAD

                    break;
            }

        } catch (error) {

=======
            }

        } catch (error) {
>>>>>>> 77ab91f (Update WebViewer UI and host status)
            console.error(
                "[WS] Message handling error:",
                error
            );
        }
    };

<<<<<<< HEAD

    // --------------------------------------------------------
    // ERROR
    // --------------------------------------------------------

    socket.onerror = (error) => {

        console.error(
            "[WS] Error:",
            error
        );
=======
    socket.onerror = (error) => {
        console.error("[WS] Error:", error);
>>>>>>> 77ab91f (Update WebViewer UI and host status)

        setStatus(
            "WebSocket connection error"
        );
    };

<<<<<<< HEAD

    // --------------------------------------------------------
    // CLOSED
    // --------------------------------------------------------

    socket.onclose = (event) => {

        console.log(
            "[WS] Disconnected:",
            {
                code: event.code,
                reason: event.reason
            }
        );
=======
    socket.onclose = () => {
        console.log("[WS] Disconnected");
>>>>>>> 77ab91f (Update WebViewer UI and host status)

        setStatus(
            "Signaling server disconnected"
        );
    };
}

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
// ============================================================
// CREATE PEER CONNECTION
// ============================================================

async function createPeerConnection() {

<<<<<<< HEAD
    console.log(
        "[WebRTC] Creating PeerConnection"
    );


    // Close previous connection if one exists.

    if (peerConnection) {

=======
    console.log("[WebRTC] Creating PeerConnection");

    if (peerConnection) {
>>>>>>> 77ab91f (Update WebViewer UI and host status)
        console.log(
            "[WebRTC] Closing previous PeerConnection"
        );

        peerConnection.close();
<<<<<<< HEAD

        peerConnection = null;
    }


    peerConnection =
        new RTCPeerConnection(
            rtcConfig
        );


    // --------------------------------------------------------
    // REMOTE VIDEO TRACK
=======
    }

    peerConnection = new RTCPeerConnection(rtcConfig);

    // --------------------------------------------------------
    // REMOTE TRACK
>>>>>>> 77ab91f (Update WebViewer UI and host status)
    // --------------------------------------------------------

    peerConnection.ontrack = (event) => {

        console.log(
            "[WebRTC] Remote track received:",
            event.track.kind
        );

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
        if (
            event.streams &&
            event.streams.length > 0
        ) {
<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
            videoElement.srcObject =
                event.streams[0];

        } else {

            const stream =
<<<<<<< HEAD
                new MediaStream([
                    event.track
                ]);

            videoElement.srcObject =
                stream;
        }


=======
                new MediaStream([event.track]);

            videoElement.srcObject = stream;
        }

>>>>>>> 77ab91f (Update WebViewer UI and host status)
        videoElement
            .play()
            .then(() => {

                console.log(
                    "[Video] Playback started"
                );

<<<<<<< HEAD
                setStatus(
                    "LIVE"
                );
=======
                setStatus("LIVE");
>>>>>>> 77ab91f (Update WebViewer UI and host status)

            })
            .catch((error) => {

                console.warn(
                    "[Video] Autoplay prevented:",
                    error
                );

                setStatus(
                    "Tap the video to start playback"
                );
            });
    };

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
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

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
        console.log(
            "[ICE] Local candidate:",
            event.candidate.candidate
        );

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
        if (
            !socket ||
            socket.readyState !== WebSocket.OPEN
        ) {
<<<<<<< HEAD

            console.warn(
                "[ICE] WebSocket not ready. Candidate cannot be sent."
=======
            console.warn(
                "[ICE] WebSocket not ready; local candidate cannot be sent"
>>>>>>> 77ab91f (Update WebViewer UI and host status)
            );

            return;
        }

<<<<<<< HEAD

        socket.send(
            JSON.stringify({

                type: "ice-candidate",

                sessionId:
                    sessionId,

                targetId:
                    producerId,

                sdpMLineIndex:
                    event.candidate.sdpMLineIndex,

                sdpMid:
                    event.candidate.sdpMid,

                candidate:
                    event.candidate.candidate
            })
        );
    };


=======
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

>>>>>>> 77ab91f (Update WebViewer UI and host status)
    // --------------------------------------------------------
    // ICE GATHERING STATE
    // --------------------------------------------------------

    peerConnection.onicegatheringstatechange = () => {

        console.log(
            "[ICE] Gathering state:",
            peerConnection.iceGatheringState
        );
    };

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
    // --------------------------------------------------------
    // ICE CONNECTION STATE
    // --------------------------------------------------------

    peerConnection.oniceconnectionstatechange = () => {

        console.log(
            "[ICE] Connection state:",
            peerConnection.iceConnectionState
        );

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
        switch (
            peerConnection.iceConnectionState
        ) {

            case "new":

                setStatus(
                    "Preparing video connection..."
                );

                break;

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
            case "checking":

                setStatus(
                    "Connecting video..."
                );

                break;

<<<<<<< HEAD

            case "connected":

                setStatus(
                    "LIVE"
                );

                break;


            case "completed":

                setStatus(
                    "LIVE"
                );

                break;


=======
            case "connected":

                setStatus("LIVE");

                break;

            case "completed":

                setStatus("LIVE");

                break;

>>>>>>> 77ab91f (Update WebViewer UI and host status)
            case "disconnected":

                setStatus(
                    "Video connection disconnected"
                );

                break;

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
            case "failed":

                setStatus(
                    "WebRTC connection failed"
                );

                break;

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
            case "closed":

                setStatus(
                    "Video connection closed"
                );

                break;
        }
    };

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
    // --------------------------------------------------------
    // CONNECTION STATE
    // --------------------------------------------------------

    peerConnection.onconnectionstatechange = () => {

        console.log(
            "[WebRTC] Connection state:",
            peerConnection.connectionState
        );

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
        switch (
            peerConnection.connectionState
        ) {

            case "connected":

<<<<<<< HEAD
                setStatus(
                    "LIVE"
                );

                break;


=======
                setStatus("LIVE");

                break;

>>>>>>> 77ab91f (Update WebViewer UI and host status)
            case "connecting":

                setStatus(
                    "Connecting video..."
                );

                break;

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
            case "disconnected":

                setStatus(
                    "Video connection disconnected"
                );

                break;

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
            case "failed":

                setStatus(
                    "WebRTC connection failed"
                );

                break;

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
            case "closed":

                setStatus(
                    "Video connection closed"
                );

                break;
        }
    };

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
    // --------------------------------------------------------
    // SIGNALING STATE
    // --------------------------------------------------------

    peerConnection.onsignalingstatechange = () => {

        console.log(
            "[WebRTC] Signaling state:",
            peerConnection.signalingState
        );
    };

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
    // --------------------------------------------------------
    // FLUSH QUEUED ICE CANDIDATES
    // --------------------------------------------------------

    await flushPendingIceCandidates();
}

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
// ============================================================
// HANDLE OFFER
// ============================================================

async function handleOffer(message) {

    try {

<<<<<<< HEAD
        producerId =
            message.fromId;


        console.log(
            "[WebRTC] Offer received from host:",
            producerId
        );


        // Reset candidates for the new connection.

        pendingIceCandidates = [];


        await createPeerConnection();


        // ----------------------------------------------------
        // SET REMOTE DESCRIPTION
        // ----------------------------------------------------

=======
        producerId = message.fromId;

        console.log(
            "[WebRTC] Offer received Host:",
            producerId
        );

        // Reset old ICE candidates for this new connection.
        pendingIceCandidates = [];

        await createPeerConnection();

>>>>>>> 77ab91f (Update WebViewer UI and host status)
        console.log(
            "[WebRTC] Setting remote description"
        );

<<<<<<< HEAD

        await peerConnection.setRemoteDescription(
            new RTCSessionDescription({

                type: "offer",

                sdp:
                    message.sdp
            })
        );


=======
        await peerConnection.setRemoteDescription(
            new RTCSessionDescription({
                type: "offer",
                sdp: message.sdp
            })
        );

>>>>>>> 77ab91f (Update WebViewer UI and host status)
        console.log(
            "[WebRTC] Remote description set"
        );

<<<<<<< HEAD

        // ----------------------------------------------------
        // ADD ANY ICE CANDIDATES THAT ARRIVED EARLY
        // ----------------------------------------------------

        await flushPendingIceCandidates();


        // ----------------------------------------------------
        // CREATE ANSWER
        // ----------------------------------------------------

=======
        // Some candidates may have arrived while
        // setRemoteDescription was being processed.
        await flushPendingIceCandidates();

>>>>>>> 77ab91f (Update WebViewer UI and host status)
        console.log(
            "[WebRTC] Creating answer"
        );

<<<<<<< HEAD

        const answer =
            await peerConnection.createAnswer();


=======
        const answer =
            await peerConnection.createAnswer();

>>>>>>> 77ab91f (Update WebViewer UI and host status)
        await peerConnection.setLocalDescription(
            answer
        );

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
        console.log(
            "[WebRTC] Local description set"
        );

<<<<<<< HEAD

        // ----------------------------------------------------
        // SEND ANSWER
        // ----------------------------------------------------

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
        if (
            socket &&
            socket.readyState === WebSocket.OPEN
        ) {

<<<<<<< HEAD
            socket.send(
                JSON.stringify({

                    type: "answer",

                    sessionId:
                        sessionId,

                    targetId:
                        producerId,

                    sdp:
                        answer.sdp
                })
            );


            console.log(
                "[WebRTC] Answer sent to host"
            );


=======
            socket.send(JSON.stringify({
                type: "answer",
                sessionId: sessionId,
                targetId: producerId,
                sdp: answer.sdp
            }));

            console.log(
                "[WebRTC] Answer sent to producer"
            );

>>>>>>> 77ab91f (Update WebViewer UI and host status)
            setStatus(
                "Answer sent. Connecting video..."
            );

        } else {

            console.error(
                "[WebRTC] WebSocket is not connected"
            );

            setStatus(
                "Signaling connection lost"
            );
        }

    } catch (error) {

        console.error(
            "[WebRTC] Offer handling failed:",
            error
        );

        setStatus(
            "Failed to establish WebRTC connection"
        );
    }
}

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
// ============================================================
// HANDLE REMOTE ICE CANDIDATE
// ============================================================

async function handleRemoteCandidate(message) {

    try {

        console.log(
            "[ICE] Remote candidate received:",
            message.candidate
        );

<<<<<<< HEAD

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
        // PEER CONNECTION / REMOTE DESCRIPTION NOT READY
=======
        const candidate = new RTCIceCandidate({
            candidate: message.candidate,
            sdpMid: message.sdpMid,
            sdpMLineIndex: message.sdpMLineIndex
        });

        // ----------------------------------------------------
        // If PeerConnection or remote description isn't ready,
        // queue the candidate instead of losing it.
>>>>>>> 77ab91f (Update WebViewer UI and host status)
        // ----------------------------------------------------

        if (
            !peerConnection ||
            !peerConnection.remoteDescription
        ) {

            console.log(
<<<<<<< HEAD
                "[ICE] PeerConnection or remote description not ready."
=======
                "[ICE] PeerConnection/remote description not ready."
>>>>>>> 77ab91f (Update WebViewer UI and host status)
            );

            console.log(
                "[ICE] Queueing remote candidate."
            );

<<<<<<< HEAD

            pendingIceCandidates.push(
                candidate
            );
=======
            pendingIceCandidates.push(candidate);
>>>>>>> 77ab91f (Update WebViewer UI and host status)

            return;
        }

<<<<<<< HEAD

        // ----------------------------------------------------
        // ADD CANDIDATE
        // ----------------------------------------------------

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
        await peerConnection.addIceCandidate(
            candidate
        );

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
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

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
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

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
    if (
        pendingIceCandidates.length === 0
    ) {

        return;
    }

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
    console.log(
        `[ICE] Flushing ${pendingIceCandidates.length} queued candidates`
    );

<<<<<<< HEAD

    const candidates =
        [...pendingIceCandidates];


    pendingIceCandidates = [];


=======
    const candidates =
        [...pendingIceCandidates];

    pendingIceCandidates = [];

>>>>>>> 77ab91f (Update WebViewer UI and host status)
    for (
        const candidate of candidates
    ) {

        try {

            await peerConnection.addIceCandidate(
                candidate
            );

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
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

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
// ============================================================
// STOP PEER CONNECTION
// ============================================================

function stopPeerConnection() {

    console.log(
        "[WebRTC] Stopping PeerConnection"
    );

<<<<<<< HEAD

    if (peerConnection) {

        peerConnection.ontrack = null;

        peerConnection.onicecandidate = null;

        peerConnection.onconnectionstatechange =
            null;

        peerConnection.oniceconnectionstatechange =
            null;
=======
    if (peerConnection) {

        peerConnection.ontrack = null;
        peerConnection.onicecandidate = null;
        peerConnection.onconnectionstatechange = null;
        peerConnection.oniceconnectionstatechange = null;
>>>>>>> 77ab91f (Update WebViewer UI and host status)

        peerConnection.close();

        peerConnection = null;
    }

<<<<<<< HEAD

    pendingIceCandidates = [];


    videoElement.srcObject = null;


    producerId = null;
}


=======
    pendingIceCandidates = [];

    videoElement.srcObject = null;

    producerId = null;
}

>>>>>>> 77ab91f (Update WebViewer UI and host status)
// ============================================================
// VIDEO FPS
// ============================================================

function updateFPS() {

<<<<<<< HEAD
    const now =
        performance.now();

=======
    const now = performance.now();
>>>>>>> 77ab91f (Update WebViewer UI and host status)

    const elapsed =
        now - lastFPSCheck;

<<<<<<< HEAD

    if (elapsed >= 1000) {

        const fps =
            renderedFrames *
            1000 /
            elapsed;

=======
    if (elapsed >= 1000) {

        const fps =
            renderedFrames * 1000 / elapsed;
>>>>>>> 77ab91f (Update WebViewer UI and host status)

        fpsElement.textContent =
            `FPS: ${fps.toFixed(1)}`;

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
        renderedFrames = 0;

        lastFPSCheck = now;
    }

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
    requestAnimationFrame(
        updateFPS
    );
}

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
// ============================================================
// VIDEO FRAME CALLBACK
// ============================================================

if (
    "requestVideoFrameCallback"
    in HTMLVideoElement.prototype
) {

    function countVideoFrame() {

        renderedFrames++;

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
        videoElement.requestVideoFrameCallback(
            countVideoFrame
        );
    }

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
    videoElement.requestVideoFrameCallback(
        countVideoFrame
    );

} else {

    console.warn(
        "[Video] requestVideoFrameCallback not supported; using fallback"
    );

<<<<<<< HEAD

    videoElement.addEventListener(
        "timeupdate",
        () => {

=======
    videoElement.addEventListener(
        "timeupdate",
        () => {
>>>>>>> 77ab91f (Update WebViewer UI and host status)
            renderedFrames++;
        }
    );
}

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
// ============================================================
// START FPS LOOP
// ============================================================

requestAnimationFrame(
    updateFPS
);

<<<<<<< HEAD

=======
>>>>>>> 77ab91f (Update WebViewer UI and host status)
// ============================================================
// CLEANUP
// ============================================================

window.addEventListener(
    "beforeunload",
    () => {

        stopPeerConnection();

<<<<<<< HEAD

        if (socket) {

            socket.close();

            socket = null;
=======
        if (socket) {
            socket.close();
>>>>>>> 77ab91f (Update WebViewer UI and host status)
        }
    }
);