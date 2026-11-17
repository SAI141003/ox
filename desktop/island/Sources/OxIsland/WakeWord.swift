import AVFoundation
import Foundation
import Speech

// « OK ox »: say it, then what you want ("OK ox, make the island smaller",
// "hey ox, what is this video about"). Off by default (island menu). Listening
// is on-device only: nothing leaves the Mac until you have said the words, and
// then only your words, never audio. It steps aside while you dictate, talk to
// the buddy or record call notes, so the microphone is never shared.
@MainActor
final class WakeWord: ObservableObject {
    @Published private(set) var listening = false
    /// What was asked after « OK ox », handed to the buddy (the same path as ⌃⌥Space).
    var onCommand: ((String) -> Void)?
    /// True while something else has the microphone.
    var micBusy: () -> Bool = { false }

    private let recognizer = SFSpeechRecognizer()
    private var audio = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var restartTimer: Timer?
    private var idle: DispatchWorkItem?
    private var command = ""

    /// Voice control: every sentence is a command, with no name first and no key
    /// held ("open Claude", "new chat", "type …", "send"). Off by default. On from
    /// the island menu or by saying « OK ox, voice control on »; « stop listening » ends it.
    /// Each sentence goes to ox's no-AI commands only: one that is not a command is
    /// dropped, never sent to a model, so talk in the room costs nothing and does nothing.
    var onControl: ((String) -> Void)?
    /// What was last heard, or what came of it: shown beside the ear for a few seconds.
    @Published private(set) var status = ""
    private var statusClear: DispatchWorkItem?
    static var control: Bool { UserDefaults.standard.bool(forKey: "voice.control") }

    func setControl(_ on: Bool) {
        UserDefaults.standard.set(on, forKey: "voice.control")
        note(on ? "Voice control on: say “new chat”, “type …”, “send”" : "Voice control off")
        if on { stop(); start() } else if !Self.enabled { stop() } else { restart() }
    }

    func note(_ text: String) {
        status = text
        statusClear?.cancel()
        let clear = DispatchWorkItem { [weak self] in self?.status = "" }
        statusClear = clear
        DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: clear)
    }

    static var enabled: Bool { UserDefaults.standard.bool(forKey: "wake.enabled") }
    /// « OK ox », « hey Pixie », or the name on its own when it is long
    /// enough not to be heard by accident (four letters or more: "Pixie, …").
    static var phrase: NSRegularExpression {
        // "ox" is one short sound: Apple's recognizer writes it as "box", "ax",
        // "oaks"… A short name still needs "ok / hey / hi" in front, so these
        // sound-alikes do not fire on ordinary speech.
        let alike: [String: String] = ["ox": "(?:ox|oks|ocks|oaks|ax|aux|box|x)"]
        let name = alike[OxName.current.lowercased()] ?? NSRegularExpression.escapedPattern(for: OxName.current)
        let lead = OxName.current.count >= 4 ? #"(?:(?:ok(?:ay)?|hey|hi)[\s,]+)?"# : #"(?:ok(?:ay)?|hey|hi)[\s,]+"#
        return try! NSRegularExpression(pattern: #"\b"# + lead + name + #"\b[\s,.:!]*"#, options: [.caseInsensitive])
    }

    func setEnabled(_ on: Bool) {
        UserDefaults.standard.set(on, forKey: "wake.enabled")
        on ? start() : stop()
    }

    func start() {
        guard Self.enabled || Self.control, !listening, !micBusy(), VoicePermission.described else { return }
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async { if status == .authorized { self.begin() } }
        }
    }

    private func begin() {
        guard let recognizer, recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else { return }
        audio = AVAudioEngine()
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = true
        // Tell the recognizer what to listen for, so the name is written as the name.
        req.contextualStrings = ["OK \(OxName.current)", "hey \(OxName.current)", "hi \(OxName.current)", OxName.current] + (Self.control ? VoiceControlWords.hints : [])
        request = req
        let input = audio.inputNode
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buf, _ in req.append(buf) }
        command = ""
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString ?? ""
            DispatchQueue.main.async {
                guard let self else { return }
                if !text.isEmpty { self.heard(text) }
                if error != nil || result?.isFinal == true { self.restart() }
            }
        }
        do { audio.prepare(); try audio.start(); listening = true } catch { listening = false; return }
        // Apple caps one request at about a minute: start a fresh one before that.
        restartTimer?.invalidate()
        restartTimer = Timer.scheduledTimer(withTimeInterval: 50, repeats: false) { [weak self] _ in DispatchQueue.main.async { self?.restart() } }
    }

    /// Voice control: the sentence is the command. It is done when the words stop.
    private func heardControl(_ text: String) {
        let ns = text as NSString
        // Called by name inside voice control ("OK ox, what is on my screen"): that one is a question for ox.
        let named = Self.phrase.matches(in: text, range: NSRange(location: 0, length: ns.length)).last
        command = (named.map { ns.substring(from: $0.range.location + $0.range.length) } ?? text).trimmingCharacters(in: .whitespacesAndNewlines)
        idle?.cancel()
        guard !command.isEmpty else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            let c = self.command.trimmingCharacters(in: CharacterSet(charactersIn: " ,.!?"))
            guard !c.isEmpty else { return }
            // A fresh request, so the next sentence does not carry this one in front of it.
            self.stop()
            if VoiceControlWords.turnsOff(c) { self.setControl(false); return }
            if named != nil, !VoiceControlWords.isCommand(c) { self.onCommand?(c); DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in self?.start() }; return }
            self.note("“\(c.prefix(48))”")
            self.onControl?(c)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.start() }
        }
        idle = work
        // Longer than the wake word's pause: "type …" is a whole sentence, with breaths in it.
        DispatchQueue.main.asyncAfter(deadline: .now() + (VoiceControlWords.isTyping(command) ? 1.5 : 0.9), execute: work)
    }

    private func heard(_ text: String) {
        if Self.control { heardControl(text); return }
        let ns = text as NSString
        guard let m = Self.phrase.matches(in: text, range: NSRange(location: 0, length: ns.length)).last else { return }
        command = ns.substring(from: m.range.location + m.range.length).trimmingCharacters(in: .whitespacesAndNewlines)
        idle?.cancel()
        if command.isEmpty {
            // Only the name so far. The request has to follow within a few seconds:
            // otherwise the name is let go. Left in the transcript, whatever was said
            // next in the room (up to a minute later) was taken as a request to ox.
            let forget = DispatchWorkItem { [weak self] in
                guard let self, self.command.isEmpty else { return }
                self.restart()
            }
            idle = forget
            DispatchQueue.main.asyncAfter(deadline: .now() + 6, execute: forget)
            return
        }
        // The request is done when the words stop for a moment.
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            let c = self.command.trimmingCharacters(in: CharacterSet(charactersIn: " ,.!?"))
            guard !c.isEmpty else { return }
            self.stop()
            // « OK ox, voice control on »: from here every sentence is a command.
            if VoiceControlWords.turnsOn(c) { self.setControl(true); return }
            self.onCommand?(c)
            // Listen again once the answer has had its turn.
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in self?.start() }
        }
        idle = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.4, execute: work)
    }

    func stop() {
        restartTimer?.invalidate(); restartTimer = nil
        idle?.cancel(); idle = nil
        task?.cancel(); task = nil
        request?.endAudio(); request = nil
        if audio.isRunning { audio.stop() }
        audio.inputNode.removeTap(onBus: 0)
        listening = false
    }

    private func restart() {
        guard listening || Self.enabled || Self.control else { return }
        stop()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.start() }
    }
}

