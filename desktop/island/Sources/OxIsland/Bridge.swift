import AppKit
import Combine
import Foundation

// Talks ox's IPC protocol (src/ipc.js): newline-delimited JSON over a Unix
// socket. ox -> island: hello, event, approval-request, approval-resolved.
// island -> ox: ready, approval-answer. Silence is always safe: if the island
// never answers, ox falls back to its terminal prompt and NEVER auto-allows.

enum Mood: Equatable {
    case sleeping          // no ox runs
    case idle              // run open, waiting for the human
    case thinking          // model is streaming
    case working(String)   // a tool is running
    case needsYou          // an approval is waiting
    case done              // the turn finished
    case error(String)
}

struct PendingApproval: Equatable {
    let id: String
    let tool: String
    let preview: String
    let deadline: Date
}

/// One delegated worker inside a run (ox's `subagent` tool), for the office view.
struct SubAgent: Identifiable, Equatable {
    enum Phase: Equatable { case starting, working, thinking, done, failed }
    let id: String
    var label: String
    var model: String = ""
    var phase: Phase = .starting
    var tool: String = ""
    var tokens: Int = 0
    var costUsd: Double = 0
    var endedAt: Date?
}

struct AgentSession: Identifiable, Equatable {
    let id: String          // socket path
    var cwd: String = ""
    var model: String = ""
    var bot: String = ""
    var mood: Mood = .idle
    var activity: String = "connected"
    var lastText: String = ""
    var tokensIn: Int = 0
    var tokensOut: Int = 0
    var costUsd: Double = 0
    var toolCount: Int = 0
    var pending: PendingApproval?
    var closedAt: Date?
    var agents: [SubAgent] = []
    /// The last OX Canvas the agent drew with `show_ui`.
    var canvas: CanvasNode?
    var canvasAt: Date?
    /// A spoken question is in flight on this run: collect the reply to speak it.
    var buddyAsk = false
    var buddyReply = ""

    var project: String {
        cwd.isEmpty ? "ox" : (cwd as NSString).lastPathComponent
    }
}

final class OxBridge: ObservableObject {
    @Published private(set) var sessions: [AgentSession] = []
    @Published var hovering = false
    /// True for the one launch animation at app start (LaunchScene).
    @Published var launching = true
    @Published var pinnedOpen = false

    private var connections: [String: SocketConnection] = [:]
    private var timer: Timer?

    /// OX Buddy: voice in, avatar talking out. Its changes redraw the island.
    let buddy: Buddy = MainActor.assumeIsolated { Buddy() }
    private var buddySink: AnyCancellable?

    /// The tray under the island (Tray.swift): which tool is open, and the tools.
    @Published var tray: TrayTab?
    /// Set by the panel: typing needs the panel to take keyboard focus.
    var trayChanged: ((TrayTab?) -> Void)?
    let chat = IslandChat()
    let shelf = Shelf()
    let focus = FocusTimer()
    let clips = ClipHistory()
    private var traySinks = Set<AnyCancellable>()

    var pendingSession: AgentSession? { sessions.first { $0.pending != nil } }
    /// A team at work is the moment the office exists for, so it opens by itself.
    var teamWorking: Bool { sessions.contains { $0.closedAt == nil && $0.agents.contains { $0.endedAt == nil } } }
    var expanded: Bool { hovering || pinnedOpen || pendingSession != nil || peeking || teamWorking || buddyActive }
    var buddyActive: Bool { MainActor.assumeIsolated { buddy.active } }

    /// The face the notch shows: the most urgent state across all runs.
    var headlineMood: Mood {
        if sessions.isEmpty { return .sleeping }
        if pendingSession != nil { return .needsYou }
        if let e = sessions.first(where: { if case .error = $0.mood { return true }; return false }) { return e.mood }
        if let w = sessions.first(where: { if case .working = $0.mood { return true }; return false }) { return w.mood }
        if sessions.contains(where: { $0.mood == .thinking }) { return .thinking }
        if sessions.contains(where: { $0.mood == .done }) { return .done }
        return .idle
    }

