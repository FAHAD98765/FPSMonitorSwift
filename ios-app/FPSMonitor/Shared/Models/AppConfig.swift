
import Foundation

/// Central place to change how the two devices find/connect to each other.
enum AppConfig {

    /// Default signaling server port.
    static let defaultSignalingPort: Int = 8765

    /// Default session ID.
    static let defaultSessionId: String = "fpsmonitor-session"

    /// FPS report interval.
    static let fpsReportInterval: TimeInterval = 1.0

    /// EMA smoothing factor.
    static let fpsEmaAlpha: Double = 0.3

    /// Freeze detection threshold.
    static let freezeDetectionThreshold: TimeInterval = 1.5
}

enum DeviceRole: String, Codable {
    case producer
    case viewer
}

/// Connection information for signaling + Web Viewer.
struct ConnectionInfo: Codable, Equatable {

    var host: String
    var port: Int
    var sessionId: String

    /// WebSocket URL used by the native WebRTC app.
    var signalingURL: URL? {
        URL(string: "ws://\(host):\(port)")
    }

    /// URL that will be stored inside the QR code.
    ///
    /// Example:
    /// http://192.168.100.15:8765/view?session=fpsmonitor-session
    func toQRPayload() -> String {

        var components = URLComponents()
        components.scheme = "http"
        components.host = host
        components.port = port
        components.path = "/view"
        components.queryItems = [
            URLQueryItem(name: "session", value: sessionId)
        ]

        return components.url?.absoluteString ?? ""
    }

    /// Decodes a Web Viewer URL from QR code.
    static func fromQRPayload(_ payload: String) -> ConnectionInfo? {

        guard let url = URL(string: payload),
              let components = URLComponents(
                  url: url,
                  resolvingAgainstBaseURL: false
              ),
              let host = components.host,
              let port = components.port,
              let sessionId = components.queryItems?
                  .first(where: { $0.name == "session" })?
                  .value
        else {
            return nil
        }

        return ConnectionInfo(
            host: host,
            port: port,
            sessionId: sessionId
        )
    }
}
