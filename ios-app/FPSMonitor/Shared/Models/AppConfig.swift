import Foundation

/// Central place to change how the two devices find/connect to each other.
enum AppConfig {
    /// Default signaling server port. Change if you run the Node server on a different port.
    static let defaultSignalingPort: Int = 8765

    /// Default session ID used when pairing via manual entry (QR code carries its own).
    static let defaultSessionId: String = "fpsmonitor-session"

    /// How often the FPS monitor recomputes/reports its EMA-smoothed FPS.
    static let fpsReportInterval: TimeInterval = 1.0

    /// EMA smoothing factor (0..1). Higher = more reactive, lower = smoother.
    static let fpsEmaAlpha: Double = 0.3

    /// If no new frame arrives within this window, the viewer flags a "freeze".
    static let freezeDetectionThreshold: TimeInterval = 1.5
}

enum DeviceRole: String, Codable {
    case producer
    case viewer
}

/// Everything needed to connect to a signaling server + session,
/// either typed manually or decoded from a scanned QR code.
struct ConnectionInfo: Codable, Equatable {
    var host: String
    var port: Int
    var sessionId: String

    var signalingURL: URL? {
        URL(string: "ws://\(host):\(port)")
    }

    /// Encodes to a compact JSON string suitable for a QR code payload.
    func toQRPayload() -> String {
        let dict: [String: Any] = ["host": host, "port": port, "sessionId": sessionId]
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let str = String(data: data, encoding: .utf8) else { return "" }
        return str
    }

    static func fromQRPayload(_ payload: String) -> ConnectionInfo? {
        guard let data = payload.data(using: .utf8),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let host = dict["host"] as? String,
              let port = dict["port"] as? Int,
              let sessionId = dict["sessionId"] as? String else { return nil }
        return ConnectionInfo(host: host, port: port, sessionId: sessionId)
    }
}
