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
        let wake = bridge.wake
        // The microphone is handed over, never shared: « OK ox » steps aside.
        BuddyHotKey.install(press: { MainActor.assumeIsolated { wake.stop() }; buddy.startListening() },
                            release: { buddy.stopListening(); DispatchQueue.main.asyncAfter(deadline: .now() + 6) { MainActor.assumeIsolated { wake.start() } } })
        FnKey.install(press: { MainActor.assumeIsolated { wake.stop() }; buddy.startListening() },
                      release: { buddy.stopListening(); DispatchQueue.main.asyncAfter(deadline: .now() + 6) { MainActor.assumeIsolated { wake.start() } } })
        MainActor.assumeIsolated { bridge.dictation.install() }
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

// Check: `OxIsland --check-commands` runs the island's own command matching on
// real phrases (the ones in the owner's videos included) and exits 1 on any miss.
if CommandLine.arguments.contains("--check-commands") {
    let keys = ["island.size", "island.autoClose", "ox.name"]
    let saved = keys.map { UserDefaults.standard.object(forKey: $0) }
    var fails = 0
    MainActor.assumeIsolated {
        let b = OxBridge()
        // `--check-commands <file>`: the shared evals (evals/island/commands.json), learned cases included.
        var fromFile: [String: Any]?
        if let i = CommandLine.arguments.firstIndex(of: "--check-commands"), i + 1 < CommandLine.arguments.count,
           let d = FileManager.default.contents(atPath: CommandLine.arguments[i + 1]) {
            fromFile = try? JSONSerialization.jsonObject(with: d) as? [String: Any]
        }
        var island: [(String, Bool)] = [
            ("make the island smaller", true), ("make yourself smaller", true), ("Make the island a bit smaller.", true),
            ("smaller", true), ("make the island bigger", true), ("close", true), ("hide", true), ("close the island", true),
            ("stay open", true), ("keep the island open", true),
            ("make the text smaller", false), ("can you close the tab", false), ("hide the dock", false),
            ("close all my chrome windows", false), ("make the font bigger", false), ("open chrome", false),
            ("play Billie Jean", false), ("what is the time", false), ("keep the door open", false),
        ]
        for (phrase, want) in island {
            let got = b.islandCommand(phrase) != nil
            if got != want { fails += 1; print("FAIL island \(want ? "should" : "should not") take: \(phrase)") } else { print("ok   \(want ? "island " : "ox     ") \(phrase)") }
        }
        if let f = fromFile {
            island = ((f["island"] as? [String]) ?? []).map { ($0, true) } + ((f["ox"] as? [String]) ?? []).map { ($0, false) }
        }
        var split: [(String, String?)] = [
            ("make yourself smaller and turn down the volume just a little bit", "turn down the volume just a little bit"),
            ("make the island smaller, then open spotify", "open spotify"),
            ("close", nil),
        ]
        if let f = fromFile, let rows = f["split"] as? [[String: Any]] {
            split = rows.compactMap { r in (r["text"] as? String).map { ($0, r["rest"] as? String) } }.filter { $0.1 != "(all to ox)" }
        }
        for (phrase, rest) in split {
            let p = b.islandPart(phrase)
            if p == nil || p?.rest != rest { fails += 1; print("FAIL split: \(phrase) → \(String(describing: p))") } else { print("ok   split  \(phrase) → rest: \(rest ?? "(none)")") }
        }
        if b.islandPart("open chrome and youtube") != nil { fails += 1; print("FAIL split took a non-island request") } else { print("ok   split  open chrome and youtube → all to ox") }
        for (id, want) in [("codex", "ChatGPT"), ("claude", "Claude"), ("gemini", "Gemini"), ("cursor", "Cursor")] {
            if OxBridge.planLabel(id) != want { fails += 1; print("FAIL plan label \(id)") } else { print("ok   plan   \(id) → \(want)") }
        }
    }
    for (k, v) in zip(keys, saved) { UserDefaults.standard.set(v, forKey: k) }
    print(fails == 0 ? "all island commands right" : "\(fails) wrong")
    exit(fails == 0 ? 0 : 1)
}

// Dev aid: `OxIsland --render-marks <file.png>` draws sample screen marks (the
// Pixie physics example) over a dark frame, to review how they look.
if let i = CommandLine.arguments.firstIndex(of: "--render-marks"), i + 1 < CommandLine.arguments.count {
    MainActor.assumeIsolated {
        let (say, marks) = Buddy.parseMarks("A pushes B [CIRCLE:300,320,70:A] [CIRCLE:760,330,55:B] [ARROW:380,300,690,310:push] [ARROW:690,370,380,370:reaction] [BOX:180,120,700,90:F_A = -F_B]")
        let view = ZStack { Color(hex: "#1B1D22"); MarksView(marks: marks, scale: 1).onAppear {} }.frame(width: 1000, height: 560)
        let r = ImageRenderer(content: view.environment(\.self, EnvironmentValues()))
        r.scale = 1
        if let img = r.nsImage, let tiff = img.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: CommandLine.arguments[i + 1]))
        }
        print("said: \(say) · \(marks.count) marks")
    }
    exit(0)
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

