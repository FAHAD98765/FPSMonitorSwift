import Foundation
import WebRTC

protocol WebRTCManagerDelegate: AnyObject {
    func webRTC(_ manager: WebRTCManager, didGenerateCandidate candidate: RTCIceCandidate, forPeer peerId: String)
    func webRTC(_ manager: WebRTCManager, didChangeConnectionState state: RTCIceConnectionState, forPeer peerId: String)
    func webRTC(_ manager: WebRTCManager, didReceiveRemoteVideoTrack track: RTCVideoTrack, forPeer peerId: String)
    /// Fired for every *locally captured* frame (producer side FPS measurement).
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
    private var localVideoTrack: RTCVideoTrack?
    private var videoCapturer: RTCCameraVideoCapturer?
    private var localVideoSource: RTCVideoSource?
    private var frameCounterDelegateProxy: LocalFrameCounter?

    private let iceServers: [RTCIceServer] = [
        // STUN only — this app is designed for same-LAN use, so host/srflx
        // candidates found on the local WiFi will typically be used directly.
        RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"])
    ]

    // MARK: - Local capture (Producer)

    /// Starts capturing the front or back camera and returns the local video track,
    /// so the UI layer can render a local preview.
    func startCapture(useFrontCamera: Bool, completion: @escaping (RTCVideoTrack?) -> Void) {
        let source = Self.factory.videoSource()
        localVideoSource = source

        let counter = LocalFrameCounter { [weak self] in
            guard let self else { return }
            self.delegate?.webRTCDidCaptureLocalFrame(self)
        }
        frameCounterDelegateProxy = counter

        let capturer = RTCCameraVideoCapturer(delegate: counter.wrapping(source))
        videoCapturer = capturer

        guard let device = RTCCameraVideoCapturer.captureDevices().first(where: {
            $0.position == (useFrontCamera ? .front : .back)
        }) ?? RTCCameraVideoCapturer.captureDevices().first else {
            completion(nil)
            return
        }

        let formats = RTCCameraVideoCapturer.supportedFormats(for: device)
        let targetFormat = formats.first(where: {
            let dims = CMVideoFormatDescriptionGetDimensions($0.formatDescription)
            return dims.width == 1280 && dims.height == 720
        }) ?? formats.last

        guard let format = targetFormat else {
            completion(nil)
            return
        }

        let fpsRanges = format.videoSupportedFrameRateRanges
        let maxFPS = fpsRanges.map { $0.maxFrameRate }.max() ?? 30

        capturer.startCapture(with: device, format: format, fps: Int(min(maxFPS, 30))) { error in
            if let error {
                print("[WebRTCManager] capture error: \(error)")
            }
        }

        let track = Self.factory.videoTrack(with: source, trackId: "local-video-0")
        localVideoTrack = track
        completion(track)
    }

    func stopCapture() {
        videoCapturer?.stopCapture()
        videoCapturer = nil
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
        pc.delegate = PeerConnectionDelegateProxy(peerId: peerId, owner: self)

        if let track = localVideoTrack {
            pc.add(track, streamIds: ["fpsmonitor-stream"])
        }

        peerConnections[peerId] = pc
        return pc
    }

    func closePeerConnection(for peerId: String) {
        peerConnections[peerId]?.close()
        peerConnections.removeValue(forKey: peerId)
    }

    func closeAll() {
        peerConnections.values.forEach { $0.close() }
        peerConnections.removeAll()
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

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        if let track = stream.videoTracks.first {
            owner?.notifyRemoteTrack(track, peerId: peerId)
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        owner?.notifyConnectionState(newState, peerId: peerId)
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        owner?.notifyCandidate(candidate, peerId: peerId)
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}

/// Wraps an RTCVideoCapturerDelegate (the video source) so we can also
/// count locally-captured frames without touching WebRTC internals.
private final class LocalFrameCounter {
    private let onFrame: () -> Void
    init(onFrame: @escaping () -> Void) { self.onFrame = onFrame }

    func wrapping(_ source: RTCVideoSource) -> RTCVideoCapturerDelegate {
        return FrameCountingCapturerDelegate(source: source, onFrame: onFrame)
    }
}

private final class FrameCountingCapturerDelegate: NSObject, RTCVideoCapturerDelegate {
    let source: RTCVideoSource
    let onFrame: () -> Void

    init(source: RTCVideoSource, onFrame: @escaping () -> Void) {
        self.source = source
        self.onFrame = onFrame
    }

    func capturer(_ capturer: RTCVideoCapturer, didCapture frame: RTCVideoFrame) {
        source.capturer(capturer, didCapture: frame)
        onFrame()
    }
}
