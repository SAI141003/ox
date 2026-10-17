import AppKit
import AVFoundation
import Carbon.HIToolbox
import Speech
import SwiftUI

// OX Buddy: talk to ox instead of typing, about what is on your screen.
//
// Hold ⌃⌥Space (or click the mic): the island listens with on-device speech
// recognition and grabs a screenshot the moment you start. Releasing sends
// both to the live ox run (IPC `user-message`, src/buddy.js). The reply is
// spoken by your avatar, lips and hands moving with the words, and when the
// answer names a place on screen ([POINT:x,y:label]) a pointer flies there.

/// Mouth shapes, picked from the letters of the word being spoken.
enum Viseme: Equatable {
    case rest, closed, open, wide, round, teeth, small

    static func of(_ ch: Character) -> Viseme {
        switch ch.lowercased().first ?? " " {
        case "a", "i", "h": return .open
        case "e", "y": return .wide
        case "o", "u", "w", "q": return .round
        case "m", "b", "p": return .closed
        case "f", "v": return .teeth
        case "l", "t", "d", "n", "s", "z", "c", "k", "g", "r", "j", "x": return .small
        default: return .rest
        }
    }
}

enum Gesture: Equatable { case rest, beat(Int), open, point, wave, think }

/// The Buddy: the vector Ox, or one of the pixel cast (PixelPeople.swift).
enum AvatarKind: String, CaseIterable, Identifiable {
    case ox, mira, theo, ade, lin, sol, rui
    var id: String { rawValue }
    var title: String { self == .ox ? "Ox" : rawValue.capitalized }
}

@MainActor
final class Buddy: NSObject, ObservableObject {
    enum Phase: Equatable { case idle, listening, thinking, speaking, message(String) }

    @Published var phase: Phase = .idle
    @Published var heard = ""
    @Published var saying = ""
    @Published var mouth: Viseme = .rest
    @Published var level: Double = 0
    @Published var gesture: Gesture = .rest
    @Published var character: AvatarKind {
        didSet { UserDefaults.standard.set(character.rawValue, forKey: "buddy.character") }
    }

    /// Sends a question to a live ox run; false when none is running.
    /// Sends (text, screenshots, recording) to the live ox run; false when none is running.
    var send: ((String, [String], String?) -> Bool)?
    /// The question as audio, for whisper on the ox side (src/dictation.js).
    private var recording: AVAudioFile?
    private var recordingURL: URL?
    private var finalHeard = false

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let audio = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let synth = AVSpeechSynthesizer()
    private var shot: String?
    private var mouthWork: [DispatchWorkItem] = []
    private var wordCount = 0
    private var pendingPoint: ScreenPoint?
    private var pointer: PointerOverlay?

    var active: Bool { phase != .idle }

    override init() {
        character = AvatarKind(rawValue: UserDefaults.standard.string(forKey: "buddy.character") ?? "") ?? .ox
        super.init()
        synth.delegate = self
    }

    // MARK: listening

    func toggle() { phase == .listening ? stopListening() : startListening() }

