import SwiftUI

struct ProducerView: View {
    @StateObject private var viewModel = ProducerViewModel()

    var body: some View {
        ZStack {
            if viewModel.isBroadcasting, let track = viewModel.localVideoTrack {
                RTCVideoRenderView(track: track)
                    .ignoresSafeArea()
            } else {
                Color.black.ignoresSafeArea()
            }

            VStack {
                topBar
                Spacer()
                if viewModel.isBroadcasting {
                    bottomStatsPanel
                } else {
                    setupPanel
                }
            }
            .padding()
        }
        .navigationBarHidden(true)
        .onAppear {
            if viewModel.host.isEmpty {
                viewModel.autoFillLocalIP()
            }
        }
        .onDisappear {
            viewModel.stopBroadcast()
        }
    }

    private var topBar: some View {
        HStack {
            StatusPill(
                text: viewModel.isBroadcasting ? "LIVE" : "Idle",
                color: viewModel.isBroadcasting ? .red : .gray
            )
            Spacer()
            if viewModel.isBroadcasting {
                StatusPill(
                    text: "\(viewModel.connectedViewerCount) viewer\(viewModel.connectedViewerCount == 1 ? "" : "s")",
                    color: viewModel.connectedViewerCount > 0 ? .green : .orange
                )
            }
        }
    }

    private var setupPanel: some View {
        VStack(spacing: 20) {
            Text("Broadcast Setup")
                .font(.title2.bold())
                .foregroundColor(.white)

            VStack(alignment: .leading, spacing: 12) {
                LabeledField(label: "Host (this device's WiFi IP)", text: $viewModel.host, placeholder: "192.168.1.10")
                LabeledField(label: "Port", text: $viewModel.port, placeholder: "8765", keyboard: .numberPad)
                LabeledField(label: "Session ID", text: $viewModel.sessionId, placeholder: "fpsmonitor-session")
            }
            .padding()
            .background(Color(white: 0.12))
            .clipShape(RoundedRectangle(cornerRadius: 16))

            if !viewModel.host.isEmpty, let port = Int(viewModel.port) {
                VStack(spacing: 8) {
                    if let qrImage = QRCodeGenerator.image(from: viewModel.qrPayload) {
                        Image(uiImage: qrImage)
                            .interpolation(.none)
                            .resizable()
                            .frame(width: 180, height: 180)
                            .background(Color.white)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    Text("Scan this on the viewer device")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Text("ws://\(viewModel.host):\(port) · \(viewModel.sessionId)")
                        .font(.caption2.monospaced())
                        .foregroundColor(.secondary)
                }
            }

            Text(viewModel.statusMessage)
                .font(.footnote)
                .foregroundColor(.secondary)

            Button(action: viewModel.startBroadcast) {
                Text("Start Broadcasting")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color.accentColor)
                    .foregroundColor(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
            }
        }
        .padding()
        .background(Color(white: 0.08).opacity(0.95))
        .clipShape(RoundedRectangle(cornerRadius: 20))
    }

    private var bottomStatsPanel: some View {
        VStack(spacing: 12) {
            HStack(spacing: 20) {
                StatBox(title: "FPS", value: String(format: "%.1f", viewModel.fpsMonitor.smoothedFPS))
                StatBox(title: "Frames", value: "\(viewModel.fpsMonitor.totalFramesReceived)")
                StatBox(title: "Drops", value: "\(viewModel.fpsMonitor.totalDrops)")
            }

            Text(viewModel.statusMessage)
                .font(.caption)
                .foregroundColor(.white.opacity(0.8))

            Button(action: viewModel.stopBroadcast) {
                Text("Stop Broadcasting")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color.red)
                    .foregroundColor(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
            }
        }
        .padding()
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 20))
    }
}

// MARK: - Reusable subviews (shared style with ViewerView)

struct StatusPill: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text)
            .font(.caption.bold())
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(color.opacity(0.2))
            .foregroundColor(color)
            .clipShape(Capsule())
    }
}

struct StatBox: View {
    let title: String
    let value: String
    var body: some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.title3.bold().monospacedDigit())
                .foregroundColor(.white)
            Text(title)
                .font(.caption2)
                .foregroundColor(.white.opacity(0.7))
        }
        .frame(maxWidth: .infinity)
    }
}

struct LabeledField: View {
    let label: String
    @Binding var text: String
    var placeholder: String = ""
    var keyboard: UIKeyboardType = .default

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption)
                .foregroundColor(.secondary)
            TextField(placeholder, text: $text)
                .keyboardType(keyboard)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .padding(10)
                .background(Color(white: 0.18))
                .foregroundColor(.white)
                .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }
}

#Preview {
    ProducerView()
}
