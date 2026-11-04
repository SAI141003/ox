import AppKit
import AVFoundation
import Carbon.HIToolbox
import ImageIO
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

/// Optional animal companion shown beside the Island. These use OX's bundled
/// Blender-rendered animal cycles, never third-party mascot artwork.
enum IslandPetKind: String, CaseIterable, Identifiable {
    case none, puff, pebble, dot
    var id: String { rawValue }
    var title: String {
        switch self {
        case .none: return "No pet"
        case .puff: return "Puff · lamb"
        case .pebble: return "Pebble · goat"
        case .dot: return "Dot · calf"
        }
    }
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
    /// Distinguish a recognizer miss from a microphone that delivered silence.
    /// The old flow reported both as “I didn't catch that”, which made the
    /// actionable device/permission failure look like a routing failure.
    private var peakInputLevel: Double = 0

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var usedOnDevice = true
    private var emptyOnDevice = 0
    private let audio = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let synth = AVSpeechSynthesizer()
    private var shot: [String] = []
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

    func toggle() {
        if phase == .listening { stopListening(); return }
        // A second tap while the mic is still starting (permissions, audio) cancels it.
        if starting { starting = false; IslandLog.write("voice: start cancelled by a tap"); return }
        // Clicked (not held): the island ends by itself when you stop talking, as Pixie does.
        handsFree = true
        startListening()
    }

    /// One tap on the listening card, the pill or the mic: stop now.
    func stopIfListening() {
        if phase == .listening { stopListening() } else if starting { starting = false }
    }
    var isListeningOrStarting: Bool { phase == .listening || starting }
    /// Between the tap and the microphone being on (permission prompts, audio start).
    @Published private(set) var starting = false

    /// Started by a click, not a held key: listening ends on its own at the end of speech.
    @Published private(set) var handsFree = false
    private var lastHeardChange = Date()
    private var listenStarted = Date()
    private var endWatch: Timer?

