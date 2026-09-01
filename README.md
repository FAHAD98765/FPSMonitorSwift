# FPS Monitor — Live Camera Streaming & FPS Analytics (Native iOS, Swift)

Two iPhones on the same WiFi. One broadcasts its camera (**Producer**), the other
watches the stream and tracks FPS, freezes, and frame drops (**Viewer**). Video goes
peer-to-peer over WebRTC; a tiny Node.js server only handles the initial handshake
(signaling) and never touches the video itself.

```
Producer (iPhone A)  --camera-->  WebRTC (P2P, local WiFi)  -->  Viewer (iPhone B)
        \                                                          /
         \---------------- Signaling Server (Node, WS) -----------/
                     (only exchanges SDP + ICE candidates)
```

## Repo layout

```
FPSMonitor/
├── ios-app/                    # Native Swift/SwiftUI app (Xcode, via XcodeGen)
│   ├── project.yml             # XcodeGen spec — generates the .xcodeproj on Mac
│   └── FPSMonitor/
│       ├── FPSMonitorApp.swift
│       ├── HomeView.swift
│       ├── Producer/           # Broadcaster screen + view model
│       ├── Viewer/             # Viewer screen + view model
│       ├── Shared/
│       │   ├── Models/         # AppConfig, ConnectionInfo, FPSMonitor
│       │   ├── Signaling/      # WebSocket signaling client
│       │   ├── WebRTC/         # WebRTCManager + SwiftUI video render view
│       │   ├── QRScannerView.swift
│       │   └── QRCodeGenerator.swift
│       └── Resources/
│           └── LaunchScreen.storyboard
└── SignalingServer/            # Signaling relay — Node.js OR Python (pick one)
    ├── server.js                # Node.js version
    ├── package.json
    ├── ws_relay.py               # Python version (same protocol, drop-in alternative)
    └── requirements.txt
```

## What you can do on Windows (today)

- Edit/review all `.swift` files — this repo, VS Code, whatever you like.
- Run and test the signaling relay — **either** works, pick one:

  **Node.js version:**
  ```bash
  cd SignalingServer
  npm install
  npm start
  ```

  **Python version** (same wire protocol — the iOS app doesn't care which one you run):
  ```bash
  cd SignalingServer
  pip install -r requirements.txt
  python3 ws_relay.py
  ```
- `git add . && git commit -m "..." && git push` — push everything to GitHub.

You **cannot** build, run, or simulate the iOS app on Windows — Xcode is
Mac-only, and this project uses `react-native-webrtc`'s native cousin
(`GoogleWebRTC` via SPM), which only resolves inside Xcode.

## What to do on Mac (tomorrow)

1. **Clone / pull the repo**
   ```bash
   git clone <your-repo-url>
   cd FPSMonitor
   ```
   (or `git pull` if already cloned)

2. **Install XcodeGen** (one-time, if not already installed)
   ```bash
   brew install xcodegen
   ```

3. **Generate the Xcode project**
   ```bash
   cd ios-app
   xcodegen generate
   ```
   This creates `FPSMonitor.xcodeproj`. Open it:
   ```bash
   open FPSMonitor.xcodeproj
   ```
   Xcode will automatically resolve the `WebRTC` Swift Package (from
   `project.yml`) — this needs internet access once.

4. **Run the signaling relay** on your Mac (or on either phone's terminal
   equivalent — but simplest is your Mac, since both phones are on the same
   WiFi as it). Either works — same protocol, same port:

   **Node.js:**
   ```bash
   cd ../SignalingServer
   npm install
   npm start
   ```

   **Python:**
   ```bash
   cd ../SignalingServer
   pip3 install -r requirements.txt
   python3 ws_relay.py
   ```
   It prints your LAN IP, e.g. `ws://192.168.1.23:8765` — note this.

5. **Build & run on two REAL iPhones** (not the simulator — camera + WebRTC
   need real hardware). In Xcode: select each iPhone as the run destination,
   build once per device (⌘R). Both phones must be on the same WiFi as your
   Mac/signaling server.

6. **On Phone A** (broadcaster): open the app → "Broadcast (Producer)" → the
   host IP auto-fills → tap **Start Broadcasting**. A QR code appears.

7. **On Phone B** (viewer): open the app → "View Stream (Viewer)" → tap
   **Scan QR Code** and scan Phone A's screen (or type the host/port/session
   ID manually) → tap **Connect**.

8. You should see Phone A's camera feed live on Phone B, with FPS, frame
   drops, and freeze detection updating in real time.

## Notes / known constraints

- **Simulator won't work** — no camera access. Always test on two physical
  iPhones.
- **Same WiFi required** — this is LAN-only by design (no TURN/relay server),
  so both phones and the machine running the signaling server must be on the
  same network. Corporate/guest WiFi with client isolation will block this.
- **First launch** will prompt for Camera and Local Network permissions —
  accept both, or streaming/pairing will silently fail.
- If two phones can't see each other, check the Mac's firewall isn't
  blocking incoming connections on port `8765`.
