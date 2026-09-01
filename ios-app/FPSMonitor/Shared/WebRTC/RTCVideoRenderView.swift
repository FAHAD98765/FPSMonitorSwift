import SwiftUI
import WebRTC

/// A thin RTCVideoRenderer that forwards every decoded frame to RTCMTLVideoView
/// for actual rendering, while also firing a callback per-frame. This is the
/// reliable way to count frames — RTCVideoViewDelegate's didChangeVideoSize
/// only fires when the frame *dimensions* change, not on every frame.
private final class FrameCountingRenderer: NSObject, RTCVideoRenderer {
    private let target: RTCMTLVideoView
    var onFrame: (() -> Void)?

    init(target: RTCMTLVideoView) {
        self.target = target
    }

    func setSize(_ size: CGSize) {
        target.setSize(size)
    }

    func renderFrame(_ frame: RTCVideoFrame?) {
        target.renderFrame(frame)
        if frame != nil {
            onFrame?()
        }
    }
}

/// SwiftUI wrapper around WebRTC's Metal-backed video view.
/// Used both for the producer's local camera preview and the viewer's remote stream.
struct RTCVideoRenderView: UIViewRepresentable {
    let track: RTCVideoTrack?

    /// Called every time a frame is actually decoded/rendered — used by the
    /// Viewer to measure *render* FPS (as opposed to network-received FPS).
    var onFrameRendered: (() -> Void)?

    func makeUIView(context: Context) -> RTCMTLVideoView {
        let view = RTCMTLVideoView()
        view.videoContentMode = .scaleAspectFill
        let renderer = FrameCountingRenderer(target: view)
        context.coordinator.renderer = renderer
        return view
    }

    func updateUIView(_ uiView: RTCMTLVideoView, context: Context) {
        context.coordinator.renderer?.onFrame = onFrameRendered

        if context.coordinator.attachedTrack !== track {
            if let old = context.coordinator.attachedTrack, let renderer = context.coordinator.renderer {
                old.remove(renderer)
            }
            if let renderer = context.coordinator.renderer {
                track?.add(renderer)
            }
            context.coordinator.attachedTrack = track
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    static func dismantleUIView(_ uiView: RTCMTLVideoView, coordinator: Coordinator) {
        if let track = coordinator.attachedTrack, let renderer = coordinator.renderer {
            track.remove(renderer)
        }
    }

    final class Coordinator {
        var attachedTrack: RTCVideoTrack?
        var renderer: FrameCountingRenderer?
    }
}
