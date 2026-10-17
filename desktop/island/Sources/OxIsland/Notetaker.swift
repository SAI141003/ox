import AppKit
import AVFoundation
import Speech

// Call notes (Coucou's Notetaker): Record a call from the island menu; your
// words are transcribed live on this Mac; Stop writes the transcript to
// ~/ox-notes/calls/<date>.md and ox adds a summary, key points and to-dos with
// your model. This version hears the microphone only (what the Mac plays, the
// other side of a call, needs Screen Recording access and is not captured yet).
// Tell the people in the call that you record.
@MainActor
final class Notetaker: ObservableObject {
    @Published private(set) var recording = false
    @Published private(set) var startedAt: Date?
    @Published private(set) var live = ""
    @Published var message: String?

    private let recognizer = SFSpeechRecognizer()
    private var audio = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var segments: [String] = []
    private var current = ""
    private var rollTimer: Timer?

    var willListen: () -> Void = {}
    func toggle() { recording ? stop() : start() }

    func start() {
        guard !recording else { return }
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard status == .authorized else { self.message = "Allow Speech Recognition for OX Island in System Settings › Privacy & Security."; return }
                self.willListen()
                self.segments = []; self.current = ""; self.live = ""
                self.startedAt = Date()
                self.recording = true
                self.listen()
            }
        }
    }

    private func listen() {
        guard recording, let recognizer, recognizer.isAvailable else { return }
        audio = AVAudioEngine()
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.addsPunctuation = true
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        request = req
        let input = audio.inputNode
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: input.outputFormat(forBus: 0)) { buf, _ in req.append(buf) }
        current = ""
        task = recognizer.recognitionTask(with: req) { [weak self] result, _ in
            guard let result else { return }
            let text = result.bestTranscription.formattedString
            DispatchQueue.main.async { self?.current = text; self?.live = ([self?.segments.last ?? "", text].filter { !$0.isEmpty }).joined(separator: " ").suffix(160).description }
        }
        do { audio.prepare(); try audio.start() } catch { message = "The microphone could not start: \(error.localizedDescription)"; recording = false; return }
        // One request lasts about a minute: roll over to a fresh one, keeping the words.
        rollTimer?.invalidate()
        rollTimer = Timer.scheduledTimer(withTimeInterval: 50, repeats: false) { [weak self] _ in DispatchQueue.main.async { self?.roll() } }
    }

    private func closeSegment() {
        rollTimer?.invalidate(); rollTimer = nil
        request?.endAudio(); task?.finish(); task = nil; request = nil
        if audio.isRunning { audio.stop() }
        audio.inputNode.removeTap(onBus: 0)
        let t = current.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty { segments.append(t) }
        current = ""
    }

    private func roll() { guard recording else { return }; closeSegment(); listen() }

    func stop() {
        guard recording else { return }
        closeSegment()
        recording = false
        let started = startedAt ?? Date()
        startedAt = nil
        let transcript = segments.joined(separator: "\n\n")
        guard !transcript.isEmpty else { message = "Nothing was heard, so no notes were written."; return }
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("ox-notes/calls")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let stamp = DateFormatter(); stamp.dateFormat = "yyyy-MM-dd HH.mm"
        let file = dir.appendingPathComponent("Call \(stamp.string(from: started)).md")
        let mins = max(1, Int(Date().timeIntervalSince(started) / 60))
        let doc = "# Call, \(stamp.string(from: started)) (\(mins) min)\n\n## Transcript (your microphone)\n\n\(transcript)\n"
        try? doc.write(to: file, atomically: true, encoding: .utf8)
        message = "Transcript saved. Writing the summary…"
        // The summary, key points and to-dos, by your model, appended to the same file.
        let prompt = "Read the call transcript in \(file.path). Reply in Markdown with exactly three sections: ## Summary (3-5 sentences), ## Key points (bullets), ## To-dos (checkboxes, with who if said). Use only what is in the transcript; if it is too short to summarise, say so."
        OxRunner.run(["--mode", "ask", "-p", prompt], cwd: dir) { [weak self] code, out in
            let answer = Shelf.clean(out)
            if code == 0, !answer.isEmpty, let h = try? FileHandle(forWritingTo: file) {
                h.seekToEndOfFile(); h.write(Data("\n\(answer)\n".utf8)); try? h.close()
                self?.message = "Call notes ready."
            } else {
                self?.message = "Transcript saved; the summary failed: \(answer.isEmpty ? "exit \(code)" : String(answer.prefix(80)))"
            }
            NSWorkspace.shared.open(file)
        }
    }
}
