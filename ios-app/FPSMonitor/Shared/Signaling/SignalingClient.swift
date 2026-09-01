import Foundation

protocol SignalingClientDelegate: AnyObject {
    func signalingDidConnect(_ client: SignalingClient)
    func signalingDidDisconnect(_ client: SignalingClient, error: Error?)
    func signaling(_ client: SignalingClient, didReceiveOffer sdp: String, fromId: String)
    func signaling(_ client: SignalingClient, didReceiveAnswer sdp: String, fromId: String)
    func signaling(_ client: SignalingClient, didReceiveCandidate sdpMLineIndex: Int32, sdpMid: String?, candidate: String, fromId: String)
    func signaling(_ client: SignalingClient, producerAvailable sessionId: String)
    func signaling(_ client: SignalingClient, producerLeft sessionId: String)
    func signaling(_ client: SignalingClient, viewerJoined viewerId: String)
    func signaling(_ client: SignalingClient, didFailWithMessage message: String)
}

// Default no-op so conformers only implement what they need.
extension SignalingClientDelegate {
    func signaling(_ client: SignalingClient, didFailWithMessage message: String) {}
}

/// Thin JSON-over-WebSocket client. Talks to SignalingServer/server.js.
/// Not responsible for any WebRTC logic itself — just message plumbing.
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
        session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    }

    func connect(to info: ConnectionInfo, role: DeviceRole) {
        guard let url = info.signalingURL else { return }
        self.sessionId = info.sessionId
        self.role = role

        task = session.webSocketTask(with: url)
        task?.resume()
        listen()
        register()
        startPing()
    }

    func disconnect() {
        pingTimer?.invalidate()
        pingTimer = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    private func startPing() {
        pingTimer?.invalidate()
        pingTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            self?.send(["type": "ping"])
        }
    }

    private func register() {
        send(["type": "register", "sessionId": sessionId, "role": role.rawValue])
    }

    func sendOffer(sdp: String, targetId: String? = nil) {
        var msg: [String: Any] = ["type": "offer", "sessionId": sessionId, "sdp": sdp]
        if let targetId { msg["targetId"] = targetId }
        send(msg)
    }

    func sendAnswer(sdp: String, targetId: String) {
        send(["type": "answer", "sessionId": sessionId, "sdp": sdp, "targetId": targetId])
    }

    func sendCandidate(sdpMLineIndex: Int32, sdpMid: String?, candidate: String, targetId: String? = nil) {
        var msg: [String: Any] = [
            "type": "ice-candidate",
            "sessionId": sessionId,
            "sdpMLineIndex": sdpMLineIndex,
            "candidate": candidate
        ]
        if let sdpMid { msg["sdpMid"] = sdpMid }
        if let targetId { msg["targetId"] = targetId }
        send(msg)
    }

    private func send(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let str = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(str)) { error in
            if let error {
                print("[SignalingClient] send error: \(error)")
            }
        }
    }

    private func listen() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                self.delegate?.signalingDidDisconnect(self, error: error)
                return
            case .success(let message):
                if case .string(let text) = message {
                    self.handle(text)
                }
                self.listen() // keep listening
            }
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = dict["type"] as? String else { return }

        switch type {
        case "registered":
            clientId = dict["clientId"] as? String
            delegate?.signalingDidConnect(self)

        case "offer":
            if let sdp = dict["sdp"] as? String, let fromId = dict["fromId"] as? String {
                delegate?.signaling(self, didReceiveOffer: sdp, fromId: fromId)
            }

        case "answer":
            if let sdp = dict["sdp"] as? String, let fromId = dict["fromId"] as? String {
                delegate?.signaling(self, didReceiveAnswer: sdp, fromId: fromId)
            }

        case "ice-candidate":
            if let candidate = dict["candidate"] as? String,
               let fromId = dict["fromId"] as? String {
                let idx = (dict["sdpMLineIndex"] as? NSNumber)?.int32Value ?? 0
                let mid = dict["sdpMid"] as? String
                delegate?.signaling(self, didReceiveCandidate: idx, sdpMid: mid, candidate: candidate, fromId: fromId)
            }

        case "producer-available":
            if let sessionId = dict["sessionId"] as? String {
                delegate?.signaling(self, producerAvailable: sessionId)
            }

        case "producer-left":
            if let sessionId = dict["sessionId"] as? String {
                delegate?.signaling(self, producerLeft: sessionId)
            }

        case "viewer-joined":
            if let viewerId = dict["viewerId"] as? String {
                delegate?.signaling(self, viewerJoined: viewerId)
            }

        case "pong":
            break

        case "error":
            let message = (dict["message"] as? String) ?? "Unknown signaling error"
            delegate?.signaling(self, didFailWithMessage: message)

        default:
            print("[SignalingClient] unhandled message type: \(type)")
        }
    }
}

extension SignalingClient: URLSessionWebSocketDelegate {
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        // handled via "registered" response instead, to be sure registration succeeded
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        delegate?.signalingDidDisconnect(self, error: nil)
    }
}