    private func watchForEndOfSpeech() {
        endWatch?.invalidate()
        listenStarted = Date(); lastHeardChange = Date()
        let byClick = handsFree
        endWatch = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] t in
            MainActor.assumeIsolated {
                guard let self, self.phase == .listening else { t.invalidate(); return }
                let quiet = Date().timeIntervalSince(self.lastHeardChange)
                let total = Date().timeIntervalSince(self.listenStarted)
                let said = !self.heard.trimmingCharacters(in: .whitespaces).isEmpty
                // Clicked: words, then a pause; the recognizer's own end of sentence; nothing at all for 8 s.
                // Held key: until it is let go. Either way 45 s at most, so a lost key-up never leaves the mic on.
                if (byClick && ((said && (quiet > 0.9 || self.finalHeard)) || (!said && total > 8))) || total > 45 {
                    t.invalidate()
                    IslandLog.write("voice: end of speech (\(said ? "after a pause" : "nothing said"), \(String(format: "%.1f", total)) s)")
                    self.stopListening()
                }
            }
        }
    }

    /// Why nothing was heard, and the fix. Exact digital silence is not a quiet
    /// room: macOS hands an app zeros when its microphone permission belongs to
    /// an older build (a rebuild changes an ad-hoc signature). Then the stale
    /// permission is reset, so the next tap asks again and Allow takes.
    func noSignalAdvice() -> String {
        // Reset at most once a day: silence with the permission already fresh is something
        // else (a muted mic, another app holding it), and resetting each time made macOS ask again and again.
        let last = UserDefaults.standard.double(forKey: "voice.lastPermissionReset")
        if peakInputLevel < 0.00001, Date().timeIntervalSince1970 - last < 86_400 {
            IslandLog.write("voice: the microphone gave exact silence again (permission was reset today)")
            return "I heard silence. Check that the microphone is not muted and no other app is using it (System Settings › Sound › Input), then try again."
        }
        if peakInputLevel < 0.00001 {
            UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: "voice.lastPermissionReset")
            for service in ["Microphone", "SpeechRecognition"] {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/usr/bin/tccutil")
                p.arguments = ["reset", service, Bundle.main.bundleIdentifier ?? "dev.ox.island"]
                try? p.run(); p.waitUntilExit()
            }
            IslandLog.write("voice: the microphone gave exact silence; reset OX Island's Microphone and Speech permissions so macOS asks again")
            return "macOS gave me silence: my microphone permission was from an older build. I reset it. Tap the mic again and choose Allow. (Run ox island sign-setup once so updates keep it.)"
        }
        if peakInputLevel < 0.001 { return "No microphone signal reached OX Island. Select the right input in System Settings › Sound › Input, then try again." }
        return "I couldn't transcribe that. Press ⌃⌥Space, or click the mic, and talk again."
    }

    func startListening() {
        guard phase != .listening else { return }
        // Its own voice must not be recorded: the natural voice stops too, not only the system one.
        if phase == .speaking { stopSpeaking() }
        synth.stopSpeaking(at: .immediate)
        Self.sweepTemp()
        guard VoicePermission.described else { show(VoicePermission.howToFix); return }
        starting = true
        heard = ""
        saying = ""
        // Its own marks must not be in the picture of your screen.
        clearOverlays()
        // Warm before it is needed: the voice is ready by the time the answer is.
        if Self.naturalVoice { SpeakWorker.shared.warm() }
        // The screen is captured beside the microphone, not before it: done
        // first, it held the mic back 0.25-0.45 s and the first words were lost.
        shot = []
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let s = Self.captureScreens()
            DispatchQueue.main.async { self?.shot = s }
        }
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
        // Tapped again while it was starting: do not turn the mic on.
        guard starting else { return }
        starting = false
        guard let recognizer, recognizer.isAvailable else { show("Speech recognition is not available right now."); return }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        // Dictation quality: punctuation, the dictation model, on-device when possible.
        req.addsPunctuation = true
        req.taskHint = .dictation
        // On this Mac when it can, unless on-device recognition kept hearing nothing
        // (quiet microphones): then Apple's own recognizer, which is faster than the
        // whisper pass over the recording that an empty result falls back to.
        let onDevice = recognizer.supportsOnDeviceRecognition && !UserDefaults.standard.bool(forKey: "voice.serverRecognition")
        req.requiresOnDeviceRecognition = onDevice
        usedOnDevice = onDevice
        request = req
        finalHeard = false
        peakInputLevel = 0
        let input = audio.inputNode
        let format = input.outputFormat(forBus: 0)
        // Keep the audio too: whisper on the ox side hears more than the live preview.
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("ox-voice-\(Int(Date().timeIntervalSince1970 * 1000)).caf")
        recording = try? AVAudioFile(forWriting: url, settings: format.settings)
        recordingURL = recording == nil ? nil : url
        let file = recording
        input.removeTap(onBus: 0)
        // Automatic gain: a microphone with its input volume low (27% here) gave
        // speech peaking near -34 dB, and both recognizers made up words from it.
        // Speech is brought toward a 0.3 peak (at most ×16, never above 0.9);
        // the gain follows the loudest recent sound and falls quickly on a shout.
        var gain: Float = 1
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buf, _ in
            let n = Int(buf.frameLength)
            var rawPeak: Float = 0
            if let chans = buf.floatChannelData {
                for c in 0..<Int(buf.format.channelCount) { for i in 0..<n { rawPeak = max(rawPeak, abs(chans[c][i])) } }
                if rawPeak > 0.002 {
                    let want = min(16, max(1, 0.3 / rawPeak))
                    gain = want < gain ? want : gain + (want - gain) * 0.05
                }
                if gain > 1.01 {
                    for c in 0..<Int(buf.format.channelCount) { for i in 0..<n { chans[c][i] = max(-0.9, min(0.9, chans[c][i] * gain)) } }
                }
            }
            req.append(buf)
            try? file?.write(from: buf)
            guard let ch = buf.floatChannelData?[0] else { return }
            var sum: Float = 0
            for i in 0..<n { sum += ch[i] * ch[i] }
            // The level shown and logged is the microphone's own (before the gain), so "no signal" stays true.
            let rms = Double(sqrt(sum / Float(max(n, 1)))) / Double(max(gain, 1))
            DispatchQueue.main.async {
                self?.peakInputLevel = max(self?.peakInputLevel ?? 0, rms)
                self?.level = min(1, rms * 12)
            }
        }
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            if let error, result == nil { DispatchQueue.main.async { IslandLog.write("voice: recognizer error: \(error.localizedDescription)") } }
            guard let result else { return }
            let text = result.bestTranscription.formattedString
            let final = result.isFinal
            DispatchQueue.main.async {
                if self?.heard != text { self?.lastHeardChange = Date() }
                self?.heard = text
                if final { self?.finalHeard = true }
            }
        }
        do {
            audio.prepare()
            try audio.start()
            phase = .listening
            gesture = .rest
            watchForEndOfSpeech()
        } catch {
            show("The microphone could not start: \(error.localizedDescription)")
        }
    }

    func stopListening() {
        endWatch?.invalidate(); endWatch = nil
        handsFree = false
        guard phase == .listening else { return }
        questionAt = Date()
        // Leave "listening" at once: a second stop in the next 1.5 s (key release,
        // end of speech, a tap) ran this again and sent the same words 2-3 times.
        phase = .thinking
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
            // On-device heard nothing over real sound twice in a row: use Apple's recognizer from now on.
            if self.usedOnDevice, audioPath != nil, self.peakInputLevel > 0.005 {
                self.emptyOnDevice = text.isEmpty ? self.emptyOnDevice + 1 : 0
                if self.emptyOnDevice >= 2 {
                    UserDefaults.standard.set(true, forKey: "voice.serverRecognition")
                    IslandLog.write("voice: on-device recognition heard nothing twice; Apple's recognizer is used from now on (defaults delete dev.ox.island voice.serverRecognition to undo)")
                }
            }
            IslandLog.write("voice heard: \"\(text)\" (final: \(self.finalHeard), recording: \(audioPath != nil), peak: \(String(format: "%.4f", self.peakInputLevel)))")
            // Nothing heard live, or the live recognizer never settled on its final
            // words (a quiet microphone heard "open calculator" as "Advance"): whisper
            // on this Mac listens to the recording again, and its words are used.
            if text.isEmpty || !self.finalHeard, let audioPath, let port = Dictation.serverPort, let u = URL(string: "http://127.0.0.1:\(port)/ox/voice/transcribe") {
                var req = URLRequest(url: u, timeoutInterval: 30)
                req.httpMethod = "POST"
                req.setValue("application/json", forHTTPHeaderField: "content-type")
                req.httpBody = try? JSONSerialization.data(withJSONObject: ["path": audioPath])
                self.phase = .thinking
                URLSession.shared.dataTask(with: req) { data, _, _ in
                    let again = ((data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })?["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    DispatchQueue.main.async {
                        IslandLog.write("voice heard again from the recording: \"\(again)\"")
                        guard !again.isEmpty, !again.hasPrefix("[") else {
                            // Whisper heard nothing either: the live words, if there were any.
                            if !text.isEmpty, self.send?(text, self.shot, audioPath) == true { self.gesture = .think; return }
                            self.phase = .idle
                            self.show(self.noSignalAdvice())
                            return
                        }
                        self.heard = again
                        guard self.send?(again, self.shot, audioPath) == true else { self.show("I can't find ox on this Mac. Open the OX app once, then ask me again."); return }
                        self.gesture = .think
                    }
                }.resume()
                return
            }
            // Nothing heard at all: say so (an empty request used to end as "can't find ox").
            guard !text.isEmpty else {
                self.show(self.noSignalAdvice())
                return
            }
            guard self.send?(text, self.shot, audioPath) == true else {
                IslandLog.write("voice: nobody took it (ox not found)")
                self.show("I can't find ox on this Mac. Open the OX app once, then ask me again.")
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
        let (marked, marks) = Self.parseMarks(reply)
        let (say, point) = Self.parsePoint(marked)
        let text = say.isEmpty ? (point != nil ? "Here." : "Done.") : say
        if !marks.isEmpty { IslandLog.write("marks drawn: \(marks.map { "\($0.kind.lowercased()) \($0.label)" }.joined(separator: ", "))"); showMarks(marks) }
        saying = text
        pendingPoint = point
        wordCount = 0
        phase = .speaking
        gesture = point != nil ? .point : .open
        if let point { showPointer(point) }
        let spoken = Self.speakable(text)
        replyAt = Date()
        guard Self.naturalVoice, OxRunner.available else { logFirstSound(); systemSpeak(spoken); return }
        let token = UUID()
        speakToken = token
        clearPlayQueue()
        sayNext(Self.sentences(spoken)[...], token: token)
    }

    /// One sentence at a time: the first is heard as soon as it is made, and the rest follow it.
    private func sayNext(_ left: ArraySlice<String>, token: UUID) {
        guard let sentence = left.first else { making = false; if player == nil, phase == .speaking { finishSpeaking() }; return }
        making = true
        let out = (NSTemporaryDirectory() as NSString).appendingPathComponent("ox-buddy-say-\(UUID().uuidString.prefix(8)).wav")
        SpeakWorker.shared.say(sentence, out: out) { [weak self] ok in
            guard let self, self.speakToken == token, self.phase == .speaking else { try? FileManager.default.removeItem(atPath: out); return }
            guard ok, let p = try? AVAudioPlayer(contentsOf: URL(fileURLWithPath: out)) else {
                // No natural voice: what is left, in the system's. It waits for a sentence already playing.
                self.making = false
                self.fallbackText = left.joined(separator: " ")
                if self.player == nil { self.speakFallback() }
                return
            }
            if self.player == nil { self.playRecording(p, file: out) } else { self.playQueue.append((p, out)) }
            self.sayNext(left.dropFirst(), token: token)
        }
    }

    private func speakFallback() {
        guard let t = fallbackText else { return }
        fallbackText = nil
        logFirstSound()
        systemSpeak(t)
    }

    private func logFirstSound() {
        guard let reply = replyAt else { return }
        replyAt = nil
        let now = Date()
        let fromQuestion = questionAt.map { " · \(Int(now.timeIntervalSince($0) * 1000)) ms from the question" } ?? ""
        IslandLog.write("voice: first sound \(Int(now.timeIntervalSince(reply) * 1000)) ms after the reply\(fromQuestion)")
        questionAt = nil
    }

    private func clearPlayQueue() {
        for (_, f) in playQueue { try? FileManager.default.removeItem(atPath: f) }
        playQueue = []
        making = false
        fallbackText = nil
    }

    /// Split so each part can be voiced alone. Short pieces stay with the next, so nothing sounds clipped.
    nonisolated static func sentences(_ text: String) -> [String] {
        var out: [String] = []
        var cur = ""
        for part in text.split(omittingEmptySubsequences: true, whereSeparator: { $0 == "\n" }).flatMap({ line -> [String] in
            var bits: [String] = []
            var b = ""
            let chars = Array(line)
            for (i, ch) in chars.enumerated() {
                b.append(ch)
                if ".!?".contains(ch), i + 1 == chars.count || chars[i + 1] == " " { bits.append(b); b = "" }
            }
            if !b.isEmpty { bits.append(b) }
            return bits
        }) {
            cur += (cur.isEmpty ? "" : " ") + part.trimmingCharacters(in: .whitespaces)
            if cur.count >= 24 { out.append(cur); cur = "" }
        }
        if !cur.isEmpty { if let last = out.popLast() { out.append(last + " " + cur) } else { out.append(cur) } }
        return out.isEmpty ? [text] : out
    }

    /// Kokoro on (the default) or the system voice, from the island's settings.
    static var naturalVoice: Bool {
        UserDefaults.standard.object(forKey: "buddy.naturalVoice") as? Bool ?? true
    }

    private var speakToken: UUID?
    private var playQueue: [(AVAudioPlayer, String)] = []
    private var making = false
    private var fallbackText: String?
    private var questionAt: Date?
    private var replyAt: Date?
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
        logFirstSound()
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
        clearPlayQueue()
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
        starting = false
        phase = .message(message)
        gesture = .rest
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            if case .message = self?.phase { self?.phase = .idle }
        }
    }

    // MARK: pointer

    /// What it drew last time: closed before it looks, or it sees its own marks.
    func clearOverlays() {
        pointer?.close(); pointer = nil
        marksOverlay?.close(); marksOverlay = nil
    }

    private func showPointer(_ p: ScreenPoint) {
        // [POINT:…:screen2] is the second picture; there is no pointer for a screen that has gone.
        let named = p.screen.flatMap { n in n >= 1 && n <= Buddy.shotScreens.count ? Buddy.shotScreens[n - 1] : nil }
        if p.screen != nil, named == nil { return }
        guard let screen = named ?? Buddy.shotScreen ?? NSScreen.main else { return }
        // Screenshot pixels -> screen points (AppKit's origin is bottom-left).
        let scale = Buddy.shotPixelScale ?? screen.backingScaleFactor
        let target = CGPoint(x: screen.frame.minX + p.x / scale, y: screen.frame.maxY - p.y / scale)
        pointer?.close()
        IslandLog.write("pointer: \(p.label) at \(Int(target.x)),\(Int(target.y))")
        let o = PointerOverlay(screen: screen, target: target, label: p.label)
        o.orderFrontRegardless()
        pointer = o
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self, weak o] in
            o?.close()
            if self?.pointer === o { self?.pointer = nil }
        }
    }

    // MARK: marks drawn over the screen (circles, arrows, boxes)

    private var marksOverlay: MarksOverlay?

    private func showMarks(_ marks: [ScreenMark]) {
        guard let screen = Buddy.shotScreen ?? NSScreen.main else { return }
        marksOverlay?.close()
        let o = MarksOverlay(screen: screen, marks: marks)
        o.orderFrontRegardless()
        marksOverlay = o
        // Up while the answer is spoken, then a few seconds to look at them.
        let words = Double(saying.split(separator: " ").count)
        DispatchQueue.main.asyncAfter(deadline: .now() + max(8, words * 0.45 + 5)) { [weak self, weak o] in
            o?.close()
            if self?.marksOverlay === o { self?.marksOverlay = nil }
        }
    }

    struct ScreenMark: Equatable { let kind: String; let n: [Double]; let label: String }

    /// [CIRCLE:x,y,r:label] [ARROW:x1,y1,x2,y2:label] [BOX:x,y,w,h:label], in
    /// screenshot pixels (the same rules as src/buddy.js parseMarks).
    nonisolated static func parseMarks(_ reply: String) -> (String, [ScreenMark]) {
        let pattern = #"\[(CIRCLE|ARROW|BOX):\s*([\d.\s,]+?)\s*(?::\s*([^\]]*))?\]"#
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return (reply, []) }
        let ns = reply as NSString
        let want = ["circle": 3, "arrow": 4, "box": 4]
        var marks: [ScreenMark] = []
        for m in re.matches(in: reply, range: NSRange(location: 0, length: ns.length)) {
            let kind = ns.substring(with: m.range(at: 1)).lowercased()
            let n = ns.substring(with: m.range(at: 2)).split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
            guard n.count == want[kind], n.allSatisfy({ $0 >= 0 }) else { continue }
            let label = m.range(at: 3).location != NSNotFound ? String(ns.substring(with: m.range(at: 3)).trimmingCharacters(in: .whitespaces).prefix(24)) : ""
            marks.append(ScreenMark(kind: kind, n: n, label: label))
            if marks.count >= 6 { break }
        }
        let say = re.stringByReplacingMatches(in: reply, range: NSRange(location: 0, length: ns.length), withTemplate: "")
            .replacingOccurrences(of: #"\s{2,}"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
        return (say, marks)
    }

    // MARK: helpers

    struct ScreenPoint: Equatable { let x: Double; let y: Double; let label: String; var screen: Int? = nil }

    /// [POINT:x,y:label], [POINT:x,y,label] and [POINT:x,y:label:screen2]: the same rules as src/buddy.js.
    /// A numbered [POINT:#12:label] is turned into x,y by ox before it gets here; one left over points nowhere.
    static func parsePoint(_ reply: String) -> (String, ScreenPoint?) {
        let ns = reply as NSString
        let all = NSRange(location: 0, length: ns.length)
        let any = try? NSRegularExpression(pattern: #"\[POINT:[^\]]*\]"#, options: [.caseInsensitive])
        let say = any?.stringByReplacingMatches(in: reply, range: all, withTemplate: "").trimmingCharacters(in: .whitespacesAndNewlines) ?? reply
        let re = try? NSRegularExpression(pattern: #"\[POINT:\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:[:,]\s*([^\]]*?))?\s*\]"#, options: [.caseInsensitive])
        guard let m = re?.firstMatch(in: reply, range: all) else { return (say, nil) }
        let x = Double(ns.substring(with: m.range(at: 1))) ?? 0
        let y = Double(ns.substring(with: m.range(at: 2))) ?? 0
        var label = m.range(at: 3).location != NSNotFound ? ns.substring(with: m.range(at: 3)).trimmingCharacters(in: .whitespaces) : ""
        var screen: Int?
        if let r = label.range(of: #"(?:^|[:,]\s*)screen\s*\d+$"#, options: [.regularExpression, .caseInsensitive]) {
            screen = Int(label[r].filter(\.isNumber))
            label = String(label[..<r.lowerBound]).trimmingCharacters(in: .whitespaces)
        }
        return (say, ScreenPoint(x: x, y: y, label: label, screen: screen))
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

    /// Screenshots of your screen and voice recordings are working files, not
    /// keepsakes: anything of ours older than ten minutes is deleted.
    static func sweepTemp(olderThan age: TimeInterval = 600) {
        let dir = NSTemporaryDirectory()
        let fm = FileManager.default
        for name in (try? fm.contentsOfDirectory(atPath: dir)) ?? [] where name.hasPrefix("ox-buddy-") || name.hasPrefix("ox-voice-") {
            let path = (dir as NSString).appendingPathComponent(name)
            if let m = (try? fm.attributesOfItem(atPath: path))?[.modificationDate] as? Date, Date().timeIntervalSince(m) > age {
                try? fm.removeItem(atPath: path)
            }
        }
    }

    /// Silent full-screen capture of the main display, for ox to look at.
    /// Only when screen recording is already allowed: asking macOS on every
    /// request put its permission window up each time you spoke ("open Chrome"
    /// needs no screenshot). Turn it on once from the island's menu.
    static var shotScreen: NSScreen?
    static var shotScreens: [NSScreen] = []
    static var shotPixelScale: CGFloat?

    /// The screen the mouse is on.
    static func screenUnderMouse() -> NSScreen? {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) ?? NSScreen.main
    }

    /// Every display, the one the mouse is on first. For each: `<name>.png` at the screen's own size, which
    /// the model sees and the pointer's numbers refer to; `<name>.full.png`, every Retina pixel;
    /// `<name>.json`, where that screen is; and `<name>.see.json`, its words, read while you are still talking.
    static func captureScreens() -> [String] {
        guard CGPreflightScreenCaptureAccess() else { return [] }
        let first = screenUnderMouse()
        let ordered = (first.map { [$0] } ?? []) + NSScreen.screens.filter { $0 != first }
        var count: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &count)
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        CGGetActiveDisplayList(count, &ids, &count)
        let stamp = Int(Date().timeIntervalSince1970 * 1000)
        var paths: [String] = []
        var screens: [NSScreen] = []
        var allSized = true
        for (i, screen) in ordered.enumerated() {
            guard let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID,
                  let index = ids.firstIndex(of: id) else { continue }
            let base = (NSTemporaryDirectory() as NSString).appendingPathComponent("ox-buddy-\(stamp)-\(i + 1)")
            let full = base + ".full.png", small = base + ".png"
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            p.arguments = ["-x", "-D", String(index + 1), "-t", "png", full]
            do { try p.run(); p.waitUntilExit() } catch { continue }
            guard FileManager.default.fileExists(atPath: full) else { continue }
            if !resized(full, width: Int(screen.frame.width), to: small) {
                allSized = false
                try? FileManager.default.copyItem(atPath: full, toPath: small)
            }
            let b = CGDisplayBounds(id)
            let where_: [String: Double] = ["x": Double(b.minX), "y": Double(b.minY), "w": Double(b.width), "h": Double(b.height)]
            if let d = try? JSONSerialization.data(withJSONObject: where_) { try? d.write(to: URL(fileURLWithPath: base + ".json")) }
            readWords(full, into: base + ".see.json")
            paths.append(small)
            screens.append(screen)
        }
        shotScreens = screens
        shotScreen = screens.first
        shotPixelScale = allSized ? 1 : nil
        return paths
    }

    /// The same picture at another width, in this process: sips cost a third of the capture.
    private static func resized(_ file: String, width: Int, to out: String) -> Bool {
        guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: file) as CFURL, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil), img.width > 0, width > 0 else { return false }
        let height = Int((Double(img.height) * Double(width) / Double(img.width)).rounded())
        guard let c = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
        c.interpolationQuality = .high
        c.draw(img, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let small = c.makeImage(), let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, "public.png" as CFString, 1, nil) else { return false }
        CGImageDestinationAddImage(dest, small, nil)
        return CGImageDestinationFinalize(dest)
    }

    /// ox-hands reads the words in the background. The file appears whole or not at all, and ox reads them itself if it is not there yet.
    private static func readWords(_ file: String, into out: String) {
        guard let hands = Bundle.main.executableURL?.deletingLastPathComponent().appendingPathComponent("OxHands"),
              FileManager.default.isExecutableFile(atPath: hands.path) else { return }
        let p = Process()
        p.executableURL = hands
        p.arguments = ["see", file]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        DispatchQueue.global(qos: .userInitiated).async {
            guard (try? p.run()) != nil else { return }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            guard p.terminationStatus == 0, !data.isEmpty else { return }
            let tmp = out + ".part"
            if (try? data.write(to: URL(fileURLWithPath: tmp))) != nil { try? FileManager.default.moveItem(atPath: tmp, toPath: out) }
        }
    }
}