    private var dirWatch: DispatchSourceFileSystemObject?

    func start() {
        buddySink = MainActor.assumeIsolated { buddy.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() } }
        // The focus countdown shows in the wing, so its changes redraw the island too.
        focus.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &traySinks)
        $tray.sink { [weak self] t in self?.trayChanged?(t) }.store(in: &traySinks)
        clips.start()
        MainActor.assumeIsolated {
            buddy.send = { [weak self] text, shots, audio in
                guard let self else { return false }
                if self.ask(text, imagePaths: shots, audioPath: audio) { return true }
                // No live run: the chat takes it. Small tasks are done offline; the
                // rest runs ox with a model, whose approvals come to this island.
                guard OxRunner.available, !text.isEmpty else { return false }
                self.chat.send(text, bridge: self) { [weak self] reply in
                    MainActor.assumeIsolated { self?.buddy.speak(reply) }
                }
                return true
            }
        }
        scan()
        // Instant discovery: a new ox socket is a write to $TMPDIR. The slow
        // timer remains as a backstop and for expiring ended runs.
        let fd = open(NSTemporaryDirectory(), O_EVTONLY)
        if fd >= 0 {
            let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: .write, queue: .main)
            src.setEventHandler { [weak self] in self?.scan() }
            src.setCancelHandler { Darwin.close(fd) }
            src.resume()
            dirWatch = src
        }
        timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in self?.scan() }
    }

    func stop() {
        dirWatch?.cancel()
        timer?.invalidate()
        connections.values.forEach { $0.close() }
        connections.removeAll()
    }

    // MARK: discovery

    /// ox binds sockets at os.tmpdir()/ox-ipc-<id>.sock; NSTemporaryDirectory()
    /// is the same per-user $TMPDIR for a non-sandboxed app.
    private func scan() {
        let dir = NSTemporaryDirectory()
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
        for name in names where name.hasPrefix("ox-ipc-") && name.hasSuffix(".sock") {
            let path = (dir as NSString).appendingPathComponent(name)
            if connections[path] == nil { connect(path) }
        }
        // Forget runs that ended a few seconds ago.
        let now = Date()
        sessions.removeAll { s in s.closedAt.map { now.timeIntervalSince($0) > 6 } ?? false }
    }

    private func connect(_ path: String) {
        guard let conn = SocketConnection(path: path) else { return }
        connections[path] = conn
        conn.onLine = { [weak self] obj in self?.handle(path: path, frame: obj) }
        conn.onClose = { [weak self] in self?.closed(path: path) }
        conn.start()
        conn.send(["type": "ready", "clientId": "ox-island"])
    }

    // MARK: protocol

    private func update(_ path: String, _ change: (inout AgentSession) -> Void) {
        if let i = sessions.firstIndex(where: { $0.id == path }) {
            change(&sessions[i])
        } else {
            var s = AgentSession(id: path)
            change(&s)
            sessions.append(s)
        }
    }

    private func handle(path: String, frame: [String: Any]) {
        switch frame["type"] as? String {
        case "hello":
            update(path) { s in
                s.cwd = frame["cwd"] as? String ?? ""
                s.model = frame["model"] as? String ?? ""
                s.bot = frame["bot"] as? String ?? ""
                s.mood = .idle
                s.activity = "ready"
            }
        case "event":
            guard let ev = frame["event"] as? [String: Any] else { return }
            handleEvent(path: path, ev)
        case "approval-request":
            let id = frame["id"] as? String ?? ""
            let tool = frame["tool"] as? String ?? "tool"
            let preview = frame["argsPreview"] as? String ?? ""
            let deadlineMs = frame["deadlineAt"] as? Double ?? (Date().timeIntervalSince1970 * 1000 + 115_000)
            update(path) { s in
                s.pending = PendingApproval(id: id, tool: tool, preview: preview,
                                            deadline: Date(timeIntervalSince1970: deadlineMs / 1000))
                s.mood = .needsYou
                s.activity = "wants to run \(tool)"
            }
            NSSound(named: "Pop")?.play()
        case "approval-resolved":
            let id = frame["id"] as? String
            update(path) { s in
                if s.pending?.id == id { s.pending = nil; s.mood = .thinking }
            }
        default:
            break
        }
    }

    private func handleEvent(path: String, _ ev: [String: Any]) {
        let type = ev["type"] as? String ?? ""
        update(path) { s in
            switch type {
            case "text-delta":
                if s.buddyAsk { s.buddyReply += ev["text"] as? String ?? "" }
                let t = (s.lastText + (ev["text"] as? String ?? ""))
                s.lastText = String(t.suffix(240))
                if s.pending == nil { s.mood = .thinking; s.activity = "thinking" }
            case "tool-start":
                let name = ev["name"] as? String ?? "tool"
                s.lastText = "" // the next reply is a new message, not a continuation
                s.buddyReply = "" // only the final answer is spoken, not the narration
                s.toolCount += 1
                s.mood = .working(name)
                s.activity = Self.describe(tool: name, preview: ev["argsPreview"] as? String ?? "")
            case "tool-end":
                if (ev["isError"] as? Bool) == true { s.activity = "\(ev["name"] as? String ?? "tool") failed — recovering" }
                if ev["name"] as? String == "show_ui",
                   let canvas = ((ev["meta"] as? [String: Any])?["canvas"] as? [String: Any]).flatMap({ CanvasNode($0["tree"]) }) {
                    s.canvas = canvas
                    s.canvasAt = Date()
                    s.activity = "showing you a canvas"
                }
                if s.pending == nil { s.mood = .thinking }
            case "usage":
                s.tokensIn += ev["inputTokens"] as? Int ?? 0
                s.tokensOut += ev["outputTokens"] as? Int ?? 0
                s.costUsd += ev["costUsd"] as? Double ?? 0
            case "turn-end":
                let stop = ev["stopReason"] as? String ?? ""
                if !["tool_calls", "tool_use", "length"].contains(stop), s.pending == nil {
                    s.mood = .done
                    s.activity = "done — your turn"
                }
            case "final":
                s.mood = .done
                s.activity = "done"
            case "error":
                let msg = ev["error"] as? String ?? "error"
                if msg != "aborted" { s.mood = .error(msg); s.activity = msg }
            case "compaction":
                s.activity = "compacting context"
            case "subagent-spawn", "subagent-start":
                let id = ev["id"] as? String ?? UUID().uuidString
                let label = (ev["description"] as? String) ?? (ev["task"] as? String) ?? "subagent"
                if let i = s.agents.firstIndex(where: { $0.id == id }) {
                    if let m = ev["model"] as? String { s.agents[i].model = m }
                    s.agents[i].phase = .thinking
                } else {
                    s.agents.append(SubAgent(id: id, label: Self.shortLabel(label), model: ev["model"] as? String ?? "", phase: .starting))
                }
                s.activity = "\(s.agents.filter { $0.endedAt == nil }.count) agents working"
            case "subagent-progress":
                guard let id = ev["id"] as? String, let i = s.agents.firstIndex(where: { $0.id == id }) else { break }
                let tool = ev["currentTool"] as? String ?? ""
                s.agents[i].tool = tool
                s.agents[i].phase = tool.isEmpty ? .thinking : .working
            case "subagent-end", "subagent-cancelled":
                guard let id = ev["id"] as? String, let i = s.agents.firstIndex(where: { $0.id == id }) else { break }
                let status = ev["status"] as? String ?? ""
                // ox's terminal statuses: done | failed | cancelled.
                s.agents[i].phase = status == "done" ? .done : .failed
                s.agents[i].tokens = (ev["inputTokens"] as? Int ?? 0) + (ev["outputTokens"] as? Int ?? 0)
                s.agents[i].costUsd = ev["costUsd"] as? Double ?? 0
                if let m = ev["model"] as? String, !m.isEmpty { s.agents[i].model = m }
                s.agents[i].tool = ""
                s.agents[i].endedAt = Date()
            default:
                break
            }
        }
        // A spoken question's turn is over: the avatar says the answer.
        if type == "turn-end" || type == "final" || type == "error",
           let i = sessions.firstIndex(where: { $0.id == path }), sessions[i].buddyAsk {
            let stop = ev["stopReason"] as? String ?? ""
            if type != "turn-end" || !["tool_calls", "tool_use"].contains(stop) {
                let reply = type == "error" ? "Sorry, that run hit an error: \(ev["error"] as? String ?? "unknown")." : sessions[i].buddyReply
                sessions[i].buddyAsk = false
                sessions[i].buddyReply = ""
                MainActor.assumeIsolated { buddy.speak(reply) }
            }
        }
        // A fresh canvas is something the agent wants you to see: open for it.
        if type == "tool-end", ev["name"] as? String == "show_ui" { peek(for: 10) }
        // Surface endings without being asked: a finished or failed turn peeks.
        if let s = sessions.first(where: { $0.id == path }), s.pending == nil {
            if case .error = s.mood, type == "error" { peek(for: 6) }
            if s.mood == .done, type == "turn-end" || type == "final" { peek() }
        }
    }

    private func closed(path: String) {
        connections[path] = nil
        update(path) { s in
            s.pending = nil
            if case .error = s.mood {} else { s.mood = .done }
            s.activity = "session ended"
            s.closedAt = Date()
        }
        // A run that ends shows its finish (the ox grazes) without a hover.
        peek(for: 5)
    }

    // MARK: actions

    enum Decision: String { case allow, deny, always }

    func answer(_ session: AgentSession, _ decision: Decision) {
        guard let p = session.pending, let conn = connections[session.id] else { return }
        conn.send(["type": "approval-answer", "id": p.id, "decision": decision.rawValue])
        update(session.id) { s in
            s.pending = nil
            switch decision {
            case .deny:
                s.mood = .thinking
                s.activity = "you denied \(p.tool)"
            case .allow, .always:
                s.mood = .working(p.tool)
                s.activity = "running \(p.tool)"
            }
        }
    }

    // MARK: peek

    /// A run that finishes or fails opens the island briefly, then it settles.
    @Published private(set) var peekUntil: Date = .distantPast
    var peeking: Bool { Date() < peekUntil }

    /// A character was poked in the notch: open the island so its reaction shows.
    func showReaction() {
        peek(for: 4)
        objectWillChange.send()
    }

    private func peek(for seconds: TimeInterval = 4) {
        peekUntil = Date().addingTimeInterval(seconds)
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds + 0.05) { [weak self] in
            self?.objectWillChange.send()
        }
    }

    // Black and white like the app: sessions told apart by shade, not hue.
    static let palette = ["#FFFFFF", "#BDBDBD", "#8A8A8A", "#E2E2E2", "#A3A3A3", "#6F6F6F"]

    func color(of session: AgentSession) -> String {
        let i = sessions.firstIndex(where: { $0.id == session.id }) ?? 0
        return Self.palette[i % Self.palette.count]
    }

    /// Send a spoken question (and the screenshot) to the newest live run.
    /// False when no ox run is connected.
    func ask(_ text: String, imagePaths: [String], audioPath: String? = nil, voice: Bool = true) -> Bool {
        guard let s = sessions.last(where: { $0.closedAt == nil && $0.pending == nil }), let conn = connections[s.id] else { return false }
        var msg: [String: Any] = ["type": "user-message", "text": text, "imagePaths": imagePaths, "voice": voice]
        if let audioPath { msg["audioPath"] = audioPath }
        conn.send(msg)
        update(s.id) { s in
            s.buddyAsk = true
            s.buddyReply = ""
            s.activity = "you asked: \(Self.shortLabel(text))"
        }
        return true
    }

    /// "Answer in terminal": decline to decide; ox keeps its terminal prompt.
    func deferToTerminal(_ session: AgentSession) {
        guard let p = session.pending, let conn = connections[session.id] else { return }
        conn.send(["type": "approval-answer", "id": p.id, "decision": "ask"])
        update(session.id) { s in s.pending = nil; s.activity = "waiting in terminal" }
    }

    static func shortLabel(_ s: String) -> String {
        let one = s.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        return one.count > 26 ? String(one.prefix(25)) + "…" : one
    }

    /// The run whose canvas the island shows: the most recently drawn one.
    var canvasSession: AgentSession? {
        sessions.filter { $0.canvas != nil }.max { ($0.canvasAt ?? .distantPast) < ($1.canvasAt ?? .distantPast) }
    }

    /// The office (a team at work) or a canvas extends the expanded island.
    var hasExtraPanel: Bool { tray != nil || officeSession != nil || canvasSession != nil }

    /// Nothing to show but the ox: the island keeps its card to one line.
    var idleIsland: Bool { sessions.isEmpty && tray == nil && !buddyActive }

    /// Files dropped on the notch land on the shelf, and the shelf opens.
    func receive(_ urls: [URL]) {
        guard !urls.isEmpty else { return }
        shelf.add(urls)
        tray = .shelf
        pinnedOpen = true
    }

    /// The session whose team the office shows: the one with the most agents.
    var officeSession: AgentSession? {
        sessions.filter { !$0.agents.isEmpty }.max { $0.agents.count < $1.agents.count }
    }

    static func describe(tool: String, preview: String) -> String {
        let p = preview.replacingOccurrences(of: "\n", with: " ")
        let short = p.count > 60 ? String(p.prefix(57)) + "…" : p
        switch tool {
        case "read_file": return "reading \(short)"
        case "write_file": return "writing \(short)"
        case "edit_file": return "editing \(short)"
        case "bash": return "$ \(short)"
        case "grep", "glob", "list_dir": return "searching \(short)"
        case "web_fetch", "web_search": return "browsing \(short)"
        case "subagent": return "delegating to a subagent"
        default: return "\(tool) \(short)"
        }
    }
}

