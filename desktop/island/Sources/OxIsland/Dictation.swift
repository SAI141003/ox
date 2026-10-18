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

    private let recognizer = SFSpeechRecognizer()
    private let audio = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var finalHeard = false

    static var enabled: Bool { UserDefaults.standard.object(forKey: "dictation.enabled") as? Bool ?? true }
    /// Called before the microphone is taken, and after it is given back.
    var willListen: () -> Void = {}
    var didFinish: () -> Void = {}

    func install() {
        BuddyHotKey.register(id: 2, keyCode: kVK_ANSI_D, modifiers: controlKey | optionKey,
                             press: { [weak self] in MainActor.assumeIsolated { self?.start() } },
                             release: { [weak self] in MainActor.assumeIsolated { self?.stop() } })
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
        request = req
        let input = audio.inputNode
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buf, _ in req.append(buf) }
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
    private func paste(_ text: String) {
        if Paster.paste(text) { phase = .idle; lastPasted = text }
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
