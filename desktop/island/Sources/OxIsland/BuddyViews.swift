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
                Text(buddy.heard.isEmpty ? (buddy.handsFree ? "Ask about anything on your screen. Pause when you are done, or tap stop." : "Ask about anything on your screen. Release ⌃⌥Space to send.") : buddy.heard)
                    .font(.system(size: 12)).foregroundStyle(buddy.heard.isEmpty ? Ink.muted : Ink.text.opacity(0.9))
                    .lineLimit(3).truncationMode(.head)
            case .thinking:
                Text("Looking at your screen…").font(.system(size: 13, weight: .semibold)).foregroundStyle(Ink.text)
                Text("“\(buddy.heard)”").font(.system(size: 12)).foregroundStyle(Ink.muted).lineLimit(2)
            case .speaking:
                Text(buddy.saying).font(.system(size: 12.5)).foregroundStyle(Ink.text.opacity(0.92))
                    .lineLimit(4).fixedSize(horizontal: false, vertical: true)
                Button(T("Stop")) { buddy.stopSpeaking() }
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
            Image(systemName: buddy.phase == .listening ? "stop.fill" : "mic.fill")
                .font(.system(size: 11, weight: .semibold))
                .frame(width: 24, height: 24)
                .background(Circle().fill(buddy.phase == .listening ? Ink.gold : Color.white.opacity(0.1)))
                .foregroundStyle(buddy.phase == .listening ? Color.black : Ink.text)
        }
        .buttonStyle(.plain)
        .help(buddy.phase == .listening ? "Tap to stop listening" : "Talk to ox (or hold ⌃⌥Space anywhere)")
        .accessibilityLabel(buddy.phase == .listening ? "Stop listening" : "Talk to ox")
    }
}

struct IslandMenu: View {
    @ObservedObject var buddy: Buddy
    @AppStorage("buddy.naturalVoice") private var naturalVoice = true
    @AppStorage("island.size") private var islandSize = "standard"
    @AppStorage("dictation.enabled") private var dictationOn = true
    @AppStorage("wake.enabled") private var wakeOn = false
    @AppStorage("fn.talk") private var fnTalk = true
    @AppStorage("island.hideFullscreen") private var hideFullscreen = true
    @AppStorage("island.screen") private var islandScreen = "notch"
    @AppStorage("pet.kind") private var petKind = "none"
    var bridge: OxBridge? = nil
    @AppStorage("island.autoClose") private var autoClose = 6.0
    var body: some View {
        Button(buddy.phase == .listening ? "Stop listening" : "Talk to \(OxName.current) (hold Fn or ⌃⌥Space)") { buddy.toggle() }
        Button("Rename \(OxName.current)…") { OxName.askRename() }
        if !CGPreflightScreenCaptureAccess() {
            Button("Let \(OxName.current) see your screen…") {
                // Asked once, when you choose it; until then, nothing asks.
                if !CGRequestScreenCaptureAccess() {
                    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
                }
            }
        }
        Picker("Companion", selection: $buddy.character) {
            ForEach(AvatarKind.allCases) { Text($0.title).tag($0) }
        }
        Picker("Island pet", selection: $petKind) {
            ForEach(IslandPetKind.allCases) { Text($0.title).tag($0.rawValue) }
        }
        Toggle("Natural voice (Kokoro)", isOn: $naturalVoice)
        Divider()
        Toggle("Dictation anywhere (hold ⌃⌥D)", isOn: $dictationOn)
        Toggle("Hold Fn to talk", isOn: $fnTalk)
        if fnTalk, FnKey.globeOpensSomething { Text("The Fn key also opens \(FnKey.globeAction): set Keyboard › “Press 🌐 key to” to Do Nothing").font(.caption) }
        Toggle(OxName.current.count >= 4 ? "Listen for “\(OxName.current)”" : "Listen for “OK \(OxName.current)”", isOn: Binding(get: { wakeOn }, set: { on in wakeOn = on; bridge?.wake.setEnabled(on) }))
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
        Toggle("Hide during full-screen apps", isOn: $hideFullscreen)
        Picker("Island display", selection: $islandScreen) {
            Text("Built-in notch").tag("notch")
            Text("Follow pointer across displays").tag("active")
        }
        Divider()
        Button(T("Turn off OX Island")) { IslandSwitch.turnOff() }
    }
}

