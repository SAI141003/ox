import AppKit
import AVFoundation
import Carbon.HIToolbox
import Speech

// Dictation anywhere (Coucou's Flow): hold ⌃⌥D, speak, let go, and your words
// are pasted where you type. On-device recognition; your personal dictionary
// (~/.ox/dictionary.json: replacements and snippets, `ox dictionary`) applies.
// Pasting needs the Accessibility permission once; without it the words stay
// on the clipboard and the island says so. The clipboard gets back what it held.
@MainActor
final class Dictation: ObservableObject {
    enum Phase: Equatable { case idle, listening, message(String) }
    @Published var phase: Phase = .idle
    @Published var heard = ""
    /// Loudness 0…1 while listening, for the pill's bars.
    @Published var level: Double = 0

    private let recognizer = SFSpeechRecognizer()
    private let audio = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var finalHeard = false

    static var enabled: Bool { UserDefaults.standard.object(forKey: "dictation.enabled") as? Bool ?? true }
    /// Called before the microphone is taken, and after it is given back.
    var willListen: () -> Void = {}
    var didFinish: () -> Void = {}

    // Coucou's Flow controls: hold to talk; tap twice quickly to keep listening
    // hands-free until the next tap; Esc cancels (nothing is pasted); ⌃⌥V
    // pastes the last dictation again.
    @Published private(set) var handsFree = false
    private var pressedAt = Date.distantPast
    private var lastTapEnd = Date.distantPast
    private var escMonitor: Any?

