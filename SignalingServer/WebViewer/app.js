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


// ============================================================
// STATUS
// ============================================================

function setStatus(message) {
    statusElement.textContent = message;
    console.log("[WebViewer]", message);
}


// ============================================================
// SESSION CHECK
// ============================================================

if (!sessionId) {

    setStatus("Missing session ID");

} else {

    setStatus(
        `Connecting to session: ${sessionId}`
    );

    connectSignaling();
}


// ============================================================
// SIGNALING SERVER
// ============================================================

function connectSignaling() {

    const protocol =
        window.location.protocol === "https:"
            ? "wss:"
            : "ws:";

    // IMPORTANT:
    // Python server WebSocket endpoint is /ws
    const wsURL =
        `${protocol}//${window.location.host}/ws`;

    console.log(
        "[WS] Connecting to:",
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
            "[WS] Register message sent:",
            {
                sessionId: sessionId,
                role: "viewer"
            }
        );

        setStatus(
            "Connected to signaling server. Waiting for producer..."
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

                    setStatus(
                        "Connected. Waiting for producer..."
                    );

                    break;


                // --------------------------------------------
                // PRODUCER AVAILABLE
                // --------------------------------------------

                case "producer-available":

                    console.log(
                        "[WS] Producer available"
                    );

                    setStatus(
                        "Producer available. Waiting for video..."
                    );

                    break;


                // --------------------------------------------
                // OFFER
                // --------------------------------------------

                case "offer":

                    await handleOffer(message);

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
                // --------------------------------------------

                case "producer-left":

                    console.log(
                        "[WS] Producer disconnected"
                    );

                    setStatus(
                        "Producer disconnected"
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

                    console.log(
                        "[WS] Pong received"
                    );

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
                "[WS] Message parsing error:",
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
            "[WS] Disconnected",
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
// CREATE WEBRTC PEER CONNECTION
// ============================================================

async function createPeerConnection() {

    if (peerConnection) {

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
            "[WebRTC] Remote track received"
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

                setStatus("LIVE");

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

        if (
            !event.candidate ||
            !socket ||
            socket.readyState !== WebSocket.OPEN
        ) {

            return;
        }


        const candidateMessage = {

            type: "ice-candidate",

            sessionId: sessionId,

            targetId: producerId,

            sdpMLineIndex:
                event.candidate.sdpMLineIndex,

            sdpMid:
                event.candidate.sdpMid,

            candidate:
                event.candidate.candidate
        };


        console.log(
            "[WebRTC] Sending ICE candidate"
        );


        socket.send(
            JSON.stringify(
                candidateMessage
            )
        );
    };


    // --------------------------------------------------------
    // CONNECTION STATE
    // --------------------------------------------------------

    peerConnection.onconnectionstatechange = () => {

        const state =
            peerConnection.connectionState;

        console.log(
            "[WebRTC] Connection state:",
            state
        );


        switch (state) {

            case "connected":

                setStatus("LIVE");

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
    // ICE CONNECTION STATE
    // --------------------------------------------------------

    peerConnection.oniceconnectionstatechange = () => {

        console.log(
            "[WebRTC] ICE state:",
            peerConnection.iceConnectionState
        );
    };
}


// ============================================================
// HANDLE WEBRTC OFFER
// ============================================================

async function handleOffer(message) {

    try {

        producerId =
            message.fromId;


        console.log(
            "[WebRTC] Offer received from producer:",
            producerId
        );


        await createPeerConnection();


        // ----------------------------------------------------
        // SET REMOTE DESCRIPTION
        // ----------------------------------------------------

        await peerConnection.setRemoteDescription(
            new RTCSessionDescription({
                type: "offer",
                sdp: message.sdp
            })
        );


        console.log(
            "[WebRTC] Remote description set"
        );


        // ----------------------------------------------------
        // CREATE ANSWER
        // ----------------------------------------------------

        const answer =
            await peerConnection.createAnswer();


        await peerConnection.setLocalDescription(
            answer
        );


        console.log(
            "[WebRTC] Answer created"
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

                    sessionId: sessionId,

                    targetId: producerId,

                    sdp: answer.sdp
                })
            );


            console.log(
                "[WebRTC] Answer sent to producer"
            );

        } else {

            console.error(
                "[WebRTC] WebSocket is not connected"
            );

            setStatus(
                "Signaling connection lost"
            );

            return;
        }


        setStatus(
            "Answer sent. Connecting video..."
        );

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

        if (!peerConnection) {

            console.warn(
                "[ICE] Peer connection not ready"
            );

            return;
        }


        await peerConnection.addIceCandidate(
            new RTCIceCandidate({

                candidate:
                    message.candidate,

                sdpMid:
                    message.sdpMid,

                sdpMLineIndex:
                    message.sdpMLineIndex
            })
        );


        console.log(
            "[ICE] Remote candidate added"
        );

    } catch (error) {

        console.error(
            "[ICE] Failed to add candidate:",
            error
        );
    }
}


// ============================================================
// STOP WEBRTC
// ============================================================

function stopPeerConnection() {

    if (peerConnection) {

        peerConnection.close();

        peerConnection = null;
    }


    videoElement.srcObject = null;

    producerId = null;
}


// ============================================================
// FPS COUNTER
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
// VIDEO FRAME COUNTING
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
        "requestVideoFrameCallback not supported; using playback event fallback"
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