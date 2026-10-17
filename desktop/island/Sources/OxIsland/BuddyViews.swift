import SwiftUI

// The island's OX Buddy surfaces: the avatar lane, what it heard or is saying,
// the mic in the header, and the right-click menu (character, island off).

struct BuddyLane: View {
    @ObservedObject var buddy: Buddy
    let mood: Mood
    /// A poke: a surprised face and "hey!"; a third poke in two seconds gets a grump.
    @State private var poke = AgentDesk.Poke()

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.2)) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            let poked = t - poke.at < 1.4 && buddy.phase != .speaking
            let grumpy = poked && poke.count >= 3
            ZStack(alignment: .top) {
                AvatarView(kind: buddy.character,
                           expression: poked ? (grumpy ? .worried : .surprised) : Expression.of(mood, buddy: buddy.phase),
                           mouth: poked ? (grumpy ? .wide : .round) : buddy.mouth,
                           gesture: poked ? (grumpy ? .open : .wave) : buddy.gesture,
                           level: buddy.level)
                if poked {
                    SpeechBubble(bubble: .init(text: grumpy ? "quit it!" : "hey!", tone: grumpy ? .angry : .plain, until: .infinity), size: 10)
                        .offset(x: 30, y: -2)
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            let now = Date().timeIntervalSinceReferenceDate
            poke = .init(at: now, count: now - poke.at < 2 ? poke.count + 1 : 1)
        }
    }
}

struct BuddyBody: View {
    @ObservedObject var buddy: Buddy

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            switch buddy.phase {
            case .listening:
                HStack(spacing: 8) {
                    Text("Listening").font(.system(size: 13, weight: .semibold)).foregroundStyle(Ink.text)
                    LevelBars(level: buddy.level)
                }
                Text(buddy.heard.isEmpty ? "Ask about anything on your screen. Release ⌃⌥Space to send." : buddy.heard)
                    .font(.system(size: 12)).foregroundStyle(buddy.heard.isEmpty ? Ink.muted : Ink.text.opacity(0.9))
                    .lineLimit(3).truncationMode(.head)
            case .thinking:
                Text("Looking at your screen…").font(.system(size: 13, weight: .semibold)).foregroundStyle(Ink.text)
                Text("“\(buddy.heard)”").font(.system(size: 12)).foregroundStyle(Ink.muted).lineLimit(2)
            case .speaking:
                Text(buddy.saying).font(.system(size: 12.5)).foregroundStyle(Ink.text.opacity(0.92))
                    .lineLimit(4).fixedSize(horizontal: false, vertical: true)
                Button("Stop") { buddy.stopSpeaking() }
                    .buttonStyle(.plain).font(.system(size: 11, weight: .semibold)).foregroundStyle(Ink.muted)
            case .message(let m):
                Text(m).font(.system(size: 12)).foregroundStyle(Ink.text.opacity(0.9)).fixedSize(horizontal: false, vertical: true)
            case .idle:
                EmptyView()
            }
        }
    }
}

struct LevelBars: View {
    let level: Double
    var body: some View {
        TimelineView(.animation) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            HStack(spacing: 2) {
                ForEach(0..<5, id: \.self) { i in
                    let wobble = (sin(t * 12 + Double(i) * 1.3) + 1) / 2
                    Capsule().fill(Ink.gold)
                        .frame(width: 3, height: 4 + 12 * max(0.15, min(1, level * (0.5 + wobble))))
                }
            }
            .frame(height: 16)
        }
    }
}

struct MicButton: View {
    @ObservedObject var buddy: Buddy
    var body: some View {
        Button(action: { buddy.toggle() }) {
            Image(systemName: buddy.phase == .listening ? "waveform" : "mic.fill")
                .font(.system(size: 11, weight: .semibold))
                .frame(width: 24, height: 24)
                .background(Circle().fill(buddy.phase == .listening ? Ink.gold : Color.white.opacity(0.1)))
                .foregroundStyle(buddy.phase == .listening ? Color.black : Ink.text)
        }
        .buttonStyle(.plain)
        .help("Talk to ox (or hold ⌃⌥Space anywhere)")
        .accessibilityLabel(buddy.phase == .listening ? "Stop listening" : "Talk to ox")
    }
}

struct IslandMenu: View {
    @ObservedObject var buddy: Buddy
    @AppStorage("buddy.naturalVoice") private var naturalVoice = true
    @AppStorage("island.size") private var islandSize = "standard"
    @AppStorage("dictation.enabled") private var dictationOn = true
    @AppStorage("wake.enabled") private var wakeOn = false
    var bridge: OxBridge? = nil
    @AppStorage("island.autoClose") private var autoClose = 6.0
    var body: some View {
        Button(buddy.phase == .listening ? "Stop listening" : "Talk to ox (⌃⌥Space)") { buddy.toggle() }
        Picker("Buddy character", selection: $buddy.character) {
            ForEach(AvatarKind.allCases) { Text($0.title).tag($0) }
        }
        Toggle("Natural voice (Kokoro)", isOn: $naturalVoice)
        Divider()
        Toggle("Dictation anywhere (hold ⌃⌥D)", isOn: $dictationOn)
        Toggle("Listen for “OK ox”", isOn: Binding(get: { wakeOn }, set: { on in wakeOn = on; bridge?.wake.setEnabled(on) }))
        Button(bridge?.notes.recording == true ? "Stop call notes" : "Record call notes (your microphone)") { bridge?.notes.toggle() }
        Button("Edit my dictionary…") { NSWorkspace.shared.open(PersonalDictionary.ensureFile()) }
        Divider()
        Picker("Island size", selection: $islandSize) {
            Text("Standard").tag("standard")
            Text("Compact").tag("compact")
        }
        Picker("Close by itself", selection: $autoClose) {
            Text("After 3 seconds").tag(3.0)
            Text("After 6 seconds").tag(6.0)
            Text("After 15 seconds").tag(15.0)
            Text("Never").tag(0.0)
        }
        Divider()
        Button("Turn off OX Island") { IslandSwitch.turnOff() }
    }
}

/// The name you gave ox (`ox name`, Settings › General in the app): the island
/// shows it everywhere it would say "ox". Read fresh each time, so a rename
/// shows up on the next redraw without restarting the island.
enum OxName {
    static var current: String {
        guard let data = try? Data(contentsOf: IslandSwitch.config),
              let doc = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let n = doc["name"] as? String else { return "ox" }
        let t = n.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty || t.count > 24 ? "ox" : t
    }
}

/// The island's own off switch: same setting as `ox island off`.
enum IslandSwitch {
    static let config = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ox/config.json")

    static var enabled: Bool {
        guard let data = try? Data(contentsOf: config),
              let doc = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return true }
        if let b = doc["island"] as? Bool { return b }
        if let d = doc["island"] as? [String: Any], let b = d["enabled"] as? Bool { return b }
        return true
    }

    static func turnOff() {
        // Keep every other key: this file belongs to ox (src/config.js saveConfigDoc).
        var doc: [String: Any] = [:]
        if let data = try? Data(contentsOf: config), let d = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { doc = d }
        doc["island"] = false
        try? FileManager.default.createDirectory(at: config.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let out = try? JSONSerialization.data(withJSONObject: doc, options: [.prettyPrinted, .sortedKeys]) {
            try? (out + Data("\n".utf8)).write(to: config, options: .atomic)
        }
        NSApp.terminate(nil)
    }
}