    func install() {
        BuddyHotKey.register(id: 2, keyCode: kVK_ANSI_D, modifiers: controlKey | optionKey,
                             press: { [weak self] in MainActor.assumeIsolated { self?.keyDown() } },
                             release: { [weak self] in MainActor.assumeIsolated { self?.keyUp() } })
        BuddyHotKey.register(id: 3, keyCode: kVK_ANSI_V, modifiers: controlKey | optionKey,
                             press: { [weak self] in MainActor.assumeIsolated { self?.pasteLast() } }, release: {})
        escMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] e in
            guard e.keyCode == 53 else { return }
            MainActor.assumeIsolated { self?.cancel() }
        }
    }

    private func keyDown() {
        if handsFree { handsFree = false; stop(); return }        // the tap that ends hands-free
        let quickSecond = Date().timeIntervalSince(lastTapEnd) < 0.45
        pressedAt = Date()
        if phase == .listening, quickSecond { handsFree = true; say("Hands-free: tap ⌃⌥D to finish, Esc to cancel."); phase = .listening; return }
        start()
    }

    private func keyUp() {
        let held = Date().timeIntervalSince(pressedAt)
        if handsFree { return }
        if held < 0.3 {
            // A quick tap: wait a moment for a second tap (hands-free) before finishing.
            lastTapEnd = Date()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                guard let self, !self.handsFree, self.phase == .listening, Date().timeIntervalSince(self.lastTapEnd) >= 0.45 else { return }
                self.stop()
            }
            return
        }
        stop()
    }

    /// Esc while listening: drop it, paste nothing.
    func cancel() {
        guard phase == .listening else { return }
        handsFree = false
        audio.stop()
        audio.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel(); task = nil; request = nil
        heard = ""
        say("Cancelled.")
        didFinish()
    }

    /// ⌃⌥V: the last dictation, pasted again.
    func pasteLast() {
        guard let t = lastPasted, !t.isEmpty else { say("Nothing dictated yet."); return }
        if !Paster.paste(t) { say("Copied the last dictation: press ⌘V.") }
    }

    func start() {
        guard Self.enabled, phase != .listening else { return }
        guard VoicePermission.described else { say(VoicePermission.howToFix); return }
        willListen()
        heard = ""
        finalHeard = false
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard status == .authorized else { self.say("Allow Speech Recognition for OX Island in System Settings › Privacy & Security."); return }
                self.begin()
            }
        }
    }

    private func begin() {
        guard let recognizer, recognizer.isAvailable else { say("Speech recognition is not available right now."); return }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.addsPunctuation = true
        req.taskHint = .dictation
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        // Code-aware: your project's names and your dictionary bias the recognizer (on device).
        let words = Self.contextWords
        if !words.isEmpty { req.contextualStrings = words }
        Self.refreshContextWords()
        request = req
        let input = audio.inputNode
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { [weak self] buf, _ in
            req.append(buf)
            // RMS of the first channel → the pill's voice bars.
            if let ch = buf.floatChannelData?[0] {
                let n = Int(buf.frameLength); var sum: Float = 0
                for i in 0..<n { sum += ch[i] * ch[i] }
                let rms = n > 0 ? sqrt(sum / Float(n)) : 0
                DispatchQueue.main.async { self?.level = min(1, Double(rms) * 14) }
            }
        }
        task = recognizer.recognitionTask(with: req) { [weak self] result, _ in
            guard let result else { return }
            let text = result.bestTranscription.formattedString
            let final = result.isFinal
            DispatchQueue.main.async { self?.heard = text; if final { self?.finalHeard = true } }
        }
        do { audio.prepare(); try audio.start(); phase = .listening }
        catch { say("The microphone could not start: \(error.localizedDescription)") }
    }

    func stop() {
        guard phase == .listening else { return }
        audio.stop()
        audio.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        waitForFinal(until: Date().addingTimeInterval(1.2)) { [weak self] in
            guard let self else { return }
            self.task?.finish(); self.task = nil; self.request = nil
            let raw = self.heard.trimmingCharacters(in: .whitespacesAndNewlines)
            defer { self.didFinish() }
            guard !raw.isEmpty else { self.say("I didn't catch that."); return }
            self.paste(PersonalDictionary.apply(raw))
        }
    }

    private func waitForFinal(until: Date, then: @escaping () -> Void) {
        if finalHeard || Date() >= until { then(); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in self?.waitForFinal(until: until, then: then) }
    }

    /// Put the words where the person types: ⌘V into the front app, then the
    /// clipboard gets back what it held.
    /// The app's server, for styles and translation (set by the bridge when it finds it).
    nonisolated(unsafe) static var serverPort: Int?

    /// Words for the recognizer for the app in front (src/dictation-words.js), fetched ahead of time.
    nonisolated(unsafe) static var contextWords: [String] = []
    nonisolated(unsafe) private static var watchingApps = false
    nonisolated static func refreshContextWords() {
        if !watchingApps {
            watchingApps = true
            NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { _ in refreshContextWords() }
        }
        guard let port = serverPort else { return }
        let app = NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
        var comps = URLComponents(string: "http://127.0.0.1:\(port)/ox/dictation/words")
        comps?.queryItems = [URLQueryItem(name: "app", value: app)]
        guard let url = comps?.url else { return }
        var req = URLRequest(url: url)
        req.timeoutInterval = 5
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            guard (resp as? HTTPURLResponse)?.statusCode == 200,
                  let doc = data.flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }),
                  let words = doc["words"] as? [String] else { return }
            DispatchQueue.main.async { contextWords = Array(words.prefix(100)) }
        }.resume()
    }

    private func paste(_ text: String) {
        let app = NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
        // A style or a language for this app (ox dictation style … / translate …): one small model call first.
        guard let port = Self.serverPort, let url = URL(string: "http://127.0.0.1:\(port)/ox/dictation/style") else { pasteNow(text, app: app); return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 12
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["text": text, "app": app])
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            let doc = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let out = (doc?["text"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? text
            // A constant, not the captured weak var: older compilers (CI's macOS 14) refuse the var here.
            let owner = self
            DispatchQueue.main.async { MainActor.assumeIsolated { owner?.pasteNow(out, app: app) } }
        }.resume()
    }

    private func pasteNow(_ text: String, app: String) {
        let seconds = max(0.5, Date().timeIntervalSince(pressedAt))
        DictationStats.record(words: text.split(whereSeparator: { $0.isWhitespace }).count, seconds: seconds, app: app)
        if Paster.paste(text) {
            lastPasted = text
            let today = DictationStats.today()
            say("Pasted. Today: \(today.words) words, about \(today.savedMinutes) min saved.")
        }
        else { lastPasted = text; say("Copied: “\(text.prefix(60))”. Allow Accessibility for OX Island to paste it for you.") }
    }

    /// The last dictation, to paste again.
    private(set) var lastPasted: String?

    private func say(_ m: String) {
        // A start that failed still gives the microphone back (« OK ox » listens again).
        if phase != .listening, request == nil { didFinish() }
        phase = .message(m)
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in if case .message = self?.phase { self?.phase = .idle } }
    }
}

/// macOS kills an app that asks for the microphone or speech recognition
/// without saying why in its Info.plist (a TCC "privacy violation"): that is
/// what happened when the bare binary ran outside OX Island.app. Every
/// listener checks this first and says what to do instead of crashing.
enum VoicePermission {
    static var described: Bool {
        let info = Bundle.main.infoDictionary ?? [:]
        return info["NSMicrophoneUsageDescription"] != nil && info["NSSpeechRecognitionUsageDescription"] != nil
    }
    static let howToFix = "Voice needs OX Island.app (run  ox island start ), not the bare binary."
}

/// Coucou's Flow statistics, kept on this Mac (~/.ox/dictation-stats.jsonl):
/// words, how fast you spoke, and the time saved against typing at 40 wpm.
enum DictationStats {
    static var file: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ox/dictation-stats.jsonl") }
    struct Summary { let words: Int; let sessions: Int; let wpm: Int; let savedMinutes: Int; let apps: [(String, Int)] }

