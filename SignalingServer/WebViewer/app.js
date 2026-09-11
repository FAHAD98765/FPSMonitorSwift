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

// Keep internal variable name because signaling protocol
// still uses producer terminology.
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
// WEBRTC CONFIG
// ============================================================

const rtcConfig = {
    iceServers: [
        {
            urls: "stun:stun.l.google.com:19302"
        }
    ]
};


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


// ============================================================
// WEBSOCKET SIGNALING
// ============================================================

function connectSignaling() {

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

        setStatus(
            "Connected to signaling server. Waiting for host..."
        );
    };


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

                    console.log(
                        "[WS] Registered as viewer:",
                        message.clientId
                    );

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

                    console.log(
                        "[WS] Unknown message:",
                        message
                    );

                    break;
            }

        } catch (error) {

            console.error(
                "[WS] Message handling error:",
                error
            );
        }
    };


    // --------------------------------------------------------
    // ERROR
    // --------------------------------------------------------

    socket.onerror = (error) => {

        console.error(
            "[WS] Error:",
            error
        );

        setStatus(
            "WebSocket connection error"
        );
    };


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
        "[WebRTC] Creating PeerConnection"
    );


    // Close previous connection if one exists.

    if (peerConnection) {

        console.log(
            "[WebRTC] Closing previous PeerConnection"
        );

        peerConnection.close();

        peerConnection = null;
    }


    peerConnection =
        new RTCPeerConnection(
            rtcConfig
        );


    // --------------------------------------------------------
    // REMOTE VIDEO TRACK
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

                setStatus(
                    "LIVE"
                );

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
                "[ICE] WebSocket not ready. Candidate cannot be sent."
            );

            return;
        }


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

                setStatus(
                    "Preparing video connection..."
                );

                break;


            case "checking":

                setStatus(
                    "Connecting video..."
                );

                break;


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


            case "disconnected":

                setStatus(
                    "Video connection disconnected"
                );

                break;


            case "failed":

                setStatus(
                    "WebRTC connection failed"
                );

                break;


            case "closed":

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

                setStatus(
                    "LIVE"
                );

                break;


            case "connecting":

                setStatus(
                    "Connecting video..."
                );

                break;


            case "disconnected":

                setStatus(
                    "Video connection disconnected"
                );

                break;


            case "failed":

                setStatus(
                    "WebRTC connection failed"
                );

                break;


            case "closed":

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

        console.log(
            "[WebRTC] Setting remote description"
        );


        await peerConnection.setRemoteDescription(
            new RTCSessionDescription({

                type: "offer",

                sdp:
                    message.sdp
            })
        );


        console.log(
            "[WebRTC] Remote description set"
        );


        // ----------------------------------------------------
        // ADD ANY ICE CANDIDATES THAT ARRIVED EARLY
        // ----------------------------------------------------

        await flushPendingIceCandidates();


        // ----------------------------------------------------
        // CREATE ANSWER
        // ----------------------------------------------------

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


        // ----------------------------------------------------
        // SEND ANSWER
        // ----------------------------------------------------

        if (
            socket &&
            socket.readyState === WebSocket.OPEN
        ) {

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
        // PEER CONNECTION / REMOTE DESCRIPTION NOT READY
        // ----------------------------------------------------

        if (
            !peerConnection ||
            !peerConnection.remoteDescription
        ) {

            console.log(
                "[ICE] PeerConnection or remote description not ready."
            );

            console.log(
                "[ICE] Queueing remote candidate."
            );


            pendingIceCandidates.push(
                candidate
            );

            return;
        }


        // ----------------------------------------------------
        // ADD CANDIDATE
        // ----------------------------------------------------

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

        peerConnection.onconnectionstatechange =
            null;

        peerConnection.oniceconnectionstatechange =
            null;

        peerConnection.close();

        peerConnection = null;
    }


    pendingIceCandidates = [];


    videoElement.srcObject = null;


    producerId = null;
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
            renderedFrames *
            1000 /
            elapsed;


        fpsElement.textContent =
            `FPS: ${fps.toFixed(1)}`;


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
// CLEANUP
// ============================================================

window.addEventListener(
    "beforeunload",
    () => {

        stopPeerConnection();


        if (socket) {

            socket.close();

            socket = null;
        }
    }
);