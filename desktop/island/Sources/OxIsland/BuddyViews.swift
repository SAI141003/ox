import SwiftUI

// The island's OX Buddy surfaces: the avatar lane, what it heard or is saying,
// the mic in the header, and the right-click menu (character, island off).

struct BuddyLane: View {
    @ObservedObject var buddy: Buddy
    let mood: Mood

    var body: some View {
        AvatarView(kind: buddy.character, expression: Expression.of(mood, buddy: buddy.phase),
                   mouth: buddy.mouth, gesture: buddy.gesture, level: buddy.level)
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
    var body: some View {
        Button(buddy.phase == .listening ? "Stop listening" : "Talk to ox (⌃⌥Space)") { buddy.toggle() }
        Picker("Buddy character", selection: $buddy.character) {
            ForEach(AvatarKind.allCases) { Text($0.title).tag($0) }
        }
        Divider()
        Button("Turn off OX Island") { IslandSwitch.turnOff() }
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