extension Buddy: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        DispatchQueue.main.async {
            self.stopRecording()
            if !self.playQueue.isEmpty {
                let (p, f) = self.playQueue.removeFirst()
                self.playRecording(p, file: f)
            } else if self.fallbackText != nil {
                self.speakFallback()
            } else if !self.making {
                self.finishSpeaking()
            }
        }
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

// MARK: - the voice, kept warm

/// `ox speak --serve`: one process that keeps the voice model in memory, started when you press the key.
/// A fresh `ox speak` cost 3-6 s to load it for every reply. Gone after ten quiet minutes, and with the island.
@MainActor final class SpeakWorker {
    static let shared = SpeakWorker()
    private var process: Process?
    private var input: FileHandle?
    private var waiting: [Int: (Bool) -> Void] = [:]
    private var nextId = 0
    private var buffer = Data()
    private var idle: DispatchWorkItem?

    func warm() {
        keepUntilIdle()
        guard process?.isRunning != true, let (node, cli) = OxRunner.paths() else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [cli, "speak", "--serve"]
        p.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        var e = ProcessInfo.processInfo.environment
        e["OX_ISLAND"] = "0"; e["NO_COLOR"] = "1"
        p.environment = e
        let stdin = Pipe(), stdout = Pipe()
        p.standardInput = stdin
        p.standardOutput = stdout
        p.standardError = FileHandle.nullDevice
        stdout.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.received(d) } }
        }
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.process = nil
                    self.input = nil
                    let left = self.waiting
                    self.waiting = [:]
                    for (_, w) in left { w(false) }
                }
            }
        }
        do { try p.run(); process = p; input = stdin.fileHandleForWriting } catch { IslandLog.write("voice: could not start: \(error.localizedDescription)") }
    }

    func say(_ text: String, out: String, done: @escaping (Bool) -> Void) {
        warm()
        guard let input, process?.isRunning == true else { done(false); return }
        nextId += 1
        let id = nextId
        waiting[id] = done
        guard let d = try? JSONSerialization.data(withJSONObject: ["id": id, "text": text, "out": out] as [String: Any]) else { waiting[id] = nil; done(false); return }
        do { try input.write(contentsOf: d + Data("\n".utf8)) } catch { waiting[id] = nil; done(false) }
    }

    private func received(_ d: Data) {
        buffer.append(d)
        while let nl = buffer.firstIndex(of: 10) {
            let line = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            guard let j = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any], let id = j["id"] as? Int, let w = waiting.removeValue(forKey: id) else { continue }
            w(j["ok"] as? Bool ?? false)
        }
    }

    private func keepUntilIdle() {
        idle?.cancel()
        let w = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.waiting.isEmpty else { return }
                try? self.input?.close()
            }
        }
        idle = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 600, execute: w)
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


