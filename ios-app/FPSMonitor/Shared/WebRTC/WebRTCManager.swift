import Foundation
import WebRTC
import AVFoundation

protocol WebRTCManagerDelegate: AnyObject {
    func webRTC(_ manager: WebRTCManager, didGenerateCandidate candidate: RTCIceCandidate, forPeer peerId: String)
    func webRTC(_ manager: WebRTCManager, didChangeConnectionState state: RTCIceConnectionState, forPeer peerId: String)
    func webRTC(_ manager: WebRTCManager, didReceiveRemoteVideoTrack track: RTCVideoTrack, forPeer peerId: String)
    /// Fired for every locally captured frame (producer side FPS measurement).
    func webRTCDidCaptureLocalFrame(_ manager: WebRTCManager)
}

/// Wraps GoogleWebRTC to provide a simple peer-connection-per-remote-id API.
/// The PRODUCER holds one RTCPeerConnection per connected viewer (fan-out).
/// The VIEWER holds exactly one RTCPeerConnection (to the producer).
final class WebRTCManager: NSObject {

    weak var delegate: WebRTCManagerDelegate?

    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        let videoEncoderFactory = RTCDefaultVideoEncoderFactory()
        let videoDecoderFactory = RTCDefaultVideoDecoderFactory()
        return RTCPeerConnectionFactory(encoderFactory: videoEncoderFactory, decoderFactory: videoDecoderFactory)
    }()

    private var peerConnections: [String: RTCPeerConnection] = [:]
    /// Must be strongly retained — RTCPeerConnection.delegate is weak, so if
    /// nothing else holds the proxy, it deallocates right after being assigned
    /// and NO callbacks ever fire (no ICE candidates, no connection state
    /// changes, no remote track). Symptom: stuck on "Negotiating...", black screen.
    private var peerConnectionDelegates: [String: PeerConnectionDelegateProxy] = [:]
    private var localVideoTrack: RTCVideoTrack?
    private var videoCapturer: RTCCameraVideoCapturer?
    private var localVideoSource: RTCVideoSource?
    /// Must be strongly retained here — RTCCameraVideoCapturer.delegate is weak,
    /// so if nothing else holds this, it deallocates immediately after
    /// startCapture() returns and NO frames ever reach the video source
    /// (symptom: black local preview, nothing sent to viewer either).
    private var capturerDelegate: RTCVideoCapturerDelegate?

    private let iceServers: [RTCIceServer] = [
        // STUN only — this app is designed for same-LAN use, so host/srflx
        // candidates found on the local WiFi will typically be used directly.
        RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"])
    ]

    // MARK: - Local capture (Producer)

    /// Starts capturing the front or back camera and returns the local video track,
    /// so the UI layer can render a local preview.
    func startCapture(useFrontCamera: Bool, completion: @escaping (RTCVideoTrack?) -> Void) {
        // Explicit permission check first — if the user denied camera access
        // (even from an earlier test run), iOS will NOT re-prompt automatically
        // and AVCaptureSession will simply produce no frames (black screen,
        // no crash, no obvious error). Fail loudly here instead.
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            performStartCapture(useFrontCamera: useFrontCamera, completion: completion)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if granted {
                        self.performStartCapture(useFrontCamera: useFrontCamera, completion: completion)
                    } else {
                        print("[WebRTCManager] Camera permission DENIED by user just now.")
                        completion(nil)
                    }
                }
            }
        case .denied, .restricted:
            print("[WebRTCManager] Camera permission is DENIED/RESTRICTED. Go to Settings > Privacy & Security > Camera > FPSMonitor and enable it.")
            completion(nil)
        @unknown default:
            completion(nil)
        }
    }

    private func performStartCapture(useFrontCamera: Bool, completion: @escaping (RTCVideoTrack?) -> Void) {
        let source = Self.factory.videoSource()
        localVideoSource = source

        let counterCallback: () -> Void = { [weak self] in
            guard let self else { return }
            self.delegate?.webRTCDidCaptureLocalFrame(self)
        }
        let delegate = FrameCountingCapturerDelegate(source: source, onFrame: counterCallback)
        capturerDelegate = delegate

        let capturer = RTCCameraVideoCapturer(delegate: delegate)
        videoCapturer = capturer

        let allDevices = RTCCameraVideoCapturer.captureDevices()
        print("[WebRTCManager] available capture devices: \(allDevices.map { "\($0.localizedName) (\($0.position.rawValue))" })")

        guard let device = allDevices.first(where: {
            $0.position == (useFrontCamera ? .front : .back)
        }) ?? allDevices.first else {
            print("[WebRTCManager] NO CAMERA DEVICE FOUND. Are you running on a real device (not Simulator)?")
            completion(nil)
            return
        }
        print("[WebRTCManager] selected device: \(device.localizedName)")

        let formats = RTCCameraVideoCapturer.supportedFormats(for: device)
        // Prefer a ~720p format, but among formats at that resolution pick the
        // one with the HIGHEST supported frame rate — same resolution can have
        // multiple distinct format entries (e.g. 720p@30 vs 720p@60), and just
        // taking the first match risks silently capping us at 30fps.
        let candidates720p = formats.filter {
            let dims = CMVideoFormatDescriptionGetDimensions($0.formatDescription)
            return dims.width == 1280 && dims.height == 720
        }
        let targetFormat = candidates720p.max(by: {
            let maxA = $0.videoSupportedFrameRateRanges.map { $0.maxFrameRate }.max() ?? 0
            let maxB = $1.videoSupportedFrameRateRanges.map { $0.maxFrameRate }.max() ?? 0
            return maxA < maxB
        }) ?? formats.last

        guard let format = targetFormat else {
            print("[WebRTCManager] NO SUPPORTED FORMAT FOUND for device.")
            completion(nil)
            return
        }
        let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
        let fpsRanges = format.videoSupportedFrameRateRanges
        let maxFPS = fpsRanges.map { $0.maxFrameRate }.max() ?? 30
        print("[WebRTCManager] selected format: \(dims.width)x\(dims.height), max supported fps: \(maxFPS)")

        capturer.startCapture(with: device, format: format, fps: Int(min(maxFPS, 60))) { error in
            if let error {
                print("[WebRTCManager] capture error: \(error)")
            } else {
                print("[WebRTCManager] startCapture completion — no error reported.")
            }
        }

        let track = Self.factory.videoTrack(with: source, trackId: "local-video-0")
        localVideoTrack = track
        completion(track)
    }

    func stopCapture() {
        videoCapturer?.stopCapture()
        videoCapturer = nil
        capturerDelegate = nil
    }

    var currentLocalVideoTrack: RTCVideoTrack? { localVideoTrack }

    // MARK: - Peer connection lifecycle

    @discardableResult
    private func makePeerConnection(for peerId: String) -> RTCPeerConnection {
        if let existing = peerConnections[peerId] { return existing }

        let config = RTCConfiguration()
        config.iceServers = iceServers
        config.sdpSemantics = .unifiedPlan
        config.continualGatheringPolicy = .gatherContinually

        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        let pc = Self.factory.peerConnection(with: config, constraints: constraints, delegate: nil)!
        let proxy = PeerConnectionDelegateProxy(peerId: peerId, owner: self)
        peerConnectionDelegates[peerId] = proxy
        pc.delegate = proxy

        if let track = localVideoTrack {
            pc.add(track, streamIds: ["fpsmonitor-stream"])
        }

        peerConnections[peerId] = pc
        return pc
    }

    func closePeerConnection(for peerId: String) {
        peerConnections[peerId]?.close()
        peerConnections.removeValue(forKey: peerId)
        peerConnectionDelegates.removeValue(forKey: peerId)
    }

    func closeAll() {
        peerConnections.values.forEach { $0.close() }
        peerConnections.removeAll()
        peerConnectionDelegates.removeAll()
    }

    // MARK: - Producer: create offer for a new viewer

    func createOffer(forPeer peerId: String, completion: @escaping (String?) -> Void) {
        let pc = makePeerConnection(for: peerId)
        let constraints = RTCMediaConstraints(
            mandatoryConstraints: ["OfferToReceiveVideo": "false", "OfferToReceiveAudio": "false"],
            optionalConstraints: nil
        )
        pc.offer(for: constraints) { [weak self, weak pc] sdp, error in
            guard let self, let pc, let sdp else { completion(nil); return }
            pc.setLocalDescription(sdp) { error in
                if let error {
                    print("[WebRTCManager] setLocalDescription (offer) error: \(error)")
                    completion(nil)
                } else {
                    completion(sdp.sdp)
                }
            }
        }
    }

    // MARK: - Viewer: handle incoming offer, produce answer

    func handleRemoteOffer(_ sdp: String, fromPeer peerId: String, completion: @escaping (String?) -> Void) {
        let pc = makePeerConnection(for: peerId)
        let remoteDesc = RTCSessionDescription(type: .offer, sdp: sdp)
        pc.setRemoteDescription(remoteDesc) { [weak self, weak pc] error in
            guard let self, let pc else { completion(nil); return }
            if let error {
                print("[WebRTCManager] setRemoteDescription (offer) error: \(error)")
                completion(nil)
                return
            }
            let constraints = RTCMediaConstraints(
                mandatoryConstraints: ["OfferToReceiveVideo": "true", "OfferToReceiveAudio": "false"],
                optionalConstraints: nil
            )
            pc.answer(for: constraints) { answerSdp, error in
                guard let answerSdp else { completion(nil); return }
                pc.setLocalDescription(answerSdp) { error in
                    if let error {
                        print("[WebRTCManager] setLocalDescription (answer) error: \(error)")
                        completion(nil)
                    } else {
                        completion(answerSdp.sdp)
                    }
                }
            }
        }
    }

    // MARK: - Producer: apply viewer's answer

    func handleRemoteAnswer(_ sdp: String, fromPeer peerId: String) {
        guard let pc = peerConnections[peerId] else { return }
        let remoteDesc = RTCSessionDescription(type: .answer, sdp: sdp)
        pc.setRemoteDescription(remoteDesc) { error in
            if let error {
                print("[WebRTCManager] setRemoteDescription (answer) error: \(error)")
            }
        }
    }

    // MARK: - ICE

    func addRemoteCandidate(sdpMLineIndex: Int32, sdpMid: String?, candidate: String, forPeer peerId: String) {
        let pc = makePeerConnection(for: peerId)
        let iceCandidate = RTCIceCandidate(sdp: candidate, sdpMLineIndex: sdpMLineIndex, sdpMid: sdpMid)
        pc.add(iceCandidate) { error in
            if let error {
                print("[WebRTCManager] addIceCandidate error: \(error)")
            }
        }
    }

    fileprivate func notifyCandidate(_ candidate: RTCIceCandidate, peerId: String) {
        delegate?.webRTC(self, didGenerateCandidate: candidate, forPeer: peerId)
    }

    fileprivate func notifyConnectionState(_ state: RTCIceConnectionState, peerId: String) {
        delegate?.webRTC(self, didChangeConnectionState: state, forPeer: peerId)
    }

    fileprivate func notifyRemoteTrack(_ track: RTCVideoTrack, peerId: String) {
        delegate?.webRTC(self, didReceiveRemoteVideoTrack: track, forPeer: peerId)
    }
}