    func startListening() {
        guard phase != .listening else { return }
        synth.stopSpeaking(at: .immediate)
        heard = ""
        saying = ""
        shot = Self.captureScreen()
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard status == .authorized else {
                    self.show("Allow Speech Recognition for OX Island in System Settings › Privacy & Security.")
                    return
                }
                AVCaptureDevice.requestAccess(for: .audio) { ok in
                    DispatchQueue.main.async {
                        if ok { self.beginAudio() } else { self.show("Allow the microphone for OX Island in System Settings › Privacy & Security.") }
                    }
                }
            }
        }
    }

    private func beginAudio() {
        guard let recognizer, recognizer.isAvailable else { show("Speech recognition is not available right now."); return }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        // Dictation quality: punctuation, the dictation model, on-device when possible.
        req.addsPunctuation = true
        req.taskHint = .dictation
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        request = req
        finalHeard = false
        let input = audio.inputNode
        let format = input.outputFormat(forBus: 0)
        // Keep the audio too: whisper on the ox side hears more than the live preview.
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("ox-voice-\(Int(Date().timeIntervalSince1970 * 1000)).caf")
        recording = try? AVAudioFile(forWriting: url, settings: format.settings)
        recordingURL = recording == nil ? nil : url
        let file = recording
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buf, _ in
            req.append(buf)
            try? file?.write(from: buf)
            guard let ch = buf.floatChannelData?[0] else { return }
            let n = Int(buf.frameLength)
            var sum: Float = 0
            for i in 0..<n { sum += ch[i] * ch[i] }
            let rms = Double(sqrt(sum / Float(max(n, 1))))
            DispatchQueue.main.async { self?.level = min(1, rms * 12) }
        }
        task = recognizer.recognitionTask(with: req) { [weak self] result, _ in
            guard let result else { return }
            let text = result.bestTranscription.formattedString
            let final = result.isFinal
            DispatchQueue.main.async {
                self?.heard = text
                if final { self?.finalHeard = true }
            }
        }
        do {
            audio.prepare()
            try audio.start()
            phase = .listening
            gesture = .rest
        } catch {
            show("The microphone could not start: \(error.localizedDescription)")
        }
    }

    func stopListening() {
        guard phase == .listening else { return }
        audio.stop()
        audio.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        level = 0
        recording = nil   // closes the file
        let audioPath = recordingURL?.path
        // Wait for the recognizer's FINAL result (the last word included), at most 1.5 s.
        waitForFinal(deadline: Date().addingTimeInterval(1.5)) { [weak self] in
            guard let self else { return }
            self.task?.finish()
            self.task = nil
            self.request = nil
            let text = self.heard.trimmingCharacters(in: .whitespacesAndNewlines)
            // Nothing heard live, but there is audio: whisper may still hear it.
            guard !text.isEmpty || audioPath != nil else { self.show("I didn't catch that. Hold ⌃⌥Space and talk."); return }
            guard self.send?(text, self.shot.map { [$0] } ?? [], audioPath) == true else {
                self.show("Start ox in a terminal, then ask me again.")
                return
            }
            self.phase = .thinking
            self.gesture = .think
        }
    }

    private func waitForFinal(deadline: Date, then: @escaping () -> Void) {
        if finalHeard || Date() >= deadline { then(); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in self?.waitForFinal(deadline: deadline, then: then) }
    }

    // MARK: speaking

    /// Speak an agent reply; a [POINT:x,y:label] in it flies the pointer.
    /// The voice is ox's natural one (Kokoro, through `ox speak`); the system
    /// voice is only the fallback when ox cannot make the recording.
    func speak(_ reply: String) {
        let (say, point) = Self.parsePoint(reply)
        let text = say.isEmpty ? "Done." : say
        saying = text
        pendingPoint = point
        wordCount = 0
        phase = .speaking
        gesture = point != nil ? .point : .open
        if let point { showPointer(point) }
        let spoken = Self.speakable(text)
        guard Self.naturalVoice, OxRunner.available else { systemSpeak(spoken); return }
        let out = (NSTemporaryDirectory() as NSString).appendingPathComponent("ox-buddy-say-\(Int(Date().timeIntervalSince1970 * 1000)).wav")
        let token = UUID()
        speakToken = token
        OxRunner.run(["speak", spoken, "--out", out], cwd: FileManager.default.homeDirectoryForCurrentUser) { [weak self] code, _ in
            guard let self, self.speakToken == token, self.phase == .speaking else { try? FileManager.default.removeItem(atPath: out); return }
            if code == 0, let p = try? AVAudioPlayer(contentsOf: URL(fileURLWithPath: out)) {
                self.playRecording(p, file: out)
            } else {
                self.systemSpeak(spoken)
            }
        }
    }

    /// Kokoro on (the default) or the system voice, from the island's settings.
    static var naturalVoice: Bool {
        UserDefaults.standard.object(forKey: "buddy.naturalVoice") as? Bool ?? true
    }

    private var speakToken: UUID?
    private var player: AVAudioPlayer?
    private var playerFile: String?
    private var meter: Timer?

    private func systemSpeak(_ text: String) {
        let u = AVSpeechUtterance(string: text)
        u.voice = Self.bestVoice
        u.rate = 0.5
        u.pitchMultiplier = character == .ox ? 0.85 : 1.0
        synth.speak(u)
    }

    /// Plays ox's recording; the mouth follows the loudness of the voice itself.
    private func playRecording(_ p: AVAudioPlayer, file: String) {
        player = p
        playerFile = file
        p.isMeteringEnabled = true
        p.delegate = self
        p.play()
        var tick = 0
        meter = Timer.scheduledTimer(withTimeInterval: 0.06, repeats: true) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, let p = self.player, p.isPlaying else { return }
                p.updateMeters()
                let amp = pow(10, Double(p.averagePower(forChannel: 0)) / 20)
                tick += 1
                self.level = min(1, amp * 3)
                self.mouth = amp < 0.02 ? .rest : amp < 0.06 ? .closed : amp < 0.12 ? .small : [Viseme.open, .wide, .round][tick % 3]
                if self.pendingPoint == nil, tick % 8 == 0 { self.gesture = .beat(tick / 8) }
            }
        }
    }

    private func stopRecording() {
        meter?.invalidate(); meter = nil
        player?.stop(); player = nil
        if let f = playerFile { try? FileManager.default.removeItem(atPath: f) }
        playerFile = nil
        level = 0
    }

    func stopSpeaking() {
        speakToken = nil
        synth.stopSpeaking(at: .immediate)
        stopRecording()
        finishSpeaking()
    }

    private func finishSpeaking() {
        mouthWork.forEach { $0.cancel() }
        mouthWork = []
        mouth = .rest
        gesture = .rest
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            if self?.phase == .speaking { self?.phase = .idle }
        }
    }

    /// Animate the mouth through one word, ~55 ms per letter at rate 0.5.
    fileprivate func mouthWord(_ word: String) {
        mouthWork.forEach { $0.cancel() }
        mouthWork = []
        wordCount += 1
        if pendingPoint == nil { gesture = wordCount % 3 == 0 ? .beat(wordCount) : gesture == .open ? .open : .beat(wordCount) }
        let letters = Array(word)
        for (i, ch) in letters.enumerated() {
            let w = DispatchWorkItem { [weak self] in self?.mouth = Viseme.of(ch) }
            mouthWork.append(w)
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(i) * 0.055, execute: w)
        }
        let close = DispatchWorkItem { [weak self] in self?.mouth = .rest }
        mouthWork.append(close)
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(letters.count) * 0.055 + 0.04, execute: close)
    }

    private func show(_ message: String) {
        phase = .message(message)
        gesture = .rest
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            if case .message = self?.phase { self?.phase = .idle }
        }
    }

    // MARK: pointer

    private func showPointer(_ p: ScreenPoint) {
        guard let screen = NSScreen.main else { return }
        // Screenshot pixels -> screen points (AppKit's origin is bottom-left).
        let scale = screen.backingScaleFactor
        let target = CGPoint(x: screen.frame.minX + p.x / scale, y: screen.frame.maxY - p.y / scale)
        pointer?.close()
        let o = PointerOverlay(screen: screen, target: target, label: p.label)
        o.orderFrontRegardless()
        pointer = o
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self, weak o] in
            o?.close()
            if self?.pointer === o { self?.pointer = nil }
        }
    }

    // MARK: helpers

    struct ScreenPoint: Equatable { let x: Double; let y: Double; let label: String }

    static func parsePoint(_ reply: String) -> (String, ScreenPoint?) {
        let pattern = #"\[POINT:\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?::\s*([^\]]*))?\]"#
        let ns = reply as NSString
        let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
        let say = re?.stringByReplacingMatches(in: reply, range: NSRange(location: 0, length: ns.length), withTemplate: "")
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? reply
        guard let m = re?.firstMatch(in: reply, range: NSRange(location: 0, length: ns.length)) else { return (say, nil) }
        let x = Double(ns.substring(with: m.range(at: 1))) ?? 0
        let y = Double(ns.substring(with: m.range(at: 2))) ?? 0
        let label = m.range(at: 3).location != NSNotFound ? ns.substring(with: m.range(at: 3)).trimmingCharacters(in: .whitespaces) : ""
        return (say, ScreenPoint(x: x, y: y, label: label))
    }

    /// Markdown and code read badly aloud: strip the marks, drop code blocks.
    static func speakable(_ s: String) -> String {
        var t = s.replacingOccurrences(of: #"```[\s\S]*?```"#, with: " (code in the terminal) ", options: .regularExpression)
        t = t.replacingOccurrences(of: #"[*_`#>]+"#, with: "", options: .regularExpression)
        t = t.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]+\)"#, with: "$1", options: .regularExpression)
        return String(t.prefix(600))
    }

    /// The best installed English voice (premium > enhanced > default).
    static let bestVoice: AVSpeechSynthesisVoice? = {
        let en = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en") }
        return en.max { $0.quality.rawValue < $1.quality.rawValue } ?? AVSpeechSynthesisVoice(language: "en-US")
    }()

    /// Silent full-screen capture of the main display, for ox to look at.
    static func captureScreen() -> String? {
        let path = (NSTemporaryDirectory() as NSString).appendingPathComponent("ox-buddy-\(Int(Date().timeIntervalSince1970 * 1000)).png")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        p.arguments = ["-x", "-m", "-t", "png", path]
        do {
            try p.run()
            p.waitUntilExit()
        } catch {
            return nil
        }
        return FileManager.default.fileExists(atPath: path) ? path : nil
    }
}

