import SwiftUI

struct ViewerView: View {
    @StateObject private var viewModel = ViewerViewModel()
    @State private var showScanner = false
    @State private var showLog = false

    var body: some View {
        ZStack {
            if viewModel.isConnected, let track = viewModel.remoteVideoTrack {
                RTCVideoRenderView(track: track, onFrameRendered: viewModel.onFrameRendered)
                    .ignoresSafeArea()

                if viewModel.fpsMonitor.isFrozen {
                    freezeOverlay
                }
            } else {
                Color.black.ignoresSafeArea()
            }

            VStack {
                topBar
                Spacer()
                if viewModel.isConnected {
                    bottomStatsPanel
                } else {
                    setupPanel
                }
            }
            .padding()
        }
        .navigationBarHidden(true)
        .sheet(isPresented: $showScanner) {
            QRScannerView { payload in
                showScanner = false
                if let info = ConnectionInfo.fromQRPayload(payload) {
                    viewModel.applyScanned(info)
                }
            }
            .ignoresSafeArea()
        }
        .sheet(isPresented: $showLog) {
            FPSLogSheet(entries: viewModel.fpsMonitor.log)
        }
        .onDisappear {
            viewModel.disconnect()
        }
    }

    private var freezeOverlay: some View {
        VStack {
            Spacer()
            Text("\u{26A0}\u{FE0F} STREAM FROZEN")
                .font(.headline)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(Color.red)
                .foregroundColor(.white)
                .clipShape(Capsule())
                .padding(.bottom, 140)
        }
    }

    private var topBar: some View {
        HStack {
            StatusPill(
                text: viewModel.isConnected ? "CONNECTED" : "Idle",
                color: viewModel.isConnected ? .green : .gray
            )
            Spacer()
            if viewModel.isConnected {
                Button(action: { showLog = true }) {
                    Image(systemName: "list.bullet.rectangle")
                        .foregroundColor(.white)
                        .padding(8)
                        .background(.ultraThinMaterial)
                        .clipShape(Circle())
                }
            }
        }
    }

    private var setupPanel: some View {
        VStack(spacing: 20) {
            Text("Connect to Broadcaster")
                .font(.title2.bold())
                .foregroundColor(.white)

            Button(action: { showScanner = true }) {
                Label("Scan QR Code", systemImage: "qrcode.viewfinder")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color.white.opacity(0.15))
                    .foregroundColor(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
            }

            VStack(alignment: .leading, spacing: 12) {
                LabeledField(label: "Host (producer's WiFi IP)", text: $viewModel.host, placeholder: "192.168.1.10")
                LabeledField(label: "Port", text: $viewModel.port, placeholder: "8765", keyboard: .numberPad)
                LabeledField(label: "Session ID", text: $viewModel.sessionId, placeholder: "fpsmonitor-session")
            }
            .padding()
            .background(Color(white: 0.12))
            .clipShape(RoundedRectangle(cornerRadius: 16))

            Text(viewModel.statusMessage)
                .font(.footnote)
                .foregroundColor(.secondary)

            Button(action: viewModel.connect) {
                Text("Connect")
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
                StatBox(title: "Drops", value: "\(viewModel.fpsMonitor.totalDrops)")
                StatBox(
                    title: "Status",
                    value: viewModel.fpsMonitor.isFrozen ? "FROZEN" : "OK"
                )
            }

            Text(viewModel.statusMessage)
                .font(.caption)
                .foregroundColor(.white.opacity(0.8))

            Button(action: viewModel.disconnect) {
                Text("Disconnect")
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

private struct FPSLogSheet: View {
    let entries: [FPSLogEntry]

    var body: some View {
        NavigationView {
            List(entries.reversed()) { entry in
                HStack {
                    Text(entry.timestamp.formatted(date: .omitted, time: .standard))
                        .font(.caption.monospaced())
                        .foregroundColor(.secondary)
                    Spacer()
                    Text(String(format: "%.1f fps", entry.instantFPS))
                        .font(.caption.monospacedDigit())
                    if entry.isDrop {
                        Image(systemName: "arrow.down.circle.fill").foregroundColor(.orange)
                    }
                    if entry.isFreeze {
                        Image(systemName: "snowflake").foregroundColor(.blue)
                    }
                }
            }
            .navigationTitle("FPS Log")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

#Preview {
    ViewerView()
}
