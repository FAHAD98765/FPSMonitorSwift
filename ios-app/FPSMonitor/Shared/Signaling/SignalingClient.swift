import Foundation

protocol SignalingClientDelegate: AnyObject {


func signalingDidConnect(_ client: SignalingClient)

func signalingDidDisconnect(
    _ client: SignalingClient,
    error: Error?
)

func signaling(
    _ client: SignalingClient,
    didReceiveOffer sdp: String,
    fromId: String
)

func signaling(
    _ client: SignalingClient,
    didReceiveAnswer sdp: String,
    fromId: String
)

func signaling(
    _ client: SignalingClient,
    didReceiveCandidate sdpMLineIndex: Int32,
    sdpMid: String?,
    candidate: String,
    fromId: String
)

func signaling(
    _ client: SignalingClient,
    producerAvailable sessionId: String
)

func signaling(
    _ client: SignalingClient,
    producerLeft sessionId: String
)

func signaling(
    _ client: SignalingClient,
    viewerJoined viewerId: String
)

func signaling(
    _ client: SignalingClient,
    didFailWithMessage message: String
)


}

// MARK: - Default Delegate Methods

extension SignalingClientDelegate {


func signaling(
    _ client: SignalingClient,
    didFailWithMessage message: String
) {
    // Default no-op
}


}

// MARK: - Signaling Client