extension Buddy: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        DispatchQueue.main.async { self.stopRecording(); self.finishSpeaking() }
    }
}

extension Buddy: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, willSpeakRangeOfSpeechString range: NSRange, utterance: AVSpeechUtterance) {
        let word = (utterance.speechString as NSString).substring(with: range)
        DispatchQueue.main.async { self.mouthWord(word) }
    }

    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { self.finishSpeaking() }
    }

    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { self.finishSpeaking() }
    }
}

// MARK: - hold-to-talk hotkey (⌃⌥Space), via Carbon: no Accessibility permission needed

enum BuddyHotKey {
    /// Several hold-keys (⌃⌥Space asks ox, ⌃⌥D dictates), told apart by their id.
    private static var refs: [EventHotKeyRef?] = []
    private static var actions: [UInt32: (press: () -> Void, release: () -> Void)] = [:]
    private static var handlerInstalled = false

    static func install(press: @escaping () -> Void, release: @escaping () -> Void) {
        register(id: 1, keyCode: kVK_Space, modifiers: controlKey | optionKey, press: press, release: release)
    }

    static func register(id: UInt32, keyCode: Int, modifiers: Int, press: @escaping () -> Void, release: @escaping () -> Void) {
        actions[id] = (press, release)
        if !handlerInstalled {
            handlerInstalled = true
            var types = [
                EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
                EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
            ]
            InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
                guard let event else { return noErr }
                var hk = EventHotKeyID()
                GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
                let kind = GetEventKind(event)
                let id = hk.id
                DispatchQueue.main.async {
                    guard let a = BuddyHotKey.actions[id] else { return }
                    if kind == UInt32(kEventHotKeyPressed) { a.press() } else { a.release() }
                }
                return noErr
            }, 2, &types, nil, nil)
        }
        var ref: EventHotKeyRef?
        RegisterEventHotKey(UInt32(keyCode), UInt32(modifiers), EventHotKeyID(signature: OSType(0x4F584259), id: id), GetApplicationEventTarget(), 0, &ref) // 'OXBY'
        refs.append(ref)
    }
}

