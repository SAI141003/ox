import AppKit
import AVFoundation
import Speech

// Call notes (Coucou's Notetaker): Record a call from the island menu; your
// words are transcribed live on this Mac; Stop writes the transcript to
// ~/ox-notes/calls/<date>.md and ox adds a summary, key points and to-dos with
// your model. The other side of the call (what the Mac plays) is recorded too
// with ScreenCaptureKit (SystemAudio.swift; Screen Recording access, asked
// once), transcribed with ox's Whisper path when you stop, and merged by time:
// "You:" from the microphone, "Them:" from the call.
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
    private var segments: [(at: TimeInterval, text: String)] = []
    private var current = ""
    private var segStart: TimeInterval = 0
    private var rollTimer: Timer?
    private var system: SystemAudioRecorder?
    private var systemURL: URL?

    var willListen: () -> Void = {}
    func toggle() { recording ? stop() : start() }

    func start() {
        guard !recording else { return }
        guard VoicePermission.described else { message = VoicePermission.howToFix; return }
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard status == .authorized else { self.message = "Allow Speech Recognition for OX Island in System Settings › Privacy & Security."; return }
                self.willListen()
                self.segments = []; self.current = ""; self.live = ""
                self.startedAt = Date()
                self.recording = true
                self.listen()
                self.startSystemAudio()
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
        segStart = Date().timeIntervalSince(startedAt ?? Date())
        task = recognizer.recognitionTask(with: req) { [weak self] result, _ in
            guard let result else { return }
            let text = result.bestTranscription.formattedString
            DispatchQueue.main.async { self?.current = text; self?.live = ([self?.segments.last?.text ?? "", text].filter { !$0.isEmpty }).joined(separator: " ").suffix(160).description }
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
        if !t.isEmpty { segments.append((segStart, t)) }
        current = ""
    }

    private func roll() { guard recording else { return }; closeSegment(); listen() }

    /// The other side of the call: what the Mac plays, into a file beside the notes.
    private func startSystemAudio() {
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("ox-notes/calls", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("call-audio-\(Int(Date().timeIntervalSince1970)).caf")
        let rec = SystemAudioRecorder(url: url)
        system = rec; systemURL = url
        Task { [weak self] in
            let ok = await rec.start()
            await MainActor.run { if !ok { self?.message = "Recording your side only: \(rec.failure ?? "the call's sound could not be captured")"; self?.system = nil } }
        }
    }

    func stop() {
        guard recording else { return }
        closeSegment()
        recording = false
        let started = startedAt ?? Date()
        startedAt = nil
        let mine = segments
        let rec = system, url = systemURL
        system = nil; systemURL = nil
        Task { [weak self] in
            if let rec { await rec.stop() }
            let theirs = rec != nil && (rec?.frames ?? 0) > 48_000 ? url : nil
            await MainActor.run { self?.finish(started: started, mine: mine, theirsAudio: theirs) }
        }
    }

    /// Transcribe the other side (ox video transcribe: whisper.cpp on this Mac), merge by time, write the notes.
    private func finish(started: Date, mine: [(at: TimeInterval, text: String)], theirsAudio: URL?) {
        guard let audio = theirsAudio else { write(started: started, mine: mine, theirs: []); return }
        message = "Transcribing the other side of the call…"
        OxRunner.run(["video", "transcribe", audio.path], cwd: audio.deletingLastPathComponent()) { [weak self] code, out in
            // Lines like "[12.3s] what they said".
            let theirs: [(at: TimeInterval, text: String)] = out.split(separator: "\n").compactMap { line in
                guard let m = line.wholeMatch(of: #/\s*\[(\d+(?:\.\d+)?)s\]\s*(.+)/#) else { return nil }
                return (Double(String(m.1)) ?? 0, String(m.2))
            }
            // The call's audio and its subtitle file go once the words are in the notes.
            if code == 0 { try? FileManager.default.removeItem(at: audio); try? FileManager.default.removeItem(at: audio.deletingPathExtension().appendingPathExtension("transcript.srt")) }
            self?.write(started: started, mine: mine, theirs: theirs, theirsFailed: code != 0)
        }
    }

    private func write(started: Date, mine: [(at: TimeInterval, text: String)], theirs: [(at: TimeInterval, text: String)], theirsFailed: Bool = false) {
        let merged = (mine.map { ($0.at, "**You:** \($0.text)") } + theirs.map { ($0.at, "**Them:** \($0.text)") }).sorted { $0.0 < $1.0 }
        let transcript = merged.map { line in "\(Int(line.0) / 60):\(String(format: "%02d", Int(line.0) % 60))  \(line.1)" }.joined(separator: "\n\n")
        guard !transcript.isEmpty else { message = "Nothing was heard, so no notes were written."; return }
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("ox-notes/calls")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let stamp = DateFormatter(); stamp.dateFormat = "yyyy-MM-dd HH.mm.ss"
        let file = dir.appendingPathComponent("Call \(stamp.string(from: started)).md")
        let mins = max(1, Int(Date().timeIntervalSince(started) / 60))
        let sides = theirs.isEmpty ? (theirsFailed ? "your microphone; the other side could not be transcribed" : "your microphone") : "both sides: You from the microphone, Them from the call"
        let doc = "# Call, \(stamp.string(from: started)) (\(mins) min)\n\n## Transcript (\(sides))\n\n\(transcript)\n"
        try? doc.write(to: file, atomically: true, encoding: .utf8)
        message = "Transcript saved. Writing the summary…"
        // The summary, key points and to-dos, by your model, appended to the same file.
        let prompt = "Read the call transcript in \(file.path) (You is the person taking notes, Them is the other side). Reply in Markdown with exactly three sections: ## Summary (3-5 sentences), ## Key points (bullets), ## To-dos (checkboxes, with who: You or Them, if said). Use only what is in the transcript; if it is too short to summarise, say so."
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