/// The words that turn voice control on and off, and what a sentence in it is.
/// Kept apart from the microphone so they can be checked with no audio.
enum VoiceControlWords {
    /// Said to the recognizer so short commands are written as commands ("new chat", not "nude chat").
    static let hints = ["new chat", "new tab", "close tab", "type", "send", "enter", "go back", "scroll down", "scroll up", "select all", "copy", "paste", "undo", "stop listening", "open Claude", "open ChatGPT", "open Codex", "open Cursor", "open Chrome"]

    private static func matches(_ pattern: String, _ text: String) -> Bool {
        text.trimmingCharacters(in: CharacterSet(charactersIn: " ,.!?")).range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }
    static func turnsOn(_ text: String) -> Bool {
        matches(#"^(?:(?:turn on|start|enable|begin) (?:voice|hands[- ]?free) (?:control|mode|commands?)|(?:voice|hands[- ]?free) (?:control|mode|commands?) on|turn (?:voice|hands[- ]?free) (?:control|mode|commands?) on|listen (?:to me|for commands))$"#, text)
    }
    static func turnsOff(_ text: String) -> Bool {
        matches(#"^(?:stop listening|(?:turn off|stop|end|disable|exit) (?:voice|hands[- ]?free) (?:control|mode|commands?)|(?:voice|hands[- ]?free) (?:control|mode|commands?) off|turn (?:voice|hands[- ]?free) (?:control|mode|commands?) off|that(?:'s| is) all|go to sleep)$"#, text)
    }
    /// "type …" is dictation: it gets a longer pause before it counts as finished.
    static func isTyping(_ text: String) -> Bool { matches(#"^(?:type|type in|enter text)\b"#, text) }
    /// Starts like one of ox's own commands (after its name): done here, not asked of a model.
    static func isCommand(_ text: String) -> Bool {
        matches(#"^(?:open|launch|switch to|go to|new|close|type|press|hit|click|tap|send|enter|submit|scroll|select|copy|paste|cut|undo|go back|go forward|refresh|reload|zoom|minimi[sz]e|full ?screen|hide|save|clear|delete|search|google|play|pause|volume|mute|next|previous)\b"#, text)
    }
}