// MARK: - hold Fn to talk

enum FnKey {
    private static var monitors: [Any] = []
    private static var pending: DispatchWorkItem?
    private static var down = false
    private static var talking = false

    static var enabled: Bool { UserDefaults.standard.object(forKey: "fn.talk") as? Bool ?? true }

    /// macOS's own use of the 🌐/Fn key (Keyboard settings), read only.
    static var globeUsage: Int { UserDefaults(suiteName: "com.apple.HIToolbox")?.object(forKey: "AppleFnUsageType") as? Int ?? 2 }
    static var globeOpensSomething: Bool { [1, 2].contains(globeUsage) } // 3 is dictation on a double press: holding Fn does not clash
    static var globeAction: String { [1: "the input source switcher", 2: "the emoji picker", 3: "Apple's dictation"][globeUsage] ?? "something" }

    /// Needs Accessibility (the same permission dictation's paste asks for).
    static func install(press: @escaping () -> Void, release: @escaping () -> Void) {
        let flags: (NSEvent) -> Void = { e in
            guard enabled else { return }
            let fnNow = e.modifierFlags.contains(.function) && e.keyCode == 63
            let others: NSEvent.ModifierFlags = [.command, .option, .control, .shift]
            if fnNow, !down, e.modifierFlags.intersection(others).isEmpty {
                down = true
                let work = DispatchWorkItem { talking = true; press() }
                pending = work
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
            } else if !e.modifierFlags.contains(.function), down {
                down = false
                pending?.cancel(); pending = nil
                if talking { talking = false; release() }
            }
        }
        // Fn + another key (F-keys, arrows, Fn-Delete): not a request to talk.
        let key: (NSEvent) -> Void = { _ in
            guard down, !talking else { return }
            pending?.cancel(); pending = nil
        }
        if let m = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged, handler: flags) { monitors.append(m) }
        if let m = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: key) { monitors.append(m) }
        if let m = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged, handler: { flags($0); return $0 }) { monitors.append(m) }
        if let m = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: { key($0); return $0 }) { monitors.append(m) }
    }
}

