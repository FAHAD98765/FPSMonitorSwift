import Foundation
import Combine
import WebRTC
import UIKit

final class ProducerViewModel: NSObject, ObservableObject {

    // Connection setup
    @Published var host: String = ""
    @Published var port: String = String(AppConfig.defaultSignalingPort)
    @Published var sessionId: String = AppConfig.defaultSessionId
    @Published var isBroadcasting: Bool = false
    @Published var signalingConnected: Bool = false
    @Published var connectedViewerCount: Int = 0
    @Published var statusMessage: String = "Not started"
    @Published var localVideoTrack: RTCVideoTrack?

    let fpsMonitor = FPSMonitor()

    private let signaling = SignalingClient()
    private let webRTC = WebRTCManager()
    private var viewerConnectionStates: [String: RTCIceConnectionState] = [:]
    private var cancellables = Set<AnyCancellable>()

    override init() {
        super.init()
        signaling.delegate = self
        webRTC.delegate = self
        // FPSMonitor is its own ObservableObject; ProducerView only observes
        // `viewModel` via @StateObject, so FPSMonitor's @Published changes
        // (smoothedFPS etc.) would otherwise never trigger a re-render.
        // Forward its change notifications into our own objectWillChange.
        fpsMonitor.objectWillChange
            .sink { [weak self] _ in
                self?.objectWillChange.send()
            }
            .store(in: &cancellables)
    }

    var qrPayload: String {
        ConnectionInfo(host: host, port: Int(port) ?? AppConfig.defaultSignalingPort, sessionId: sessionId).toQRPayload()
    }

    /// Best-effort local WiFi IP to pre-fill the host field / show under the QR code.
    func autoFillLocalIP() {
        host = Self.currentWiFiIPAddress() ?? ""
    }

    func startBroadcast() {
        guard !host.isEmpty, let portNum = Int(port) else {
            statusMessage = "Enter a valid host/port"
            return
        }

        statusMessage = "Starting camera..."
        webRTC.startCapture(useFrontCamera: false) { [weak self] track in
            guard let self else { return }
            DispatchQueue.main.async {
                self.localVideoTrack = track
                self.statusMessage = "Camera started. Connecting to signaling server..."
                self.fpsMonitor.start()

                let info = ConnectionInfo(host: self.host, port: portNum, sessionId: self.sessionId)
                self.signaling.connect(to: info, role: .producer)
                self.isBroadcasting = true
            }
        }
    }

    func stopBroadcast() {
        webRTC.stopCapture()
        webRTC.closeAll()
        signaling.disconnect()
        fpsMonitor.stop()
        fpsMonitor.reset()
        isBroadcasting = false
        signalingConnected = false
        connectedViewerCount = 0
        viewerConnectionStates.removeAll()
        statusMessage = "Stopped"
    }

    static func currentWiFiIPAddress() -> String? {
        var address: String?
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr else { return nil }
        defer { freeifaddrs(ifaddr) }

        for ptr in sequence(first: firstAddr, next: { $0.pointee.ifa_next }) {
            let interface = ptr.pointee
            let addrFamily = interface.ifa_addr.pointee.sa_family
            if addrFamily == UInt8(AF_INET) {
                let name = String(cString: interface.ifa_name)
                if name == "en0" { // WiFi interface on iOS devices
                    var addr = interface.ifa_addr.pointee
                    var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                    getnameinfo(&addr, socklen_t(interface.ifa_addr.pointee.sa_len),
                                &hostname, socklen_t(hostname.count), nil, 0, NI_NUMERICHOST)
                    address = String(cString: hostname)
                }
            }
        }
        return address
    }
}

// MARK: - SignalingClientDelegate

extension ProducerViewModel: SignalingClientDelegate {
    func signalingDidConnect(_ client: SignalingClient) {
        DispatchQueue.main.async {
            self.signalingConnected = true
            self.statusMessage = "Waiting for viewer to connect..."
        }
    }

    func signalingDidDisconnect(_ client: SignalingClient, error: Error?) {
        DispatchQueue.main.async {
            self.signalingConnected = false
            self.statusMessage = error != nil ? "Disconnected: \(error!.localizedDescription)" : "Disconnected"
        }
    }

    /// The producer never receives offers — it always initiates (see `viewerJoined`
    /// below) and only ever receives answers back from viewers.
    func signaling(_ client: SignalingClient, didReceiveOffer sdp: String, fromId: String) {
        // Not used on the producer side in this flow.
    }

    func signaling(_ client: SignalingClient, didReceiveAnswer sdp: String, fromId: String) {
        webRTC.handleRemoteAnswer(sdp, fromPeer: fromId)
    }

    func signaling(_ client: SignalingClient, didReceiveCandidate sdpMLineIndex: Int32, sdpMid: String?, candidate: String, fromId: String) {
        webRTC.addRemoteCandidate(sdpMLineIndex: sdpMLineIndex, sdpMid: sdpMid, candidate: candidate, forPeer: fromId)
    }

    func signaling(_ client: SignalingClient, producerAvailable sessionId: String) {
        // n/a for producer
    }

    func signaling(_ client: SignalingClient, producerLeft sessionId: String) {
        // n/a for producer
    }

    /// Server tells the producer whenever a viewer registers for this session
    /// (either just now, or one that was already waiting when we registered).
    /// This is the trigger to create a fresh RTCPeerConnection + offer for that viewer.
    func signaling(_ client: SignalingClient, viewerJoined viewerId: String) {
        webRTC.createOffer(forPeer: viewerId) { [weak self] sdp in
            guard let self, let sdp else { return }
            self.signaling.sendOffer(sdp: sdp, targetId: viewerId)
        }
    }

    func signaling(_ client: SignalingClient, didFailWithMessage message: String) {
        DispatchQueue.main.async {
            self.statusMessage = "Signaling error: \(message)"
        }
    }
}

// MARK: - WebRTCManagerDelegate

extension ProducerViewModel: WebRTCManagerDelegate {
    func webRTC(_ manager: WebRTCManager, didGenerateCandidate candidate: RTCIceCandidate, forPeer peerId: String) {
        signaling.sendCandidate(
            sdpMLineIndex: candidate.sdpMLineIndex,
            sdpMid: candidate.sdpMid,
            candidate: candidate.sdp,
            targetId: peerId
        )
    }

    func webRTC(_ manager: WebRTCManager, didChangeConnectionState state: RTCIceConnectionState, forPeer peerId: String) {
        viewerConnectionStates[peerId] = state
        DispatchQueue.main.async {
            self.connectedViewerCount = self.viewerConnectionStates.values.filter { $0 == .connected || $0 == .completed }.count
            switch state {
            case .connected, .completed:
                self.statusMessage = "Viewer connected \u{2705}"
            case .disconnected, .failed, .closed:
                self.statusMessage = "Viewer disconnected"
            default:
                break
            }
        }
    }

    func webRTC(_ manager: WebRTCManager, didReceiveRemoteVideoTrack track: RTCVideoTrack, forPeer peerId: String) {
        // Producer doesn't receive video.
    }

    func webRTCDidCaptureLocalFrame(_ manager: WebRTCManager) {
        fpsMonitor.recordFrame()
    }
}
