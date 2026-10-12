import AppKit
import SwiftUI

// Accessory app: no Dock icon, no menu bar takeover. The notch panel is the UI.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var panel: IslandPanel?
    private let bridge = OxBridge()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // `ox island off` (or the island's own menu) keeps it off until `ox island on`.
        guard IslandSwitch.enabled || CommandLine.arguments.contains("--force") else {
            NSApp.terminate(nil)
            return
        }
        writePresence()
        let buddy = bridge.buddy
        BuddyHotKey.install(press: { buddy.startListening() }, release: { buddy.stopListening() })
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

// Dev aid: `OxIsland --render-avatar <dir>` writes one sheet per Buddy character:
// expressions across, each with a different mouth shape and gesture.
if let i = CommandLine.arguments.firstIndex(of: "--render-avatar"), i + 1 < CommandLine.arguments.count {
    let dir = URL(fileURLWithPath: CommandLine.arguments[i + 1])
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let poses: [(Expression, Viseme, Gesture)] = [
        (.neutral, .rest, .rest), (.happy, .open, .beat(2)), (.thinking, .closed, .think),
        (.surprised, .round, .open), (.worried, .small, .rest), (.listening, .wide, .point), (.happy, .teeth, .wave),
    ]
    MainActor.assumeIsolated {
        for kind in AvatarKind.allCases {
            let cell: CGFloat = 160
            let view = Canvas { ctx, _ in
                for (n, pose) in poses.enumerated() {
                    var c = ctx
                    c.translateBy(x: CGFloat(n) * cell, y: 0)
                    if kind == .ox {
                        AvatarPainter(kind: kind, look: AvatarLook.of(kind), expression: pose.0, mouth: pose.1,
                                      gesture: pose.2, level: 0, gaze: CGVector(dx: 0.3, dy: 0), t: 1.0)
                            .paint(&c, CGSize(width: cell, height: cell))
                    } else {
                        let p = PixelBuddy.pose(expression: pose.0, mouth: pose.1, gesture: pose.2, t: 1.0)
                        PixelCast.draw(&c, kind.rawValue, p, at: CGPoint(x: (cell - 5 * 18) / 2, y: cell - 5 * 26), px: 5)
                    }
                }
            }
            .frame(width: cell * CGFloat(poses.count), height: cell)
            .background(Color(hex: "#141518"))
            let r = ImageRenderer(content: view)
            r.scale = 2
            if let img = r.nsImage, let tiff = img.tiffRepresentation,
               let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                try? png.write(to: dir.appendingPathComponent("avatar-\(kind.rawValue).png"))
            }
        }
    }
    exit(0)
}

// Dev aid: `OxIsland --render-office <dir>` writes the office with one desk per
// phase (lead, typing, reading, thinking, done, failed) plus the pasture farmer.
if let i = CommandLine.arguments.firstIndex(of: "--render-office"), i + 1 < CommandLine.arguments.count {
    let dir = URL(fileURLWithPath: CommandLine.arguments[i + 1])
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    MainActor.assumeIsolated {
        let desks: [(String, String?, String, SubAgent.Phase, String)] = [
            ("lead", nil, "thinking", .thinking, "#E9A66B"), ("auth fix", "mira", "edit_file", .working, "#EC4899"),
            ("find usages", "theo", "grep", .working, "#10B981"), ("plan", "ade", "thinking", .thinking, "#F59E0B"),
            ("tests", "lin", "done", .done, "#8B5CF6"), ("deploy", "sol", "failed", .failed, "#06B6D4"),
        ]
        let view = HStack(alignment: .top, spacing: 4) {
            ForEach(Array(desks.enumerated()), id: \.offset) { _, d in
                AgentDesk(name: d.0, person: d.1, detail: d.2, model: "haiku", tokens: 1234, phase: d.3, tint: Color(hex: d.4),
                          kind: d.1 == nil ? .lead : .sub)
            }
            PixelPersonView(person: "farmer", pose: PixelPose(dir: .front, pose: "wave", mouth: "smile"), height: 66)
            PixelPersonView(person: "farmer", pose: PixelPose(dir: .side, pose: "walk", frame: 1), height: 66)
        }
        .padding(10)
        .background(Color(hex: "#141518"))
        let r = ImageRenderer(content: view)
        r.scale = 2
        if let img = r.nsImage, let tiff = img.tiffRepresentation,
           let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            try? png.write(to: dir.appendingPathComponent("office.png"))
        }
    }
    exit(0)
}

// Dev aid: `OxIsland --render-reactions <dir>` draws the touch reactions
// (art/CHARACTERS.md): the bull's bubbles and doze, and poked helpers.
if let i = CommandLine.arguments.firstIndex(of: "--render-reactions"), i + 1 < CommandLine.arguments.count {
    let dir = URL(fileURLWithPath: CommandLine.arguments[i + 1])
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    MainActor.assumeIsolated {
        func bull(_ cycle: OxCycle, _ bubble: Pasture.Bubble?) -> some View {
            let frames = OxFrames.frames(cycle)
            return ZStack(alignment: .bottomLeading) {
                if let f = frames.first { Image(nsImage: f).resizable().frame(width: 112, height: 84) }
                if cycle == .doze { Snore(t: 1.3, size: 18).offset(x: 86, y: -52) }
                if let bubble { SpeechBubble(bubble: bubble, size: 12).fixedSize().offset(x: 56, y: -70) }
            }
            .frame(width: 150, height: 120, alignment: .bottomLeading)
        }
        let poked = { (count: Int, phase: SubAgent.Phase, who: String) in
            AgentDesk(name: who, person: who, detail: "edit_file", model: "", tokens: 0, phase: phase, tint: Color(hex: "#EC4899"))
        }
        let view = VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .bottom, spacing: 8) {
                bull(.kick, .init(text: "Moo?", tone: .plain, until: .infinity))
                bull(.alert, .init(text: "MOO! 💢", tone: .angry, until: .infinity))
                bull(.doze, nil)
                bull(.kick, .init(text: "MOO!!", tone: .angry, until: .infinity))
                bull(.idle, .init(text: "zzz… rude", tone: .sleepy, until: .infinity))
                bull(.walk, .init(text: "busy!", tone: .busy, until: .infinity))
            }
            HStack(spacing: 6) {
                ForEach(Array([(1, SubAgent.Phase.working, "mira"), (1, .thinking, "theo"), (1, .done, "ade"), (1, .failed, "lin"), (3, .working, "rui")].enumerated()), id: \.offset) { _, p in
                    PokedDesk(desk: poked(p.0, p.1, p.2), count: p.0)
                }
            }
        }
        .padding(14)
        .background(Color(hex: "#141518"))
        let r = ImageRenderer(content: view)
        r.scale = 2
        if let img = r.nsImage, let tiff = img.tiffRepresentation,
           let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            try? png.write(to: dir.appendingPathComponent("reactions.png"))
        }
    }
    exit(0)
}

/// Renders a desk as if it had just been poked `count` times (dev aid only).
struct PokedDesk: View {
    let desk: AgentDesk
    let count: Int
    var body: some View {
        Canvas { g, _ in
            desk.drawHelper(&g, person: desk.person ?? "mira", t: Date().timeIntervalSinceReferenceDate,
                            poke: .init(at: Date().timeIntervalSinceReferenceDate, count: count))
        }
        .frame(width: 84, height: 66)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