final class SignalingClient: NSObject {


weak var delegate: SignalingClientDelegate?

private var task: URLSessionWebSocketTask?

private var session: URLSession!

private(set) var sessionId: String = ""

private(set) var role: DeviceRole = .viewer

private(set) var clientId: String?

private var pingTimer: Timer?




override init() {

    super.init()

    session = URLSession(
        configuration: .default,
        delegate: self,
        delegateQueue: nil
    )
}


// MARK: - Connect

func connect(
    to info: ConnectionInfo,
    role: DeviceRole
) {

    guard let url = info.signalingURL else {

        print(
            "[SignalingClient] ERROR: Invalid signaling URL"
        )

        return
    }

    self.sessionId = info.sessionId
    self.role = role


    print("")
    print("==============================================")
    print("[SignalingClient] CONNECTING")
    print("==============================================")
    print("[SignalingClient] URL: \(url)")
    print("[SignalingClient] Session: \(sessionId)")
    print("[SignalingClient] Role: \(role.rawValue)")
    print("==============================================")
    print("")


    // Close existing connection if there is one.

    if let existingTask = task {

        print(
            "[SignalingClient] Closing existing WebSocket"
        )

        existingTask.cancel(
            with: .goingAway,
            reason: nil
        )

        task = nil
    }


    // Create WebSocket.

    let webSocketTask = session.webSocketTask(
        with: url
    )

    task = webSocketTask


    // Start WebSocket.

    webSocketTask.resume()

    print(
        "[SignalingClient] WebSocket task resumed"
    )


    // Start receiving messages.

    listen()


    // IMPORTANT:
    //
    // register() is NOT called here.
    //
    // It will be called from
    // didOpenWithProtocol() after the
    // WebSocket connection is actually open.
}


// MARK: - Disconnect

func disconnect() {

    print(
        "[SignalingClient] Disconnecting"
    )

    pingTimer?.invalidate()
    pingTimer = nil

    task?.cancel(
        with: .goingAway,
        reason: nil
    )

    task = nil

    clientId = nil
}


// MARK: - Ping

private func startPing() {

    pingTimer?.invalidate()

    pingTimer = Timer.scheduledTimer(
        withTimeInterval: 15,
        repeats: true
    ) { [weak self] _ in

        guard let self = self else {
            return
        }

        print(
            "[SignalingClient] Sending ping"
        )

        self.send([
            "type": "ping"
        ])
    }
}


// MARK: - Register

private func register() {

    print("")
    print(
        "[SignalingClient] REGISTERING"
    )
    print(
        "[SignalingClient] Session ID: \(sessionId)"
    )
    print(
        "[SignalingClient] Role: \(role.rawValue)"
    )
    print("")


    send([
        "type": "register",
        "sessionId": sessionId,
        "role": role.rawValue
    ])
}


// MARK: - Send Offer

func sendOffer(
    sdp: String,
    targetId: String? = nil
) {

    var message: [String: Any] = [
        "type": "offer",
        "sessionId": sessionId,
        "sdp": sdp
    ]


    if let targetId = targetId {

        message["targetId"] = targetId

        print(
            "[SignalingClient] Sending offer to: \(targetId)"
        )

    } else {

        print(
            "[SignalingClient] Sending offer"
        )
    }


    send(message)
}


// MARK: - Send Answer

func sendAnswer(
    sdp: String,
    targetId: String
) {

    print(
        "[SignalingClient] Sending answer to: \(targetId)"
    )


    send([
        "type": "answer",
        "sessionId": sessionId,
        "sdp": sdp,
        "targetId": targetId
    ])
}


// MARK: - Send ICE Candidate

func sendCandidate(
    sdpMLineIndex: Int32,
    sdpMid: String?,
    candidate: String,
    targetId: String? = nil
) {

    var message: [String: Any] = [
        "type": "ice-candidate",
        "sessionId": sessionId,
        "sdpMLineIndex": sdpMLineIndex,
        "candidate": candidate
    ]


    if let sdpMid = sdpMid {

        message["sdpMid"] = sdpMid
    }


    if let targetId = targetId {

        message["targetId"] = targetId

        print(
            "[SignalingClient] Sending ICE candidate to: \(targetId)"
        )

    } else {

        print(
            "[SignalingClient] Sending ICE candidate"
        )
    }


    send(message)
}


// MARK: - Send JSON

private func send(
    _ dict: [String: Any]
) {

    guard let data = try? JSONSerialization.data(
        withJSONObject: dict,
        options: []
    ) else {

        print(
            "[SignalingClient] ERROR: JSON serialization failed"
        )

        return
    }


    guard let string = String(
        data: data,
        encoding: .utf8
    ) else {

        print(
            "[SignalingClient] ERROR: JSON string conversion failed"
        )

        return
    }


    guard let task = task else {

        print(
            "[SignalingClient] ERROR: WebSocket task is nil"
        )

        return
    }


    guard task.state == .running else {

        print(
            "[SignalingClient] ERROR: WebSocket is not running. State = \(task.state.rawValue)"
        )

        return
    }


    print(
        "[SignalingClient] -> \(string)"
    )


    task.send(.string(string)) { error in

        if let error = error {

            print(
                "[SignalingClient] SEND ERROR: \(error)"
            )

        } else {

            print(
                "[SignalingClient] Message sent successfully"
            )
        }
    }
}


// MARK: - Listen

private func listen() {

    guard let task = task else {

        print(
            "[SignalingClient] ERROR: Cannot listen. Task is nil."
        )

        return
    }


    task.receive { [weak self] result in

        guard let self = self else {
            return
        }


        switch result {

        case .failure(let error):

            print("")
            print(
                "[SignalingClient] WEBSOCKET RECEIVE ERROR"
            )
            print(
                "[SignalingClient] \(error)"
            )
            print("")


            self.delegate?.signalingDidDisconnect(
                self,
                error: error
            )


        case .success(let message):

            switch message {

            case .string(let text):

                print(
                    "[SignalingClient] <- \(text)"
                )

                self.handle(text)


            case .data(let data):

                print(
                    "[SignalingClient] Received binary data: \(data.count) bytes"
                )


            @unknown default:

                print(
                    "[SignalingClient] Unknown WebSocket message"
                )
            }


            // Continue listening.

            self.listen()
        }
    }
}


// MARK: - Handle Message

private func handle(
    _ text: String
) {

    guard let data = text.data(
        using: .utf8
    ) else {

        print(
            "[SignalingClient] ERROR: Invalid UTF-8"
        )

        return
    }


    guard let dict = try? JSONSerialization.jsonObject(
        with: data,
        options: []
    ) as? [String: Any] else {

        print(
            "[SignalingClient] ERROR: Invalid JSON"
        )

        return
    }


    guard let type = dict["type"] as? String else {

        print(
            "[SignalingClient] ERROR: Message has no type"
        )

        return
    }


    print(
        "[SignalingClient] Handling type: \(type)"
    )


    switch type {


    // MARK: Registered

    case "registered":

        clientId = dict["clientId"] as? String


        print("")
        print(
            "=============================================="
        )
        print(
            "[SignalingClient] REGISTERED SUCCESSFULLY"
        )
        print(
            "=============================================="
        )


        if let clientId = clientId {

            print(
                "[SignalingClient] Client ID: \(clientId)"
            )
        }


        print(
            "[SignalingClient] Session: \(sessionId)"
        )

        print(
            "[SignalingClient] Role: \(role.rawValue)"
        )


        print(
            "=============================================="
        )
        print("")


        delegate?.signalingDidConnect(
            self
        )


    // MARK: Offer

    case "offer":

        guard
            let sdp = dict["sdp"] as? String,
            let fromId = dict["fromId"] as? String
        else {

            print(
                "[SignalingClient] ERROR: Invalid offer"
            )

            return
        }


        print(
            "[SignalingClient] Offer received from: \(fromId)"
        )


        delegate?.signaling(
            self,
            didReceiveOffer: sdp,
            fromId: fromId
        )


    // MARK: Answer

    case "answer":

        guard
            let sdp = dict["sdp"] as? String,
            let fromId = dict["fromId"] as? String
        else {

            print(
                "[SignalingClient] ERROR: Invalid answer"
            )

            return
        }


        print(
            "[SignalingClient] Answer received from: \(fromId)"
        )


        delegate?.signaling(
            self,
            didReceiveAnswer: sdp,
            fromId: fromId
        )


    // MARK: ICE Candidate

    case "ice-candidate":

        guard
            let candidate = dict["candidate"] as? String,
            let fromId = dict["fromId"] as? String
        else {

            print(
                "[SignalingClient] ERROR: Invalid ICE candidate"
            )

            return
        }


        let index = (
            dict["sdpMLineIndex"] as? NSNumber
        )?.int32Value ?? 0


        let mid = dict["sdpMid"] as? String


        print(
            "[SignalingClient] ICE candidate received from: \(fromId)"
        )


        delegate?.signaling(
            self,
            didReceiveCandidate: index,
            sdpMid: mid,
            candidate: candidate,
            fromId: fromId
        )


    // MARK: Producer Available

    case "producer-available":

        guard let sessionId =
            dict["sessionId"] as? String else {

            print(
                "[SignalingClient] ERROR: Invalid producer-available"
            )

            return
        }


        print(
            "[SignalingClient] Producer available: \(sessionId)"
        )


        delegate?.signaling(
            self,
            producerAvailable: sessionId
        )


    // MARK: Producer Left

    case "producer-left":

        guard let sessionId =
            dict["sessionId"] as? String else {

            print(
                "[SignalingClient] ERROR: Invalid producer-left"
            )

            return
        }


        print(
            "[SignalingClient] Producer left: \(sessionId)"
        )


        delegate?.signaling(
            self,
            producerLeft: sessionId
        )


    // MARK: Viewer Joined

    case "viewer-joined":

        guard let viewerId =
            dict["viewerId"] as? String else {

            print(
                "[SignalingClient] ERROR: Invalid viewer-joined"
            )

            return
        }


        print(
            "[SignalingClient] Viewer joined: \(viewerId)"
        )


        delegate?.signaling(
            self,
            viewerJoined: viewerId
        )


    // MARK: Pong

    case "pong":

        print(
            "[SignalingClient] Pong received"
        )


    // MARK: Error

    case "error":

        let message =
            dict["message"] as? String
            ?? "Unknown signaling error"


        print(
            "[SignalingClient] SERVER ERROR: \(message)"
        )


        delegate?.signaling(
            self,
            didFailWithMessage: message
        )


    // MARK: Unknown

    default:

        print(
            "[SignalingClient] Unhandled message type: \(type)"
        )
    }
}


}