/// The same controls as the context menu, but deliberately visible from the
/// Island's + shelf.  A person should not have to discover a right-click to
/// change the companion, close behaviour, or voice controls.
struct IslandControlsView: View {
    @ObservedObject var buddy: Buddy
    @ObservedObject var bridge: OxBridge
    @AppStorage("island.size") private var islandSize = "standard"
    @AppStorage("island.autoClose") private var autoClose = 6.0
    @AppStorage("island.hideFullscreen") private var hideFullscreen = true
    @AppStorage("wake.enabled") private var wakeOn = false
    @AppStorage("pet.kind") private var petKind = "none"

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "slider.horizontal.3").font(.system(size: 10)).foregroundStyle(Ink.muted)
                Text("Island controls").font(.system(size: 12, weight: .semibold)).foregroundStyle(Ink.text)
                Spacer()
                Text("changes save here").font(.system(size: 10)).foregroundStyle(Ink.dim)
            }
            HStack(spacing: 12) {
                AvatarView(kind: buddy.character, expression: Expression.of(bridge.headlineMood, buddy: buddy.phase), mouth: buddy.mouth, gesture: buddy.gesture, level: buddy.level)
                    .frame(width: 44, height: 52)
                VStack(alignment: .leading, spacing: 5) {
                    Picker("Companion", selection: $buddy.character) {
                        ForEach(AvatarKind.allCases) { Text($0.title).tag($0) }
                    }
                    .labelsHidden().frame(width: 140)
                    Text("Your on-device voice companion").font(.system(size: 10.5)).foregroundStyle(Ink.muted)
                }
                Divider().frame(height: 42)
                VStack(alignment: .leading, spacing: 4) {
                    Picker("Close", selection: $autoClose) {
                        Text("Close in 3s").tag(3.0)
                        Text("Close in 6s").tag(6.0)
                        Text("Close in 15s").tag(15.0)
                        Text("Stay open").tag(0.0)
                    }.labelsHidden().frame(width: 128)
                    Toggle("Hide in full screen", isOn: $hideFullscreen).font(.system(size: 10.5)).toggleStyle(.checkbox)
                }
                Spacer(minLength: 0)
                VStack(alignment: .trailing, spacing: 4) {
                    Button(buddy.isListeningOrStarting ? "Stop voice" : "Talk") { buddy.toggle() }
                    Button(wakeOn ? "Wake word on" : "Wake word off") { wakeOn.toggle(); bridge.wake.setEnabled(wakeOn) }
                }.font(.system(size: 10.5, weight: .semibold))
            }
            Text("The Island closes after you leave unless you are typing, speaking, or an agent needs an approval. Mail opens safely in Mail; replies stay drafts until you send them.")
                .font(.system(size: 10)).foregroundStyle(Ink.dim).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Text("Island pet").font(.system(size: 10.5, weight: .semibold)).foregroundStyle(Ink.muted)
                Picker("Island pet", selection: $petKind) {
                    ForEach(IslandPetKind.allCases) { Text($0.title).tag($0.rawValue) }
                }
                .labelsHidden().frame(width: 150)
                Text("Original Blender animal companions").font(.system(size: 10)).foregroundStyle(Ink.dim)
            }
        }
    }
}

/// One selected pet, with the same idle and mood animation frames used by the
/// working-session animal cast. It is intentionally small: status and
/// approvals remain readable in the notch.
struct IslandPet: View {
    let kind: IslandPetKind
    let mood: Mood
    let height: CGFloat

    var body: some View {
        TimelineView(.animation(minimumInterval: Energy.interval(12, active: true))) { context in
            let frames = Frames.load("friends/\(kind.rawValue)/\(SessionCharacter.cycle(mood, t: context.date.timeIntervalSinceReferenceDate))")
            let fallback = frames.isEmpty ? Frames.load("friends/\(kind.rawValue)/idle") : frames
            if let image = fallback.isEmpty ? nil : fallback[Int(context.date.timeIntervalSinceReferenceDate * 12) % fallback.count] {
                Image(nsImage: image).resizable().interpolation(.high).aspectRatio(4 / 3, contentMode: .fit)
                    .frame(height: height).accessibilityLabel("\(kind.title), Island pet")
            }
        }
        .frame(width: height * 4 / 3, height: height)
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

    /// The same rule and the same file as `ox name` (src/identity.js).
    @discardableResult
    static func set(_ raw: String) -> Bool {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let reset = t.isEmpty || t.lowercased() == "ox"
        guard reset || t.range(of: #"^[A-Za-z0-9][A-Za-z0-9 .'-]{0,23}$"#, options: .regularExpression) != nil else { return false }
        var doc: [String: Any] = [:]
        if let data = try? Data(contentsOf: IslandSwitch.config), let d = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { doc = d }
        if reset { doc.removeValue(forKey: "name") } else { doc["name"] = t }
        try? FileManager.default.createDirectory(at: IslandSwitch.config.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let out = try? JSONSerialization.data(withJSONObject: doc, options: [.prettyPrinted, .sortedKeys]) else { return false }
        return (try? (out + Data("\n".utf8)).write(to: IslandSwitch.config, options: .atomic)) != nil
    }

    /// Asked in a small window from the island's menu.
    @MainActor static func askRename() {
        let alert = NSAlert()
        alert.messageText = "Rename \(current)"
        alert.informativeText = "What should it be called? It answers to this name (\"\(current), play some music\") everywhere: the island, the app and the terminal."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
        field.stringValue = current
        alert.accessoryView = field
        alert.addButton(withTitle: "Rename")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        alert.window.initialFirstResponder = field
        if alert.runModal() == .alertFirstButtonReturn, !set(field.stringValue) {
            let bad = NSAlert(); bad.messageText = "That name can't be used"; bad.informativeText = "Up to 24 letters, digits, spaces, dots, dashes or apostrophes, starting with a letter or digit."; bad.runModal()
        }
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