    static func record(words: Int, seconds: Double, app: String) {
        guard words > 0 else { return }
        let row: [String: Any] = ["at": Int(Date().timeIntervalSince1970), "words": words, "seconds": (seconds * 10).rounded() / 10, "app": app]
        guard let d = try? JSONSerialization.data(withJSONObject: row), let line = String(data: d, encoding: .utf8).map({ $0 + "\n" }) else { return }
        if let h = try? FileHandle(forWritingTo: file) { h.seekToEndOfFile(); h.write(Data(line.utf8)); try? h.close() }
        else { try? Data(line.utf8).write(to: file) }
    }

    static func summary(since: Date) -> Summary {
        let rows = ((try? String(contentsOf: file, encoding: .utf8)) ?? "").split(separator: "\n").compactMap { l -> [String: Any]? in
            (try? JSONSerialization.jsonObject(with: Data(l.utf8))) as? [String: Any]
        }.filter { (($0["at"] as? Double) ?? 0) >= since.timeIntervalSince1970 }
        let words = rows.reduce(0) { $0 + (($1["words"] as? Int) ?? 0) }
        let secs = rows.reduce(0.0) { $0 + (($1["seconds"] as? Double) ?? 0) }
        var apps: [String: Int] = [:]
        for r in rows { if let a = r["app"] as? String, !a.isEmpty { apps[a, default: 0] += (r["words"] as? Int) ?? 0 } }
        let typing = Double(words) / 40.0 * 60.0           // seconds it would take at 40 wpm
        return Summary(words: words, sessions: rows.count, wpm: secs > 0 ? Int(Double(words) / (secs / 60)) : 0,
                       savedMinutes: max(0, Int((typing - secs) / 60)), apps: apps.sorted { $0.value > $1.value }.prefix(3).map { ($0.key, $0.value) })
    }
    static func today() -> Summary { summary(since: Calendar.current.startOfDay(for: Date())) }
    static func week() -> Summary { summary(since: Date().addingTimeInterval(-7 * 86400)) }
}

/// Text into whatever app you are typing in: ⌘V, then the clipboard gets back
/// what it held. Never presses Return: sending is always yours.
enum Paster {
    /// False without the Accessibility permission (the text is then left on the clipboard).
    @discardableResult
    static func paste(_ text: String) -> Bool {
        let pb = NSPasteboard.general
        let previous = pb.string(forType: .string)
        pb.clearContents()
        pb.setString(text, forType: .string)
        let trusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        guard trusted else { return false }
        let src = CGEventSource(stateID: .combinedSessionState)
        let v = CGKeyCode(kVK_ANSI_V)
        let down = CGEvent(keyboardEventSource: src, virtualKey: v, keyDown: true); down?.flags = .maskCommand
        let up = CGEvent(keyboardEventSource: src, virtualKey: v, keyDown: false); up?.flags = .maskCommand
        down?.post(tap: .cghidEventTap); up?.post(tap: .cghidEventTap)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            if let previous { pb.clearContents(); pb.setString(previous, forType: .string) }
        }
        return true
    }
}

/// ~/.ox/dictionary.json, the same rules as src/dictionary.js.
enum PersonalDictionary {
    static var file: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ox/dictionary.json") }

    static func load() -> (replace: [String: String], snippets: [String: String]) {
        guard let data = try? Data(contentsOf: file), let doc = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return ([:], [:]) }
        return ((doc["replace"] as? [String: String]) ?? [:], (doc["snippets"] as? [String: String]) ?? [:])
    }

    /// The file, created with an example the first time it is opened.
    static func ensureFile() -> URL {
        if !FileManager.default.fileExists(atPath: file.path) {
            try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            let example = "{\n  \"replace\": { \"cloud code\": \"Claude Code\", \"ox island\": \"OX Island\" },\n  \"snippets\": { \"my email\": \"you@example.com\" }\n}\n"
            try? example.write(to: file, atomically: true, encoding: .utf8)
        }
        return file
    }

    static func norm(_ s: String) -> String {
        s.lowercased().unicodeScalars.filter { CharacterSet.letters.contains($0) || CharacterSet.decimalDigits.contains($0) || CharacterSet.whitespaces.contains($0) }
            .map(String.init).joined().split(separator: " ").joined(separator: " ")
    }

    static func apply(_ text: String) -> String {
        let d = load()
        if let snip = d.snippets.first(where: { !norm($0.key).isEmpty && norm($0.key) == norm(text) }) { return snip.value }
        var out = text
        for (from, to) in d.replace.sorted(by: { $0.key.count > $1.key.count }) {
            let f = from.trimmingCharacters(in: .whitespaces)
            guard !f.isEmpty else { continue }
            let pattern = "(?<![\\p{L}\\p{N}])" + NSRegularExpression.escapedPattern(for: f) + "(?![\\p{L}\\p{N}])"
            guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { continue }
            out = re.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out), withTemplate: NSRegularExpression.escapedTemplate(for: to))
        }
        return out
    }
}
