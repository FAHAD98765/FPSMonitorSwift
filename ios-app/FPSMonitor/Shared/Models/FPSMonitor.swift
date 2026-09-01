import Foundation
import Combine

/// A single per-second log entry, used for both producer (capture) and
/// viewer (render) FPS history.
struct FPSLogEntry: Identifiable, Equatable {
    let id = UUID()
    let timestamp: Date
    let instantFPS: Double
    let smoothedFPS: Double
    let frameCount: Int
    let isFreeze: Bool
    let isDrop: Bool
}

/// Tracks incoming frame ticks and produces an EMA-smoothed FPS value,
/// per-second logs, freeze detection (no frames for N seconds) and
/// frame-drop detection (sudden dip vs recent average).
final class FPSMonitor: ObservableObject {

    @Published private(set) var currentFPS: Double = 0
    @Published private(set) var smoothedFPS: Double = 0
    @Published private(set) var isFrozen: Bool = false
    @Published private(set) var log: [FPSLogEntry] = []
    @Published private(set) var totalFramesReceived: Int = 0
    @Published private(set) var totalDrops: Int = 0

    private var frameTimestampsThisSecond: [Date] = []
    private var lastFrameTime: Date?
    private var recentFPSWindow: [Double] = []
    private var tickTimer: Timer?
    private var freezeCheckTimer: Timer?

    private let alpha = AppConfig.fpsEmaAlpha
    private let reportInterval = AppConfig.fpsReportInterval
    private let freezeThreshold = AppConfig.freezeDetectionThreshold

    private let maxLogEntries = 300 // ~5 minutes at 1/sec

    func start() {
        stop()
        tickTimer = Timer.scheduledTimer(withTimeInterval: reportInterval, repeats: true) { [weak self] _ in
            self?.flushSecond()
        }
        freezeCheckTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            self?.checkForFreeze()
        }
    }

    func stop() {
        tickTimer?.invalidate()
        tickTimer = nil
        freezeCheckTimer?.invalidate()
        freezeCheckTimer = nil
    }

    /// Call this every time a frame is captured (producer) or rendered (viewer).
    func recordFrame() {
        let now = Date()
        lastFrameTime = now
        frameTimestampsThisSecond.append(now)
        totalFramesReceived += 1
        if isFrozen {
            isFrozen = false
        }
    }

    private func flushSecond() {
        let instant = Double(frameTimestampsThisSecond.count) / reportInterval
        frameTimestampsThisSecond.removeAll()

        smoothedFPS = smoothedFPS == 0 ? instant : (alpha * instant + (1 - alpha) * smoothedFPS)
        currentFPS = instant

        recentFPSWindow.append(instant)
        if recentFPSWindow.count > 5 { recentFPSWindow.removeFirst() }
        let recentAvg = recentFPSWindow.reduce(0, +) / Double(recentFPSWindow.count)

        // A "drop" = this second's FPS is significantly below recent average
        // (ignores the first couple of samples while the window fills up).
        let isDrop = recentFPSWindow.count >= 3 && recentAvg > 0 && instant < recentAvg * 0.6
        if isDrop { totalDrops += 1 }

        let entry = FPSLogEntry(
            timestamp: Date(),
            instantFPS: instant,
            smoothedFPS: smoothedFPS,
            frameCount: Int(instant),
            isFreeze: isFrozen,
            isDrop: isDrop
        )
        log.append(entry)
        if log.count > maxLogEntries {
            log.removeFirst(log.count - maxLogEntries)
        }
    }

    private func checkForFreeze() {
        guard let last = lastFrameTime else { return }
        let elapsed = Date().timeIntervalSince(last)
        let frozen = elapsed >= freezeThreshold
        if frozen != isFrozen {
            isFrozen = frozen
        }
    }

    func reset() {
        frameTimestampsThisSecond.removeAll()
        recentFPSWindow.removeAll()
        lastFrameTime = nil
        currentFPS = 0
        smoothedFPS = 0
        isFrozen = false
        log.removeAll()
        totalFramesReceived = 0
        totalDrops = 0
    }
}