// Dev aid: `OxIsland --render-runs <board.json> <file.png>` draws the open
// island's run list from an /ox/live answer (other agents' sessions included).
if let i = CommandLine.arguments.firstIndex(of: "--render-runs"), i + 2 < CommandLine.arguments.count {
    MainActor.assumeIsolated {
        let b = OxBridge()
        if let d = FileManager.default.contents(atPath: CommandLine.arguments[i + 1]),
           let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let runs = j["runs"] as? [[String: Any]] {
            b.previewBoard(runs)
        }
        let view = Card(wash: Color.white.opacity(0.18)) {
            VStack(alignment: .leading, spacing: 7) { ForEach(b.sessions.prefix(4)) { s in RunRow(bridge: b, session: s) } }
        }.frame(width: 600, height: 120).padding(10).background(Color.black)
        let r = ImageRenderer(content: view)
        r.scale = 2
        if let img = r.nsImage, let tiff = img.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: CommandLine.arguments[i + 2]))
        }
        print("\(b.sessions.count) runs")
    }
    exit(0)
}

// Dev aid: `OxIsland --render-meter <dir>` draws the idle card with today's usage meter.
if let i = CommandLine.arguments.firstIndex(of: "--render-meter"), i + 1 < CommandLine.arguments.count {
    let dir = URL(fileURLWithPath: CommandLine.arguments[i + 1])
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    MainActor.assumeIsolated {
        let view = Card(wash: nil) {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text("Nothing running").font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Ink.text)
                    Text("· type or talk to ox, or start it in a terminal").font(.system(size: 12)).foregroundStyle(Ink.muted).lineLimit(1)
                }
                TodayMeter(today: .init(tokens: 40368, runs: 16, cost: nil, topModel: "qwen2.5:1.5b"))
            }
        }
        .frame(width: 560, height: 70)
        .padding(10)
        .background(Color.black)
        let r = ImageRenderer(content: view)
        r.scale = 2
        if let img = r.nsImage, let tiff = img.tiffRepresentation,
           let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            try? png.write(to: dir.appendingPathComponent("meter.png"))
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

// Dev aid: `OxIsland --render-story <dir>` runs the pasture on a simulated
// clock through the barn storyboard and draws the key moments in one strip.
if let i = CommandLine.arguments.firstIndex(of: "--render-story"), i + 1 < CommandLine.arguments.count {
    let dir = URL(fileURLWithPath: CommandLine.arguments[i + 1])
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    MainActor.assumeIsolated {
        let p = Pasture()
        Pasture.dozeAfter = 20
        p.resetClock(0)
        let height: CGFloat = 84, width = height * 4 / 3, laneW: CGFloat = 420
        let lane = laneW - width, barnW = height * 1.15
        var t = 0.0
        var shots: [(String, Double)] = []
        func run(to end: Double) {
            while t < end { t += 1.0 / 24; p.step(now: t, lane: lane, height: height, farmerWidth: 40, allowVisitors: false, allowDoze: true, homeWidth: barnW * 0.9) }
        }
        func snap(_ label: String) -> some View {
            let turn = p.turnIndex(now: t)
            let frames = turn != nil ? Frames.load("ox/turn") : OxFrames.frames(p.cycle)
            let img = frames.isEmpty ? nil : frames[turn ?? 0]
            return VStack(spacing: 4) {
                ZStack(alignment: .bottomLeading) {
                    Rectangle().fill(Color(hex: "#141518"))
                    if !p.home, let img {
                        Image(nsImage: img).resizable().frame(width: width, height: height)
                            .scaleEffect(x: turn == nil && !p.facingRight ? -1 : 1, y: 1).offset(x: p.x)
                    }
                    if let b = p.barnState(now: t) {
                        BarnSprite(image: b.image, scale: b.scale, dust: b.dust)
                            .frame(width: barnW, height: barnW * 0.9).offset(x: laneW - barnW, y: height * 0.04)
                    }
                    if p.home { Snore(t: t, size: height * 0.22).offset(x: laneW - barnW * 0.45, y: -height * 0.72) }
                    if let b = p.bubble, t < b.until { SpeechBubble(bubble: b, size: 13).fixedSize().offset(x: min(p.x + width * 0.5, laneW - height * 1.35), y: -height * 0.8) }
                }
                .frame(width: laneW, height: height * 1.5)
                Text(label).font(.system(size: 12, weight: .semibold)).foregroundStyle(.white)
            }
        }
        var views: [AnyView] = []
        run(to: 3); views.append(AnyView(snap("1. grazing, no barn")))
        run(to: 20.3); views.append(AnyView(snap("2. quiet: the barn rises")))
        run(to: 22.5); views.append(AnyView(snap("3. walking home")))
        while !p.home && t < 60 { run(to: t + 0.2) }
        run(to: t + 0.6); views.append(AnyView(snap("4. inside: door shut, lantern lit")))
        run(to: t + 5); views.append(AnyView(snap("5. asleep")))
        p.poke(now: t, mood: .sleeping)
        run(to: t + 0.4); views.append(AnyView(snap("6. poked: door bursts open")))
        run(to: t + 1.1); views.append(AnyView(snap("7. the barn sinks")))
        run(to: t + 1.0); views.append(AnyView(snap("8. the barn is gone")))
        run(to: t + 3.0); views.append(AnyView(snap("9. back to the pasture")))
        let sheet = VStack(alignment: .leading, spacing: 10) { ForEach(0..<views.count, id: \.self) { views[$0] } }
            .padding(12).background(Color.black)
        let r = ImageRenderer(content: sheet)
        r.scale = 1.5
        if let img = r.nsImage, let tiff = img.tiffRepresentation,
           let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            try? png.write(to: dir.appendingPathComponent("story.png"))
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