// MARK: - POSIX Unix-socket connection with a line reader

final class SocketConnection {
    let path: String
    private let fd: Int32
    private var closed = false
    private let lock = NSLock()
    var onLine: (([String: Any]) -> Void)?
    var onClose: (() -> Void)?

    init?(path: String) {
        self.path = path
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        guard bytes.count < capacity else { Darwin.close(fd); return nil }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        // A stale socket file (crashed run) refuses: skip it, ox cleans up.
        guard ok == 0 else { Darwin.close(fd); return nil }
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        self.fd = fd
    }

    func start() {
        let thread = Thread { [weak self] in self?.readLoop() }
        thread.name = "ox-island.reader"
        thread.start()
    }

    private func readLoop() {
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { break }
            buffer.append(chunk, count: n)
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: buffer.startIndex..<nl)
                buffer.removeSubrange(buffer.startIndex...nl)
                // Tolerant reader (protocol rule): a bad line is dropped.
                guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                DispatchQueue.main.async { [weak self] in self?.onLine?(obj) }
            }
            if buffer.count > 2 * 1024 * 1024 { buffer.removeAll() } // never grow unbounded
        }
        close()
        DispatchQueue.main.async { [weak self] in self?.onClose?() }
    }

    func send(_ obj: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        data.append(0x0A)
        lock.lock(); defer { lock.unlock() }
        guard !closed else { return }
        data.withUnsafeBytes { raw in
            var off = 0
            while off < raw.count {
                let w = write(fd, raw.baseAddress! + off, raw.count - off)
                if w <= 0 { break }
                off += w
            }
        }
    }

    func close() {
        lock.lock(); defer { lock.unlock() }
        guard !closed else { return }
        closed = true
        shutdown(fd, SHUT_RDWR)
        Darwin.close(fd)
    }
}
