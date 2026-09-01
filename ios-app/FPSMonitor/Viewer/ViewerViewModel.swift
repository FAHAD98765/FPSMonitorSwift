import Foundation
import Combine
import WebRTC

final class ViewerViewModel: NSObject, ObservableObject {

    // Connection setup
    @Published var host: String = ""
    @Published var port: String = String(AppConfig.defaultSignalingPort)
    @Published var sessionId: String = AppConfig.defaultSessionId
    @Published var isConnected: Bool = false
    @Published var signalingConnected: Bool = false
    @Published var remoteVideoTrack: RTCVideoTrack?
    @Published var statusMessage: String = "Not connected"
    @Published var connectionState: RTCIceConnectionState = .new

    let fpsMonitor = FPSMonitor()

    private let signaling = SignalingClient()
    private let webRTC = WebRTCManager()
    private var producerPeerId: String?

    override init() {
        super.init()
        signaling.delegate = self
        webRTC.delegate = self
    }

    func applyScanned(_ info: ConnectionInfo) {
        host = info.host
        port = String(info.port)
        sessionId = info.sessionId
    }

    func connect() {
        guard !host.isEmpty, let portNum = Int(port) else {
            statusMessage = "Enter a valid host/port"
            return
        }
        statusMessage = "Connecting to signaling server..."
        fpsMonitor.start()
        let info = ConnectionInfo(host: host, port: portNum, sessionId: sessionId)
        signaling.connect(to: info, role: .viewer)
    }

    func disconnect() {
        webRTC.closeAll()
        signaling.disconnect()
        fpsMonitor.stop()
        fpsMonitor.reset()
        isConnected = false
        signalingConnected = false
        remoteVideoTrack = nil
        producerPeerId = nil
        connectionState = .new
        statusMessage = "Disconnected"
    }

    /// Called by the view every time a frame is actually decoded/rendered on screen.
    func onFrameRendered() {
        fpsMonitor.recordFrame()
    }
}

// MARK: - SignalingClientDelegate

extension ViewerViewModel: SignalingClientDelegate {
    func signalingDidConnect(_ client: SignalingClient) {
        DispatchQueue.main.async {
            self.signalingConnected = true
            self.statusMessage = "Waiting for producer..."
        }
    }

    func signalingDidDisconnect(_ client: SignalingClient, error: Error?) {
        DispatchQueue.main.async {
            self.signalingConnected = false
            self.isConnected = false
            self.statusMessage = error != nil ? "Disconnected: \(error!.localizedDescription)" : "Disconnected"
        }
    }

    func signaling(_ client: SignalingClient, didReceiveOffer sdp: String, fromId: String) {
        producerPeerId = fromId
        DispatchQueue.main.async {
            self.statusMessage = "Producer found. Negotiating..."
        }
        webRTC.handleRemoteOffer(sdp, fromPeer: fromId) { [weak self] answerSdp in
            guard let self, let answerSdp else { return }
            self.signaling.sendAnswer(sdp: answerSdp, targetId: fromId)
        }
    }

    func signaling(_ client: SignalingClient, didReceiveAnswer sdp: String, fromId: String) {
        // Viewer never sends an offer, so it never receives an answer.
    }

    func signaling(_ client: SignalingClient, didReceiveCandidate sdpMLineIndex: Int32, sdpMid: String?, candidate: String, fromId: String) {
        webRTC.addRemoteCandidate(sdpMLineIndex: sdpMLineIndex, sdpMid: sdpMid, candidate: candidate, forPeer: fromId)
    }

    func signaling(_ client: SignalingClient, producerAvailable sessionId: String) {
        DispatchQueue.main.async {
            self.statusMessage = "Producer available. Waiting for stream..."
        }
    }

    func signaling(_ client: SignalingClient, producerLeft sessionId: String) {
        DispatchQueue.main.async {
            self.isConnected = false
            self.remoteVideoTrack = nil
            self.statusMessage = "Producer disconnected"
        }
        if let producerPeerId {
            webRTC.closePeerConnection(for: producerPeerId)
        }
        producerPeerId = nil
        fpsMonitor.reset()
    }

    func signaling(_ client: SignalingClient, viewerJoined viewerId: String) {
        // n/a for viewer
    }

    func signaling(_ client: SignalingClient, didFailWithMessage message: String) {
        DispatchQueue.main.async {
            self.statusMessage = "Signaling error: \(message)"
        }
    }
}

// MARK: - WebRTCManagerDelegate

extension ViewerViewModel: WebRTCManagerDelegate {
    func webRTC(_ manager: WebRTCManager, didGenerateCandidate candidate: RTCIceCandidate, forPeer peerId: String) {
        signaling.sendCandidate(
            sdpMLineIndex: candidate.sdpMLineIndex,
            sdpMid: candidate.sdpMid,
            candidate: candidate.sdp,
            targetId: peerId
        )
    }

    func webRTC(_ manager: WebRTCManager, didChangeConnectionState state: RTCIceConnectionState, forPeer peerId: String) {
        DispatchQueue.main.async {
            self.connectionState = state
            switch state {
            case .connected, .completed:
                self.isConnected = true
                self.statusMessage = "Connected \u{2705}"
            case .disconnected, .failed, .closed:
                self.isConnected = false
                self.statusMessage = "Connection lost"
            default:
                break
            }
        }
    }

    func webRTC(_ manager: WebRTCManager, didReceiveRemoteVideoTrack track: RTCVideoTrack, forPeer peerId: String) {
        DispatchQueue.main.async {
            self.remoteVideoTrack = track
        }
    }

    func webRTCDidCaptureLocalFrame(_ manager: WebRTCManager) {
        // Viewer doesn't capture local video.
    }
}
