import Foundation

/// Central place to change how the two devices find/connect to each other.
enum AppConfig {

    /// Fly.io deployed server (PUBLIC)
    static let defaultSignalingHost: String = "fpsmonitor-server.fly.dev"
    
    /// HTTPS port
    static let defaultSignalingPort: Int = 443

    /// Default session ID.
    static let defaultSessionId: String = "fpsmonitor-session"

    /// FPS report interval.
    static let fpsReportInterval: TimeInterval = 1.0

    /// EMA smoothing factor.
    static let fpsEmaAlpha: Double = 0.3

    /// Freeze detection threshold.
    static let freezeDetectionThreshold: TimeInterval = 1.5
    
    /// Get connection info for signaling
    static func getConnectionInfo() -> ConnectionInfo {
        ConnectionInfo(
            host: defaultSignalingHost,
            port: defaultSignalingPort,
            sessionId: defaultSessionId
        )
    }
    
    /// Get QR code payload for web viewer
    static func getQRCodePayload() -> String {
        let connection = ConnectionInfo(
            host: defaultSignalingHost,
            port: defaultSignalingPort,
            sessionId: defaultSessionId
        )
        return connection.toQRPayload()
    }
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
        let scheme = port == 443 ? "wss" : "ws"
        return URL(string: "\(scheme)://\(host):\(port)")
    }

    /// URL that will be stored inside the QR code.
    ///
    /// Example:
    /// https://fpsmonitor-server.fly.dev/view?session=fpsmonitor-session
    func toQRPayload() -> String {

        var components = URLComponents()
        components.scheme = "https"
        components.host = host
        components.port = port == 443 ? nil : port
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
              let sessionId = components.queryItems?
                  .first(where: { $0.name == "session" })?
                  .value
        else {
            return nil
        }

        return ConnectionInfo(
            host: host,
            port: components.port ?? 443,
            sessionId: sessionId
        )
    }
}