// MARK: - URLSessionWebSocketDelegate

extension SignalingClient: URLSessionWebSocketDelegate {


func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol protocolName: String?
) {

    print("")
    print(
        "=============================================="
    )
    print(
        "[SignalingClient] WEBSOCKET OPENED"
    )
    print(
        "=============================================="
    )


    if let protocolName = protocolName {

        print(
            "[SignalingClient] Protocol: \(protocolName)"
        )

    } else {

        print(
            "[SignalingClient] Protocol: none"
        )
    }


    print(
        "[SignalingClient] Session: \(sessionId)"
    )

    print(
        "[SignalingClient] Role: \(role.rawValue)"
    )

    print(
        "[SignalingClient] Sending registration..."
    )


    print(
        "=============================================="
    )
    print("")


    // Register ONLY after WebSocket is open.

    register()

    startPing()
}


func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
) {

    var reasonText = "none"


    if let reason = reason {

        if let text = String(
            data: reason,
            encoding: .utf8
        ) {

            reasonText = text
        }
    }


    print("")
    print(
        "=============================================="
    )
    print(
        "[SignalingClient] WEBSOCKET CLOSED"
    )
    print(
        "[SignalingClient] Code: \(closeCode.rawValue)"
    )
    print(
        "[SignalingClient] Reason: \(reasonText)"
    )
    print(
        "=============================================="
    )
    print("")


    pingTimer?.invalidate()
    pingTimer = nil


    delegate?.signalingDidDisconnect(
        self,
        error: nil
    )
}


}