// MARK: - marks over the screen (Pixie-style: explain by drawing on it)

final class MarksOverlay: NSPanel {
    init(screen: NSScreen, marks: [Buddy.ScreenMark]) {
        super.init(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        level = .screenSaver
        backgroundColor = .clear
        isOpaque = false
        hasShadow = false
        ignoresMouseEvents = true
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        contentView = NSHostingView(rootView: MarksView(marks: marks, scale: screen.backingScaleFactor))
    }
}

struct MarksView: View {
    let marks: [Buddy.ScreenMark]
    /// Screenshot pixels per screen point.
    let scale: CGFloat
    @State private var drawn: CGFloat = 0
    static let tints: [Color] = [Color(hex: "#FFD60A"), Color(hex: "#30D158"), Color(hex: "#64D2FF"), Color(hex: "#FF9F0A"), Color(hex: "#BF5AF2"), Color(hex: "#FF453A")]

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear
            ForEach(Array(marks.enumerated()), id: \.offset) { i, m in
                let tint = Self.tints[i % Self.tints.count]
                let p = m.n.map { CGFloat($0) / scale }
                // Each mark draws on after the one before it, like a pen.
                let t = min(1, max(0, drawn * CGFloat(marks.count) - CGFloat(i)))
                switch m.kind {
                case "circle":
                    Circle().trim(from: 0, to: t).stroke(tint, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                        .frame(width: p[2] * 2, height: p[2] * 2).position(x: p[0], y: p[1])
                    label(m.label, tint).position(x: p[0], y: p[1] - p[2] - 16).opacity(t)
                case "box":
                    RoundedRectangle(cornerRadius: 6).trim(from: 0, to: t).stroke(tint, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                        .frame(width: p[2], height: p[3]).position(x: p[0] + p[2] / 2, y: p[1] + p[3] / 2)
                    label(m.label, tint).position(x: p[0] + p[2] / 2, y: p[1] - 16).opacity(t)
                default:
                    Arrow(from: CGPoint(x: p[0], y: p[1]), to: CGPoint(x: p[2], y: p[3])).trim(from: 0, to: t)
                        .stroke(tint, style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round))
                    label(m.label, tint).position(x: (p[0] + p[2]) / 2, y: (p[1] + p[3]) / 2 - 18).opacity(t)
                }
            }
        }
        .shadow(color: .black.opacity(0.45), radius: 3)
        .ignoresSafeArea()
        .onAppear { withAnimation(.easeInOut(duration: 0.5 * Double(max(1, marks.count)))) { drawn = 1 } }
    }