// MARK: - the pointer that flies to what the answer is about

final class PointerOverlay: NSPanel {
    init(screen: NSScreen, target: CGPoint, label: String) {
        super.init(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        level = .screenSaver
        backgroundColor = .clear
        isOpaque = false
        hasShadow = false
        ignoresMouseEvents = true
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        let local = CGPoint(x: target.x - screen.frame.minX, y: screen.frame.maxY - target.y) // top-down
        let start = CGPoint(x: screen.frame.width / 2, y: 40) // out of the notch
        contentView = NSHostingView(rootView: PointerView(start: start, target: local, label: label))
    }
}

struct PointerView: View {
    let start: CGPoint
    let target: CGPoint
    let label: String
    @State private var arrived = false
    @State private var pulse = false

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear
            ZStack {
                Circle().stroke(Ink.gold.opacity(pulse ? 0 : 0.7), lineWidth: 3)
                    .frame(width: pulse ? 90 : 26, height: pulse ? 90 : 26)
                    .opacity(arrived ? 1 : 0)
                Image(systemName: "cursorarrow")
                    .font(.system(size: 34, weight: .bold))
                    .foregroundStyle(Ink.gold)
                    .shadow(color: .black.opacity(0.5), radius: 6, y: 2)
                    .offset(x: 10, y: 14)
                if !label.isEmpty {
                    Text(label)
                        .font(.system(size: 13, weight: .semibold))
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(Capsule().fill(Color.black.opacity(0.85)))
                        .foregroundStyle(.white)
                        .offset(x: 30, y: 46)
                        .fixedSize()
                        .opacity(arrived ? 1 : 0)
                }
            }
            .position(arrived ? target : start)
        }
        .ignoresSafeArea()
        .onAppear {
            withAnimation(.spring(response: 0.75, dampingFraction: 0.72)) { arrived = true }
            withAnimation(.easeOut(duration: 1.1).repeatForever(autoreverses: false).delay(0.6)) { pulse = true }
        }
    }
}
