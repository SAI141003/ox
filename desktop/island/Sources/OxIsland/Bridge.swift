import AppKit
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

    var project: String {
        cwd.isEmpty ? "ox" : (cwd as NSString).lastPathComponent
    }
}

final class OxBridge: ObservableObject {
    @Published private(set) var sessions: [AgentSession] = []
    @Published var hovering = false
    @Published var pinnedOpen = false

    private var connections: [String: SocketConnection] = [:]
    private var timer: Timer?

    var pendingSession: AgentSession? { sessions.first { $0.pending != nil } }
    var expanded: Bool { hovering || pinnedOpen || pendingSession != nil }

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
                let t = (s.lastText + (ev["text"] as? String ?? ""))
                s.lastText = String(t.suffix(240))
                if s.pending == nil { s.mood = .thinking; s.activity = "thinking" }
            case "tool-start":
                let name = ev["name"] as? String ?? "tool"
                s.toolCount += 1
                s.mood = .working(name)
                s.activity = Self.describe(tool: name, preview: ev["argsPreview"] as? String ?? "")
            case "tool-end":
                if (ev["isError"] as? Bool) == true { s.activity = "\(ev["name"] as? String ?? "tool") failed — recovering" }
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
            default:
                break
            }
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
    }

    // MARK: actions

    func answer(_ session: AgentSession, allow: Bool) {
        guard let p = session.pending, let conn = connections[session.id] else { return }
        conn.send(["type": "approval-answer", "id": p.id, "decision": allow ? "allow" : "deny"])
        update(session.id) { s in
            s.pending = nil
            s.mood = allow ? .working(p.tool) : .thinking
            s.activity = allow ? "running \(p.tool)" : "denied \(p.tool)"
        }
    }

    /// "Answer in terminal": decline to decide; ox keeps its terminal prompt.
    func deferToTerminal(_ session: AgentSession) {
        guard let p = session.pending, let conn = connections[session.id] else { return }
        conn.send(["type": "approval-answer", "id": p.id, "decision": "ask"])
        update(session.id) { s in s.pending = nil; s.activity = "waiting in terminal" }
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