    @ViewBuilder private func label(_ text: String, _ tint: Color) -> some View {
        if !text.isEmpty {
            Text(text).font(.system(size: 15, weight: .bold, design: .rounded)).foregroundStyle(.black)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Capsule().fill(tint)).fixedSize()
        }
    }
}

/// A line with an arrowhead at its end.
struct Arrow: Shape {
    let from: CGPoint
    let to: CGPoint
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: from)
        p.addLine(to: to)
        let a = atan2(to.y - from.y, to.x - from.x), head: CGFloat = 16
        for d in [CGFloat.pi * 0.82, -CGFloat.pi * 0.82] {
            p.move(to: to)
            p.addLine(to: CGPoint(x: to.x + head * cos(a + d), y: to.y + head * sin(a + d)))
        }
        return p
    }
}

// MARK: - double-tap right ⌘: Double Tap (ox reply)

/// Two quick taps of the right ⌘ key, nothing else pressed in between, with the
/// cursor in a reply box: ox drafts the reply in your voice and leaves it unsent
/// (`ox reply`, src/double-tap.js). Off with `defaults write dev.ox.island doubletap.reply -bool NO`.
enum RightCommandDoubleTap {
    private static var monitors: [Any] = []
    private static var downAt: Date?
    private static var lastTapAt: Date?
    private static var otherKey = false
    private static var running = false

