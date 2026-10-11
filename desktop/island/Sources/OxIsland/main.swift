import AppKit
import SwiftUI

// Accessory app: no Dock icon, no menu bar takeover. The notch panel is the UI.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var panel: IslandPanel?
    private let bridge = OxBridge()

    func applicationDidFinishLaunching(_ notification: Notification) {
        writePresence()
        let panel = IslandPanel(bridge: bridge)
        panel.orderFrontRegardless()
        self.panel = panel
        bridge.start()

        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil, queue: .main
        ) { [weak self] _ in self?.panel?.reposition(animated: false) }
    }

    func applicationWillTerminate(_ notification: Notification) {
        bridge.stop()
        try? FileManager.default.removeItem(at: Presence.file)
    }

    /// ~/.ox/island.json tells ox runs an island is listening (src/island.js).
    private func writePresence() {
        let dir = Presence.file.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let body: [String: Any] = [
            "pid": ProcessInfo.processInfo.processIdentifier,
            "version": 1,
            "startedAt": ISO8601DateFormatter().string(from: Date()),
        ]
        if let data = try? JSONSerialization.data(withJSONObject: body) {
            try? data.write(to: Presence.file, options: .atomic)
        }
    }
}

enum Presence {
    static let file = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".ox/island.json")
}

// Clean up the presence file on Ctrl-C / kill too, not only on Quit.
for sig in [SIGINT, SIGTERM] {
    signal(sig) { _ in
        unlink(Presence.file.path)
        exit(0)
    }
}

// Dev aid: `OxIsland --render-mascot <dir>` writes one PNG per mood and exits,
// so the character can be reviewed (and diffed) without running the island.
if let i = CommandLine.arguments.firstIndex(of: "--render-mascot"), i + 1 < CommandLine.arguments.count {
    let dir = URL(fileURLWithPath: CommandLine.arguments[i + 1])
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let moods: [(String, Mood)] = [("sleeping", .sleeping), ("idle", .idle), ("thinking", .thinking),
                                   ("working", .working("bash")), ("needs-you", .needsYou), ("done", .done), ("error", .error("x"))]
    MainActor.assumeIsolated {
        for (name, mood) in moods {
            let view = Canvas { ctx, size in
                OxPainter(mood: mood, t: 0.5, look: CGVector(dx: 0.3, dy: 0.2)).paint(&ctx, size: size)
            }
            .frame(width: 240, height: 240)
            .background(Color.black)
            let r = ImageRenderer(content: view)
            r.scale = 2
            if let img = r.nsImage, let tiff = img.tiffRepresentation,
               let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                try? png.write(to: dir.appendingPathComponent("\(name).png"))
            }
        }
    }
    exit(0)
}

// Dev aid: `OxIsland --render-launch <dir>` writes key frames of the launch scene.
if let i = CommandLine.arguments.firstIndex(of: "--render-launch"), i + 1 < CommandLine.arguments.count {
    let dir = URL(fileURLWithPath: CommandLine.arguments[i + 1])
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let size = CGSize(width: 520, height: 150)
    let scene = LaunchScene(size: size)
    MainActor.assumeIsolated {
        for t in [0.25, 0.5, 0.66, 0.72, 0.8, 0.95, 1.15, 1.7] {
            let view = Canvas { g, sz in scene.draw(&g, size: sz, t: t) }.frame(width: size.width, height: size.height)
            let r = ImageRenderer(content: view)
            r.scale = 2
            if let img = r.nsImage, let tiff = img.tiffRepresentation,
               let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                try? png.write(to: dir.appendingPathComponent(String(format: "t%.2f.png", t)))
            }
        }
    }
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
