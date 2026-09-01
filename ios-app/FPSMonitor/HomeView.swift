import SwiftUI

struct HomeView: View {
    var body: some View {
        NavigationView {
            VStack(spacing: 32) {
                Spacer()

                VStack(spacing: 8) {
                    Image(systemName: "video.fill")
                        .font(.system(size: 56))
                        .foregroundColor(.accentColor)
                    Text("FPS Monitor")
                        .font(.largeTitle.bold())
                    Text("Local WiFi camera streaming & FPS analytics")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }

                Spacer()

                VStack(spacing: 16) {
                    NavigationLink(destination: ProducerView()) {
                        RoleButton(
                            icon: "antenna.radiowaves.left.and.right",
                            title: "Broadcast (Producer)",
                            subtitle: "Stream this device's camera"
                        )
                    }

                    NavigationLink(destination: ViewerView()) {
                        RoleButton(
                            icon: "eye.fill",
                            title: "View Stream (Viewer)",
                            subtitle: "Watch & monitor FPS from the other device"
                        )
                    }
                }
                .padding(.horizontal, 24)

                Spacer()
                Spacer()
            }
            .navigationBarHidden(true)
        }
        .navigationViewStyle(.stack)
    }
}

private struct RoleButton: View {
    let icon: String
    let title: String
    let subtitle: String

    var body: some View {
        HStack(spacing: 16) {
            Image(systemName: icon)
                .font(.title2)
                .frame(width: 44, height: 44)
                .background(Color.accentColor.opacity(0.15))
                .foregroundColor(.accentColor)
                .clipShape(RoundedRectangle(cornerRadius: 12))

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.headline)
                    .foregroundColor(.primary)
                Text(subtitle)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Spacer()
            Image(systemName: "chevron.right")
                .foregroundColor(.secondary)
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }
}

#Preview {
    HomeView()
}
