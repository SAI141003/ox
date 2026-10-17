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

    static var enabled: Bool { UserDefaults.standard.bool(forKey: "wake.enabled") }
    static let phrase = try! NSRegularExpression(pattern: #"\b(?:ok(?:ay)?|hey)[\s,]+ox\b[\s,.:!]*"#, options: [.caseInsensitive])

    func setEnabled(_ on: Bool) {
        UserDefaults.standard.set(on, forKey: "wake.enabled")
        on ? start() : stop()
    }

    func start() {
        guard Self.enabled, !listening, !micBusy() else { return }
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

    private func heard(_ text: String) {
        let ns = text as NSString
        guard let m = Self.phrase.matches(in: text, range: NSRange(location: 0, length: ns.length)).last else { return }
        command = ns.substring(from: m.range.location + m.range.length).trimmingCharacters(in: .whitespacesAndNewlines)
        // The request is done when the words stop for a moment.
        idle?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            let c = self.command.trimmingCharacters(in: CharacterSet(charactersIn: " ,.!?"))
            guard !c.isEmpty else { return }
            self.stop()
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
        guard listening || Self.enabled else { return }
        stop()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.start() }
    }
}