    static var enabled: Bool { UserDefaults.standard.object(forKey: "doubletap.reply") as? Bool ?? true }

    static func install() {
        let flags: (NSEvent) -> Void = { e in
            guard enabled, e.keyCode == 54 else { return }   // 54: the right ⌘
            let others: NSEvent.ModifierFlags = [.option, .control, .shift, .function]
            if e.modifierFlags.contains(.command), e.modifierFlags.intersection(others).isEmpty {
                downAt = Date(); otherKey = false
            } else if let d = downAt {
                downAt = nil
                guard !otherKey, Date().timeIntervalSince(d) < 0.3 else { lastTapAt = nil; return }
                if let last = lastTapAt, Date().timeIntervalSince(last) < 0.4 { lastTapAt = nil; fire() } else { lastTapAt = Date() }
            }
        }
        // ⌘C, ⌘V and the like are shortcuts, not a tap.
        let key: (NSEvent) -> Void = { _ in otherKey = true; lastTapAt = nil }
        if let m = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged, handler: flags) { monitors.append(m) }
        if let m = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: key) { monitors.append(m) }
    }

    private static func fire() {
        guard !running, let ox = OxRunner.paths() else { return }
        running = true
        IslandLog.write("double tap: drafting a reply")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: ox.node)
        p.arguments = [ox.cli, "reply"]
        p.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        let out = Pipe(); p.standardOutput = out; p.standardError = out
        p.terminationHandler = { proc in
            let said = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            IslandLog.write("double tap: \(proc.terminationStatus == 0 ? "done" : "failed") \(said.suffix(200))")
            running = false
        }
        do { try p.run() } catch { running = false; IslandLog.write("double tap: \(error.localizedDescription)") }
    }
}