/// RTCPeerConnectionDelegate forwards to the owning manager, tagged with peerId
/// so a producer with multiple viewers can tell connections apart.
private final class PeerConnectionDelegateProxy: NSObject, RTCPeerConnectionDelegate {
    let peerId: String
    weak var owner: WebRTCManager?

    init(peerId: String, owner: WebRTCManager) {
        self.peerId = peerId
        self.owner = owner
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {
        print("[WebRTC][\(peerId)] signaling state -> \(stateChanged.rawValue)")
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        print("[WebRTC][\(peerId)] didAdd stream, video tracks: \(stream.videoTracks.count)")
        if let track = stream.videoTracks.first {
            owner?.notifyRemoteTrack(track, peerId: peerId)
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        print("[WebRTC][\(peerId)] ICE connection state -> \(newState.rawValue)")
        owner?.notifyConnectionState(newState, peerId: peerId)
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        print("[WebRTC][\(peerId)] ICE gathering state -> \(newState.rawValue)")
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        print("[WebRTC][\(peerId)] generated ICE candidate")
        owner?.notifyCandidate(candidate, peerId: peerId)
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}

/// Wraps the video source's capturer delegate so we can also count
/// locally-captured frames without touching WebRTC internals. Must be
/// retained by the caller — RTCCameraVideoCapturer holds its delegate weakly.
private final class FrameCountingCapturerDelegate: NSObject, RTCVideoCapturerDelegate {
    let source: RTCVideoSource
    let onFrame: () -> Void
    private var loggedFrames = 0

    init(source: RTCVideoSource, onFrame: @escaping () -> Void) {
        self.source = source
        self.onFrame = onFrame
    }

    func capturer(_ capturer: RTCVideoCapturer, didCapture frame: RTCVideoFrame) {
        source.capturer(capturer, didCapture: frame)
        if loggedFrames < 5 {
            loggedFrames += 1
            print("[WebRTCManager] captured frame #\(loggedFrames): \(frame.width)x\(frame.height)")
        }
        onFrame()
    }
}
