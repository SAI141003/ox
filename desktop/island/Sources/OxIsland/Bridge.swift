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
    /// An agent's multiple-choice question (Claude Code's AskUserQuestion), answered here.
    var question: String? = nil
    var options: [String] = []
    var multiSelect = false
    /// What the call would do, in plain words ("This touches production"), and how risky.
    var riskWhy: String? = nil
    var riskLevel: String? = nil
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
    /// The last few things it did (the home card's running list, newest last).
    var steps: [String] = []
    /// Which agent tool it is ("Claude Code", "Codex", "ox"…).
    var tool = "ox"

    mutating func note(_ step: String) {
        let s = step.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty, steps.last != s else { return }
        steps.append(s)
        if steps.count > 6 { steps.removeFirst(steps.count - 6) }
    }

    /// A stable colour per session (Coucou's per-project colours).
    var color: String {
        let palette = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9", "#FF5A4E", "#2EC4A0", "#F29B38", "#7C5CFF"]
        let sum = id.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFFFF }
        return palette[sum % palette.count]
    }

    var project: String {
        // A run from the app has no folder of its own: it is named by its bot.
        if cwd.isEmpty, id.hasPrefix("app:"), !bot.isEmpty { return bot }
        return cwd.isEmpty ? "ox" : (cwd as NSString).lastPathComponent
    }
}

final class OxBridge: ObservableObject {
    @Published private(set) var sessions: [AgentSession] = [] { didSet { IslandLayout.busy = !sessions.isEmpty } }
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
    @Published var tray: TrayTab? { didSet { IslandLayout.trayOpen = tray != nil; IslandLayout.officeOpen = tray == .office } }
    /// Set by the panel: typing needs the panel to take keyboard focus.
    var trayChanged: ((TrayTab?) -> Void)?
    var cardChanged: ((Bool) -> Void)?
    let chat = IslandChat()
    let shelf = Shelf()
    let focus = FocusTimer()
    let clips = ClipHistory()
    let player = NowPlaying()
    /// Unread mail from the Mail app (Coucou's mail in the notch).
    let mail = MailCenter()
    /// Dictation anywhere (⌃⌥D), « OK ox », call notes.
    let dictation: Dictation = MainActor.assumeIsolated { Dictation() }
    let wake: WakeWord = MainActor.assumeIsolated { WakeWord() }
    let notes: Notetaker = MainActor.assumeIsolated { Notetaker() }
    private var traySinks = Set<AnyCancellable>()

    var pendingSession: AgentSession? { sessions.first { $0.pending != nil } }
    /// A team at work is the moment the office exists for, so it opens by itself.
    var teamWorking: Bool { sessions.contains { $0.closedAt == nil && $0.agents.contains { $0.endedAt == nil } } }
    var expanded: Bool { hovering || pinnedOpen || pendingSession != nil || proposedHire != nil || peeking || teamWorking || buddyActive }
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
        // A session card has a message box: the island takes the keyboard while it is open.
        $card.map { $0?.id }.removeDuplicates().sink { [weak self] id in self?.cardChanged?(id != nil) }.store(in: &traySinks)
        clips.start()
        player.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &traySinks)
        player.start()
        MainActor.assumeIsolated {
            for o in [dictation.objectWillChange.eraseToAnyPublisher(), wake.objectWillChange.eraseToAnyPublisher(), notes.objectWillChange.eraseToAnyPublisher()] {
                o.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &traySinks)
            }
            dictation.willListen = { [weak self] in self?.wake.stop() }
            notes.willListen = { [weak self] in self?.wake.stop() }
            dictation.didFinish = { [weak self] in DispatchQueue.main.asyncAfter(deadline: .now() + 2) { MainActor.assumeIsolated { self?.wake.start() } } }
            wake.micBusy = { [weak self] in
                guard let self else { return true }
                return self.buddy.phase == .listening || self.dictation.phase == .listening || self.notes.recording
            }
            // What was asked after « OK ox » goes where ⌃⌥Space goes: island commands, a live run, or the chat.
            wake.onCommand = { [weak self] text in
                guard let self else { return }
                if self.buddy.send?(text, [], nil) != true { self.buddy.speak("I can't find ox on this Mac. Open the OX app once, then ask me again.") }
            }
            wake.start()
        }
        MainActor.assumeIsolated {
            buddy.send = { [weak self] raw, shots, audio in
                guard let self else { return false }
                // "Pixie, play Billie Jean": the name is how you called it, not the request.
                var text = Self.withoutName(raw)
                IslandLog.write("request: \"\(raw)\" → \"\(text)\" (live run: \(self.hasLiveRun))")
                if let part = self.islandPart(text) {
                    guard let rest = part.rest else { MainActor.assumeIsolated { self.buddy.speak(part.said) }; return true }
                    IslandLog.write("island did: \(part.said) · passing on: \(rest)")
                    text = rest
                }
                // Hey Clicky's "write it for me": text into the box you are typing in.
                if let w = Self.writeIntent(text) {
                    self.writeForMe(w, request: text, shot: shots.first)
                    return true
                }
                // With a coding run open, an errand ("play Billie Jean", "volume
                // down") is still done offline first: it never lands in that run.
                if self.hasLiveRun {
                    VoiceServer.ask(text, offlineOnly: true) { [weak self] r in
                        guard let self else { return }
                        if let r, r.handled { IslandLog.write("offline (live run open): \(r.say ?? "")"); MainActor.assumeIsolated { self.buddy.speak(r.say ?? "Done.") }; return }
                        if !self.ask(text, imagePaths: shots, audioPath: audio) { self.chat.send(text, bridge: self) { reply in MainActor.assumeIsolated { self.buddy.speak(reply) } } }
                    }
                    return true
                }
                // No live run: the chat takes it. Small tasks are done offline; the
                // rest runs ox with a model, whose approvals come to this island.
                guard OxRunner.available, !text.isEmpty else { return false }
                self.chat.send(text, bridge: self) { [weak self] reply in
                    MainActor.assumeIsolated { self?.buddy.speak(reply) }
                }
                return true
            }
        }
        // Test hook: the same path as speaking ("say" a sentence to the island).
        //   swift -e 'import Foundation; DistributedNotificationCenter.default().postNotificationName(.init("dev.ox.island.say"), object: "open whatsapp", deliverImmediately: true)'
        // Press the island's mic button (checks of the real voice path, end to end).
        DistributedNotificationCenter.default().addObserver(forName: .init("dev.ox.island.listen"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.buddy.toggle() }
        }
        // Open the island for a few seconds (checks and screenshots): object = seconds, default 6.
        DistributedNotificationCenter.default().addObserver(forName: .init("dev.ox.island.peek"), object: nil, queue: .main) { [weak self] n in
            self?.peek(for: Double((n.object as? String) ?? "") ?? 6)
            self?.objectWillChange.send()
        }
        DistributedNotificationCenter.default().addObserver(forName: .init("dev.ox.island.say"), object: nil, queue: .main) { [weak self] n in
            guard let self, let text = n.object as? String, !text.isEmpty else { return }
            IslandLog.write("test say: \(text)")
            MainActor.assumeIsolated { _ = self.buddy.send?(text, [], nil) }
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
    /// The temp folder's modification time at the last listing: it changes only
    /// when a file is added or removed, so an unchanged folder is not listed again.
    private var tmpStamp = timespec()

    /// New ox runs' sockets in the temp folder. The folder can hold thousands of
    /// files, so it is listed only when it changed, with readdir, comparing the
    /// "ox-ipc-" prefix before making any string (this was most of the island's idle CPU).
    private func newSockets() -> [String] {
        let dir = NSTemporaryDirectory()
        var st = stat()
        guard stat(dir, &st) == 0 else { return [] }
        if st.st_mtimespec.tv_sec == tmpStamp.tv_sec && st.st_mtimespec.tv_nsec == tmpStamp.tv_nsec { return [] }
        tmpStamp = st.st_mtimespec
        guard let d = opendir(dir) else { return [] }
        defer { closedir(d) }
        var out: [String] = []
        while let e = readdir(d) {
            let name: String? = withUnsafePointer(to: &e.pointee.d_name) { p in
                p.withMemoryRebound(to: CChar.self, capacity: 256) { c in
                    strncmp(c, "ox-ipc-", 7) == 0 ? String(cString: c) : nil
                }
            }
            if let name, name.hasSuffix(".sock") { out.append((dir as NSString).appendingPathComponent(name)) }
        }
        return out
    }

    /// Sockets seen in the temp folder; one not connected yet (its run still
    /// starting) is tried again on each scan until it answers or its file is gone.
    private var knownSockets = Set<String>()

    private func scan() {
        readBrowse()
        knownSockets.formUnion(newSockets())
        for path in knownSockets where connections[path] == nil {
            if FileManager.default.fileExists(atPath: path) { connect(path) } else { knownSockets.remove(path) }
        }
        // Forget runs that ended a few seconds ago.
        let now = Date()
        let gone: (AgentSession) -> Bool = { s in s.closedAt.map { now.timeIntervalSince($0) > 6 } ?? false }
        if sessions.contains(where: gone) { sessions.removeAll(where: gone) }
        pollApp()
    }

    // MARK: the app's runs (ox serve)

    /// Chats, bots and their helpers running in ox's app have no socket: the
    /// app server says where it is (~/.ox/serve.json) and reports every run on
    /// /ox/live, the same board its Office page shows. Read-only here.
    private var appPolling = false
    private var usagePolledAt = Date.distantPast

    /// Today's tokens across every surface (Settings › Usage in the app), for the
    /// meter the idle island shows. Nil until the app server has answered.
    struct Today: Equatable { let tokens: Int; let runs: Int; let cost: Double?; let topModel: String }
    @Published private(set) var today: Today?

    private func pollUsage(port: Int) {
        guard Date().timeIntervalSince(usagePolledAt) > 30, let url = URL(string: "http://127.0.0.1:\(port)/ox/usage?days=1") else { return }
        usagePolledAt = Date()
        var req = URLRequest(url: url)
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            guard (resp as? HTTPURLResponse)?.statusCode == 200,
                  let doc = data.flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }),
                  let total = doc["total"] as? [String: Any] else { return }
            let tokens = ((total["in"] as? Int) ?? 0) + ((total["out"] as? Int) ?? 0)
            let top = ((doc["byModel"] as? [[String: Any]])?.first?["key"] as? String) ?? ""
            let t = Today(tokens: tokens, runs: total["runs"] as? Int ?? 0, cost: total["cost"] as? Double, topModel: top)
            DispatchQueue.main.async { if self?.today != t { self?.today = t } }
        }.resume()
    }

    /// The AI tools on this Mac (Coucou's agent pills): plans and agent CLIs with
    /// their real state, local models, Hermes. From the app server's cache.
    struct ConnectedTool: Identifiable, Equatable { let id: String; let name: String; let via: String; let ready: Bool; let fix: String? }
    @Published private(set) var connected: [ConnectedTool] = []
    private var connectedPolledAt = Date.distantPast

    /// Plan usage (Coucou's gauges): the most-used window of each plan.
    struct PlanGauge: Identifiable, Equatable { let id: String; let label: String; let window: String; let percent: Double; let resetsAt: Date? }
    @Published private(set) var gauges: [PlanGauge] = []
    private var gaugesPolledAt = Date.distantPast

    private func pollGauges(port: Int) {
        guard Date().timeIntervalSince(gaugesPolledAt) > 60, let url = URL(string: "http://127.0.0.1:\(port)/ox/plan-usage") else { return }
        gaugesPolledAt = Date()
        var req = URLRequest(url: url)
        req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            guard (resp as? HTTPURLResponse)?.statusCode == 200,
                  let doc = data.flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }),
                  let plans = doc["plans"] as? [[String: Any]] else { return }
            let gs = plans.compactMap { p -> PlanGauge? in
                guard let id = p["id"] as? String, let windows = p["windows"] as? [[String: Any]], !windows.isEmpty else { return nil }
                let top = windows.max { (($0["usedPercent"] as? Double) ?? 0) < (($1["usedPercent"] as? Double) ?? 0) } ?? windows[0]
                let reset = (top["resetsAt"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) }
                return PlanGauge(id: id, label: Self.planLabel(id), window: top["name"] as? String ?? "", percent: (top["usedPercent"] as? Double) ?? 0, resetsAt: reset)
            }
            DispatchQueue.main.async { if self?.gauges != gs { self?.gauges = gs } }
        }.resume()
    }

    /// The plan a gauge belongs to, by its id ("codex" is the ChatGPT plan).
    static func planLabel(_ id: String) -> String {
        switch id.lowercased() {
        case "codex", "chatgpt", "openai": return "ChatGPT"
        case "claude", "anthropic": return "Claude"
        case "gemini", "google": return "Gemini"
        case "cursor": return "Cursor"
        case "copilot", "github": return "Copilot"
        default: return id.prefix(1).uppercased() + id.dropFirst()
        }
    }

    // MARK: the company of agents (ox org, after Paperclip)

    struct OrgAgent: Identifiable, Equatable {
        let id: String; let name: String; let title: String; let runtime: String; let status: String
        let why: String?; let hiredBy: String; let spent: Double; let budget: Double?; let next: String?
        /// KODEMON's levels, from real work: tasks finished and tool calls that went through (src/org.js levels()).
        var level: Int = 1; var xp: Int = 0; var nextXp: Int = 50
    }
    /// When each agent last levelled up: its pill shows "Lv↑" for a minute.
    @Published private(set) var levelUps: [String: Date] = [:]
    @Published private(set) var org: [OrgAgent] = []
    private var orgPolledAt = Date.distantPast
    var proposedHire: OrgAgent? { org.first { $0.status == "proposed" } }

    private func pollOrg(port: Int) {
        guard Date().timeIntervalSince(orgPolledAt) > 10, let url = URL(string: "http://127.0.0.1:\(port)/ox/org") else { return }
        orgPolledAt = Date()
        var req = URLRequest(url: url)
        req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            guard (resp as? HTTPURLResponse)?.statusCode == 200,
                  let doc = data.flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }),
                  let rows = doc["agents"] as? [[String: Any]] else { return }
            let list = rows.compactMap { r -> OrgAgent? in
                guard let id = r["id"] as? String else { return nil }
                return OrgAgent(id: id, name: r["name"] as? String ?? id, title: r["title"] as? String ?? "", runtime: r["runtime"] as? String ?? "ox",
                                status: r["status"] as? String ?? "active", why: r["why"] as? String, hiredBy: r["hiredBy"] as? String ?? "you",
                                spent: r["spent"] as? Double ?? 0, budget: r["budget"] as? Double, next: r["next"] as? String,
                                level: r["level"] as? Int ?? 1, xp: r["xp"] as? Int ?? 0, nextXp: r["nextXp"] as? Int ?? 50)
            }
            DispatchQueue.main.async {
                let had = self?.proposedHire?.id
                let before = Dictionary(uniqueKeysWithValues: (self?.org ?? []).map { ($0.id, $0.level) })
                self?.org = list
                // A level up is a small celebration: the island opens, a chime, "Lv↑" on the pill.
                let ups = list.filter { a in before[a.id].map { a.level > $0 } ?? false }
                if !ups.isEmpty {
                    for a in ups { self?.levelUps[a.id] = Date(); IslandLog.write("level up: \(a.name) is now Lv \(a.level) (\(a.xp) XP)") }
                    self?.peek(for: 6); IslandSound.play("glass")
                }
                // A hire waiting for you is a decision: the island opens for it.
                if let p = self?.proposedHire, p.id != had { self?.peek(for: 8); IslandSound.play("pop") }
            }
        }.resume()
    }

    /// approve / reject a proposed hire, wake / pause / resume an agent.
    func org(_ action: String, _ id: String) {
        post("/ox/org/\(action)", ["id": id]) { [weak self] _ in
            IslandLog.write("org \(action): \(id)")
            self?.orgPolledAt = .distantPast
            if let port = self?.appPort { self?.pollOrg(port: port) }
        }
    }

    @Published var orgCard: String?

    // MARK: the fast browser (ox browse, web_task): the live run, read from ~/.ox/browse/live.json

    struct BrowseRun: Equatable {
        let goal: String
        let host: String
        let title: String
        let status: String          // running | done | blocked | stopped | failed
        let reason: String?
        let startedAt: Date
        let elapsedMs: Int
        let steps: [String]
        let at: Date
        var running: Bool { status == "running" && Date().timeIntervalSince(at) < 90 }
    }
    @Published private(set) var browse: BrowseRun?

    private func readBrowse() {
        let f = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ox/browse/live.json")
        guard let data = try? Data(contentsOf: f), let run = Self.parseBrowse(data) else { if browse != nil { browse = nil }; return }
        // A finished run stays on the island for 25 seconds, then leaves.
        let show = run.running || Date().timeIntervalSince(run.at) < 25
        let next = show ? run : nil
        // Open briefly when a run starts and when it ends, so its card is seen.
        if let n = next, n.status != browse?.status || n.startedAt != browse?.startedAt { peek(for: n.running ? 4 : 6) }
        if next != browse { browse = next }
    }

    static func parseBrowse(_ data: Data) -> BrowseRun? {
        guard let d = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let at = d["at"] as? Double else { return nil }
        return BrowseRun(
            goal: d["goal"] as? String ?? "", host: d["host"] as? String ?? "", title: d["title"] as? String ?? "", status: d["status"] as? String ?? "running",
            reason: d["reason"] as? String, startedAt: Date(timeIntervalSince1970: (d["startedAt"] as? Double ?? at) / 1000),
            elapsedMs: d["elapsedMs"] as? Int ?? 0, steps: ((d["steps"] as? [[String: Any]]) ?? []).compactMap { $0["chip"] as? String },
            at: Date(timeIntervalSince1970: at / 1000))
    }

    // MARK: the day strip: next event, weather, your pull requests (GET /ox/day)

    struct DayInfo: Equatable {
        var event: (title: String, at: Date)?
        var weather: (tempC: Int, text: String, place: String?)?
        var prs: (open: Int, failing: Int, url: String?)?
        var vercel: (state: String, name: String, url: String?)?
        var cal: (title: String, with: String?, at: Date)?
        var n8n: (failed: Int, workflows: [String], url: String)?
        static func == (a: DayInfo, b: DayInfo) -> Bool { a.event?.title == b.event?.title && a.weather?.tempC == b.weather?.tempC && a.prs?.open == b.prs?.open && a.prs?.failing == b.prs?.failing && a.vercel?.state == b.vercel?.state && a.cal?.title == b.cal?.title && a.n8n?.failed == b.n8n?.failed }
    }
    @Published private(set) var day = DayInfo()
    private var dayPolledAt = Date.distantPast

    private func pollDay(port: Int) {
        guard Date().timeIntervalSince(dayPolledAt) > 300, let url = URL(string: "http://127.0.0.1:\(port)/ox/day") else { return }
        dayPolledAt = Date()
        var req = URLRequest(url: url)
        req.timeoutInterval = 30
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            guard (resp as? HTTPURLResponse)?.statusCode == 200,
                  let doc = data.flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }) else { return }
            var d = DayInfo()
            if let e = doc["event"] as? [String: Any], let t = e["title"] as? String, let at = e["at"] as? String {
                let f = ISO8601DateFormatter(); f.formatOptions = [.withFullDate, .withTime, .withColonSeparatorInTime, .withDashSeparatorInDate]
                if let date = f.date(from: at) ?? ISO8601DateFormatter().date(from: at) { d.event = (t, date) }
            }
            if let w = doc["weather"] as? [String: Any], let c = w["tempC"] as? Int { d.weather = (c, w["text"] as? String ?? "", w["place"] as? String) }
            if let p = doc["prs"] as? [String: Any], let o = p["open"] as? Int {
                let first = (p["list"] as? [[String: Any]])?.first?["url"] as? String
                d.prs = (o, p["failing"] as? Int ?? 0, first)
            }
            if let v = doc["vercel"] as? [String: Any], let st = v["state"] as? String { d.vercel = (st, v["name"] as? String ?? "Vercel", v["url"] as? String) }
            if let c = doc["cal"] as? [String: Any], let t = c["title"] as? String, let s = c["start"] as? String,
               let at = ISO8601DateFormatter.withFractions.date(from: s) ?? ISO8601DateFormatter().date(from: s) { d.cal = (t, c["with"] as? String, at) }
            if let n = doc["n8n"] as? [String: Any], let f = n["failed"] as? Int, let u = n["url"] as? String { d.n8n = (f, n["workflows"] as? [String] ?? [], u) }
            DispatchQueue.main.async { if self?.day != d { self?.day = d } }
        }.resume()
    }

    // MARK: your machines (ox mesh): alerts with choices, never actions

    struct MeshOption: Equatable { let label: String; let action: String; let model: String?; let to: String? }
    struct MeshAlert: Identifiable, Equatable { let id: String; let machine: String; let kind: String; let text: String; let options: [MeshOption] }
    struct MeshMachine: Identifiable, Equatable { let id: String; let name: String; let up: Bool; let load: Double?; let mem: Double? }
    @Published private(set) var meshAlerts: [MeshAlert] = []
    @Published private(set) var meshMachines: [MeshMachine] = []
    @Published var meshNote: String?
    private var meshPolledAt = Date.distantPast
    // Dismissed alerts stay quiet while the server continues reporting the
    // same condition. They become eligible again after the condition clears.
    private var dismissedMeshAlerts: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "mesh.dismissedAlerts") ?? [])

    private func saveDismissedMeshAlerts() {
        UserDefaults.standard.set(Array(dismissedMeshAlerts), forKey: "mesh.dismissedAlerts")
    }

    func dismissMesh(_ alert: MeshAlert) {
        dismissedMeshAlerts.insert(alert.id)
        saveDismissedMeshAlerts()
        meshAlerts.removeAll { $0.id == alert.id }
        meshPolledAt = Date()
        IslandLog.write("mesh alert dismissed: \(alert.id)")
    }

    private func pollMesh(port: Int) {
        guard Date().timeIntervalSince(meshPolledAt) > 10, let url = URL(string: "http://127.0.0.1:\(port)/ox/mesh") else { return }
        meshPolledAt = Date()
        var req = URLRequest(url: url)
        req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            guard (resp as? HTTPURLResponse)?.statusCode == 200,
                  let doc = data.flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }) else { return }
            let alerts = ((doc["alerts"] as? [[String: Any]]) ?? []).compactMap { a -> MeshAlert? in
                guard let id = a["id"] as? String, let text = a["text"] as? String else { return nil }
                let opts = ((a["options"] as? [[String: Any]]) ?? []).map {
                    MeshOption(label: $0["label"] as? String ?? "", action: $0["action"] as? String ?? "", model: $0["model"] as? String, to: $0["to"] as? String)
                }
                return MeshAlert(id: id, machine: a["machine"] as? String ?? "", kind: a["kind"] as? String ?? "", text: text, options: opts)
            }
            let machines = ((doc["peers"] as? [[String: Any]]) ?? []).compactMap { p -> MeshMachine? in
                guard let id = p["id"] as? String else { return nil }
                let live = p["live"] as? [String: Any]
                let stats = live?["stats"] as? [String: Any]
                return MeshMachine(id: id, name: p["name"] as? String ?? id, up: stats != nil && (live?["error"] as? String) == nil,
                                   load: stats?["load"] as? Double, mem: stats?["mem"] as? Double)
            }
            DispatchQueue.main.async {
                let had = Set(self?.meshAlerts.map(\.id) ?? [])
                let currentIDs = Set(alerts.map(\.id))
                // Forget old suppressions once the backend no longer reports
                // them, allowing a genuinely new occurrence to notify again.
                self?.dismissedMeshAlerts = self?.dismissedMeshAlerts.filter { currentIDs.contains($0) } ?? []
                self?.saveDismissedMeshAlerts()
                let visible = alerts.filter { !(self?.dismissedMeshAlerts.contains($0.id) ?? false) }
                self?.meshAlerts = visible
                self?.meshMachines = machines
                // A new alert is a decision for you: the island opens for it.
                if visible.contains(where: { !had.contains($0.id) }) { self?.peek(for: 8); IslandSound.play("pop") }
            }
        }.resume()
    }

    /// 1234 → "1.2k", 747000 → "747k".
    static func tokenText(_ n: Int) -> String {
        n >= 1_000_000 ? String(format: "%.1fM", Double(n) / 1_000_000) : n >= 10_000 ? "\(n / 1000)k" : n >= 1000 ? String(format: "%.1fk", Double(n) / 1000) : "\(n)"
    }

    // MARK: ox updates itself (src/self-update.js, Coucou's self-update)

    /// What the notch says about updates: ask once, a new version, the steps while it updates, the result.
    struct UpdateCard: Equatable {
        enum Kind: Equatable { case ask, available, working, done, failed }
        let kind: Kind
        let title: String
        let detail: String
    }
    @Published private(set) var updateCard: UpdateCard?
    private var updatePolledAt = Date.distantPast
    private var updateWatching = false

    private func pollUpdate(port: Int) {
        guard Date().timeIntervalSince(updatePolledAt) > (updateWatching ? 1.5 : 600), let url = URL(string: "http://127.0.0.1:\(port)/ox/update") else { return }
        updatePolledAt = Date()
        URLSession.shared.dataTask(with: url) { [weak self] data, resp, _ in
            guard (resp as? HTTPURLResponse)?.statusCode == 200,
                  let doc = data.flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }) else { return }
            var card: UpdateCard?
            // While updating, and the result after (also in the new island the update restarted), until OK.
            if let a = doc["applying"] as? [String: Any], let steps = a["steps"] as? [String], (a["done"] as? Bool) != true || Date().timeIntervalSince1970 * 1000 - ((a["at"] as? Double) ?? 0) < 30 * 60_000 {
                if (a["done"] as? Bool) == true {
                    let ok = (a["ok"] as? Bool) == true
                    card = ok ? UpdateCard(kind: .done, title: "ox is up to date", detail: (doc["updatedTo"] as? String).map { "Now on \($0). Your settings and keys stay." } ?? "Your settings and keys stay.")
                              : UpdateCard(kind: .failed, title: "The update did not go in", detail: a["why"] as? String ?? "ox stayed as it was.")
                } else { card = UpdateCard(kind: .working, title: steps.last ?? "Updating", detail: "Checked before anything: ox's own GitHub, a fast-forward, the new code loads.") }
            } else if let n = doc["notice"] as? [String: Any] {
                if (n["kind"] as? String) == "ask" {
                    card = UpdateCard(kind: .ask, title: "Keep ox updated from the notch?", detail: "Auto-update installs only verified fast-forward updates from Ox's GitHub. Your changes are never overwritten.")
                } else if (n["kind"] as? String) == "update", let count = n["count"] as? Int {
                    let first = ((n["subjects"] as? [String]) ?? []).first.map { String($0.drop { $0 != " " }.dropFirst()) } ?? ""
                    card = UpdateCard(kind: .available, title: "\(count) update\(count == 1 ? "" : "s") for ox", detail: first.isEmpty ? "New from GitHub." : "Newest: \(first)")
                }
            }
            DispatchQueue.main.async {
                guard let self else { return }
                let was = self.updateCard
                if card != was { self.updateCard = card }
                // A new question or a new version opens the island, once (Coucou's "then he tells you").
                if let card, card.kind == .ask || card.kind == .available, was?.kind != card.kind { self.peek(for: 10) }
                if card?.kind == .done || card?.kind == .failed { self.updateWatching = false }
            }
        }.resume()
    }

    /// Your answer on the update card: only this updates anything.
    func updateChoose(_ action: String) {
        switch action {
        case "allow", "deny", "later", "ok", "auto":
            updateCard = nil
            post("/ox/update", ["action": action]) { _ in }
        case "apply":
            updateWatching = true
            updateCard = UpdateCard(kind: .working, title: "Checking the update", detail: "Checked before anything: ox's own GitHub, a fast-forward, the new code loads.")
            post("/ox/update", ["action": "apply"]) { [weak self] _ in DispatchQueue.main.async { self?.updatePolledAt = .distantPast } }
        case "whatsnew":
            if let url = URL(string: "https://github.com/SAI141003/ox/commits/main") { NSWorkspace.shared.open(url) }
        default:
            updateCard = nil
        }
        IslandLog.write("update choice: \(action)")
    }

    /// Your choice on an alert: only this runs anything, and only what it names.
    func meshChoose(_ alert: MeshAlert, _ option: MeshOption) {
        var o: [String: Any] = ["label": option.label, "action": option.action]
        if let m = option.model { o["model"] = m }
        if let t = option.to { o["to"] = t }
        // Choosing an action is also a dismissal. Do not immediately poll and
        // redisplay the same heavy-load warning before the action can work.
        dismissMesh(alert)
        post("/ox/mesh/choose", ["alert": alert.id, "option": o]) { [weak self] out in
            let said = (out?["done"] as? String) ?? (out?["note"] as? String) ?? (out?["error"] as? [String: Any])?["message"] as? String
            IslandLog.write("mesh choice on \(alert.id): \(option.label) → \(said ?? "?")")
            DispatchQueue.main.async { self?.meshNote = said }
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { self?.meshNote = nil }
        }
    }

    private func pollConnected(port: Int) {
        guard Date().timeIntervalSince(connectedPolledAt) > 60, let url = URL(string: "http://127.0.0.1:\(port)/ox/connected") else { return }
        connectedPolledAt = Date()
        var req = URLRequest(url: url)
        req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            guard (resp as? HTTPURLResponse)?.statusCode == 200,
                  let doc = data.flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }),
                  let rows = doc["tools"] as? [[String: Any]] else { return }
            let tools = rows.compactMap { r -> ConnectedTool? in
                guard let id = r["id"] as? String, let name = r["name"] as? String else { return nil }
                return ConnectedTool(id: id, name: name, via: r["via"] as? String ?? "", ready: (r["state"] as? String) == "ready", fix: r["fix"] as? String)
            }
            DispatchQueue.main.async { if self?.connected != tools { self?.connected = tools } }
        }.resume()
    }

    /// No ox server alive (after a restart, or OX.app quit): sessions, plan usage
    /// and the day strip would stay empty until someone opened OX.app, so the
    /// island starts `ox serve` itself, on a free loopback port, at most once a minute.
    private var serverStartedAt = Date.distantPast
    private func startServerIfNeeded() {
        guard Date().timeIntervalSince(serverStartedAt) > 60, let ox = OxRunner.paths() else { return }
        serverStartedAt = Date()
        let port = Self.freePort() ?? 47_802
        let p = Process()
        p.executableURL = URL(fileURLWithPath: ox.node)
        p.arguments = [ox.cli, "serve", "--port", "\(port)"]
        // Marked as the island's: after an ox update it steps aside and the island starts a fresh one.
        p.environment = ProcessInfo.processInfo.environment.merging(["OX_ISLAND_SERVER": "1"]) { _, new in new }
        p.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        let log = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ox/island-serve.log")
        FileManager.default.createFile(atPath: log.path, contents: nil)
        if let h = try? FileHandle(forWritingTo: log) { p.standardOutput = h; p.standardError = h }
        do { try p.run(); IslandLog.write("started ox serve on port \(port) (pid \(p.processIdentifier))") }
        catch { IslandLog.write("could not start ox serve: \(error.localizedDescription)") }
    }

    /// A port nothing listens on: bind to port 0 on loopback and read what was given.
    static func freePort() -> Int? {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var addr = sockaddr_in(); addr.sin_family = sa_family_t(AF_INET); addr.sin_port = 0; addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let ok = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) == 0 && getsockname(fd, $0, &len) == 0 } }
        return ok ? Int(UInt16(bigEndian: addr.sin_port)) : nil
    }

    private func pollApp() {
        guard !appPolling else { return }
        // The app's server says where it is in serve.json (`ox serve`) or app.json
        // (OX.app); a file whose process is gone is skipped.
        let home = FileManager.default.homeDirectoryForCurrentUser
        let docs = ["serve.json", "app.json"].compactMap { name -> [String: Any]? in
            guard let data = try? Data(contentsOf: home.appendingPathComponent(".ox/\(name)")),
                  let doc = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            if let pid = doc["pid"] as? Int, kill(pid_t(pid), 0) != 0 { return nil }
            return doc
        }
        guard let port = docs.compactMap({ $0["port"] as? Int }).first,
              let url = URL(string: "http://127.0.0.1:\(port)/ox/live") else { appPort = nil; dropAppSessions(keep: []); startServerIfNeeded(); return }
        appPort = port
        Dictation.serverPort = port
        if Dictation.contextWords.isEmpty { Dictation.refreshContextWords() }
        pollUsage(port: port)
        pollConnected(port: port)
        pollGauges(port: port)
        pollOrg(port: port)
        pollMesh(port: port)
        pollUpdate(port: port)
        pollDay(port: port)
        appPolling = true
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.2
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            let runs = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })?["runs"] as? [[String: Any]]
            DispatchQueue.main.async {
                guard let self else { return }
                self.appPolling = false
                guard (resp as? HTTPURLResponse)?.statusCode == 200, let runs else { self.dropAppSessions(keep: []); return }
                self.mergeApp(runs)
            }
        }.resume()
    }

    /// The app server's port, once found (sessions of other agents are read through it).
    private(set) var appPort: Int?

    // MARK: a session's card: its conversation, a message box, Open in Terminal

    struct CardLine: Identifiable, Equatable { let id = UUID(); let mine: Bool; let text: String }
    struct SessionCard: Equatable {
        let id: String            // the island's session id
        var lines: [CardLine] = []
        var canSend = true
        var note = ""
        var busy = false
    }
    /// The session the home card shows (tap a pill to change it; nil = the most urgent).
    @Published var focusId: String?

    /// A narrated step shown under the closed notch (Vovy's step line): only
    /// events marked `narrate` (ox make's steps), so ordinary tool calls never
    /// scroll past. Cleared a few seconds after its last change.
    struct Ticker: Equatable {
        let text: String; let done: Bool; let sessionId: String; let at: Date
        /// A race line ("Claude Code 3m 12s · test fails   |   Codex 3m 05s") is one row per lane.
        var lanes: [String] { text.components(separatedBy: "   |   ").filter { !$0.isEmpty } }
    }
    @Published var ticker: Ticker? { didSet { IslandLayout.tickerOn = ticker != nil; IslandLayout.tickerRows = max(1, ticker?.lanes.count ?? 1) } }
    func showTicker(_ text: String, done: Bool, session: String) {
        let t = Ticker(text: text, done: done, sessionId: session, at: Date())
        ticker = t
        DispatchQueue.main.asyncAfter(deadline: .now() + (done ? 5 : 12)) { [weak self] in if self?.ticker == t { self?.ticker = nil } }
    }
    var focused: AgentSession? {
        if let p = pendingSession { return p }
        if let id = focusId, let s = sessions.first(where: { $0.id == id }) { return s }
        let rank: (AgentSession) -> Int = { s in
            switch s.mood { case .needsYou: return 0; case .error: return 1; case .working: return 2; case .thinking: return 3; case .done: return 4; default: return 5 }
        }
        return sessions.min { (rank($0), -($0.steps.count)) < (rank($1), -($1.steps.count)) }
    }

    @Published var card: SessionCard? { didSet { IslandLayout.cardOpen = card != nil } }

    /// Each session's own character, the same every time (the pixel cast).
    static func character(for id: String) -> String {
        let sum = id.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFFFF }
        return PixelCast.helpers[sum % PixelCast.helpers.count]
    }

    /// "ext:claude:<id>" for another agent's session, nil for ox's own runs.
    static func externalId(_ sessionId: String) -> String? {
        sessionId.hasPrefix("app:ext:") ? String(sessionId.dropFirst(4)) : nil
    }

    private func post(_ path: String, _ body: [String: Any], done: @escaping ([String: Any]?) -> Void) {
        guard let port = appPort, let url = URL(string: "http://127.0.0.1:\(port)\(path)") else { done(nil); return }
        var req = URLRequest(url: url, timeoutInterval: 25 * 60)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req) { data, _, _ in
            let j = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async { done(j) }
        }.resume()
    }

    // MARK: write it for me (Hey Clicky)

    enum WriteKind: Equatable { case text, prompt }

    /// "write a reply saying I'll be there at 6", "draft an email to Sam about
    /// Friday", "type a good follow-up prompt": text to paste where you type.
    static func writeIntent(_ raw: String) -> WriteKind? {
        let t = raw.lowercased()
        // Email/message delivery is an action, not "write this into the
        // focused box". The old matcher caught phrases such as "write an
        // email, then send it to Sam" and silently pasted text instead of
        // routing it to the approved mail/message tool.
        if t.range(of: #"\b(?:e-?mail|mail)\b"#, options: .regularExpression) != nil,
           t.range(of: #"\b(?:to|send|draft|compose|from|subject|recipient)\b"#, options: .regularExpression) != nil { return nil }
        if t.range(of: #"\b(?:text|message|sms|imessage|whatsapp)\b"#, options: .regularExpression) != nil,
           t.range(of: #"\b(?:to|send|contact|recipient)\b"#, options: .regularExpression) != nil { return nil }
        if t.range(of: #"^(?:please\s+)?(?:can you\s+)?(?:write|type|draft|give me)\s+(?:me\s+)?(?:a\s+|the\s+)?(?:good\s+|better\s+)?(?:follow[- ]?up\s+)?prompt\b"#, options: .regularExpression) != nil { return .prompt }
        if t.range(of: #"^(?:please\s+)?(?:can you\s+)?(?:write|draft|compose|type)\s+(?:me\s+)?(?:a|an|the|my)?\s*(?:quick\s+|short\s+|polite\s+)?(?:reply|response|answer|email|message|comment|tweet|post|text|one[- ]liner|caption|bio)\b"#, options: .regularExpression) != nil { return .text }
        return nil
    }

    /// ox writes it from your screen (and what it knows about you), then it is
    /// pasted where your cursor is. Return is never pressed: you send it.
    func writeForMe(_ kind: WriteKind, request: String, shot: String?) {
        IslandLog.write("write for me (\(kind == .prompt ? "prompt" : "text")): \(request)")
        MainActor.assumeIsolated { buddy.phase = .thinking }
        let ask = kind == .prompt
            ? "The screenshot shows the user's screen with a coding agent (Claude Code, Codex or similar) in a terminal or app. Write the best next prompt to give that agent, from what it just said and what the user wants: \(request)\nReply with the prompt only, then a line with ---EXPLAIN--- and one or two plain sentences telling the user what the prompt does and why, for someone non-technical."
            : "The screenshot shows the user's screen; they are about to type in the focused box (an email, a chat, a document). Write exactly the text they asked for, in their own voice and style (use what you know about them), grounded in what is on screen: \(request)\nReply with only the text to paste: no quotes, no preamble, no sign-off they did not ask for."
        var args = ["--mode", "ask", "-p", ask]
        if let shot { args += ["--image", shot] }
        OxRunner.run(args, cwd: FileManager.default.homeDirectoryForCurrentUser, timeout: 120) { [weak self] code, out in
            guard let self else { return }
            let all = Shelf.clean(out)
            guard code == 0, !all.isEmpty else { MainActor.assumeIsolated { self.buddy.speak("I couldn't write that: \(all.isEmpty ? "ox stopped" : String(all.prefix(80)))") }; return }
            let parts = all.components(separatedBy: "---EXPLAIN---")
            let text = parts[0].trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "\"“”"))
            let explain = parts.count > 1 ? parts[1].trimmingCharacters(in: .whitespacesAndNewlines) : ""
            let pasted = Paster.paste(text)
            IslandLog.write("wrote \(text.count) chars, \(pasted ? "pasted" : "on the clipboard")")
            let said = pasted ? (kind == .prompt ? "I've pasted a follow-up prompt. \(explain) Press Return when you're happy with it." : "I've written it where you were typing. Read it, then send it yourself.")
                : "It's on your clipboard: press Command V where it goes. Allow Accessibility for OX Island and I'll paste it for you."
            MainActor.assumeIsolated { self.buddy.speak(said) }
        }
    }

    /// Click a character: its session opens under the island.
    func openCard(_ session: AgentSession) {
        IslandLog.write("session card: \(session.project) (\(session.id))")
        if card?.id == session.id { card = nil; return }
        tray = nil
        pinnedOpen = true
        var c = SessionCard(id: session.id)
        guard let ext = Self.externalId(session.id) else {
            // ox's own run: what it said last; messages go to that run.
            c.lines = session.lastText.isEmpty ? [] : [CardLine(mine: false, text: session.lastText)]
            c.canSend = connections[session.id] != nil
            c.note = c.canSend ? "" : "This run is shown, not driven: open it in the OX app."
            card = c
            return
        }
        c.note = "Reading the session…"
        card = c
        post("/ox/agents/session", ["id": ext]) { [weak self] j in
            guard let self, self.card?.id == session.id else { return }
            guard let j, j["error"] == nil else { self.card?.note = "Could not read it: \(((j?["error"] as? [String: Any])?["message"] as? String) ?? "the OX app is not running")"; return }
            let msgs = (j["messages"] as? [[String: Any]]) ?? []
            self.card?.lines = msgs.map { CardLine(mine: ($0["role"] as? String) == "user", text: ($0["text"] as? String) ?? "") }.filter { !$0.text.isEmpty }
            self.card?.canSend = (j["canSend"] as? Bool) ?? false
            let queued = j["queued"] as? Int ?? 0
            self.card?.note = !(self.card?.canSend ?? false) ? (j["why"] as? String ?? "") : queued > 0 ? "\(queued) message(s) waiting for it to be idle" : ""
        }
    }

    /// A message from the island to the open session.
    func sendToCard(_ raw: String, model: String? = nil) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var c = card, !text.isEmpty, c.canSend, !c.busy else { return }
        c.lines.append(CardLine(mine: true, text: text))
        guard let ext = Self.externalId(c.id) else {
            // ox's own run: straight into it over its socket.
            if let conn = connections[c.id] {
                conn.send(["type": "user-message", "text": text, "imagePaths": [String](), "voice": false])
                c.note = "Sent. Its answer shows here and in its run."
            }
            card = c
            return
        }
        c.busy = true
        c.note = "Sending…"
        card = c
        var payload: [String: Any] = ["id": ext, "text": text]
        if let model, !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { payload["model"] = model.trimmingCharacters(in: .whitespacesAndNewlines) }
        post("/ox/agents/send", payload) { [weak self] j in
            guard let self, self.card?.id == c.id else { return }
            self.card?.busy = false
            if let err = (j?["error"] as? [String: Any])?["message"] as? String { self.card?.note = err; return }
            if (j?["queued"] as? Bool) == true { self.card?.note = j?["why"] as? String ?? "Waiting for it to be idle."; return }
            let reply = (j?["reply"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if (j?["ok"] as? Bool) == true {
                self.card?.lines.append(CardLine(mine: false, text: reply.isEmpty ? "Done." : reply))
                self.card?.note = ""
            } else {
                self.card?.note = "It stopped: \(j?["error"] as? String ?? "no answer")"
            }
        }
    }

    /// Create a redacted handoff without writing into another agent's private
    /// store. Native CLI targets can be started by the Office; desktop-only
    /// tools receive a paste-ready continuation note.
    func transferCard(to target: String) {
        guard let c = card, let ext = Self.externalId(c.id), !target.isEmpty else { return }
        card?.note = "Preparing a redacted handoff…"
        post("/ox/agents/transfer", ["id": ext, "target": target]) { [weak self] j in
            guard let self else { return }
            if let err = (j?["error"] as? [String: Any])?["message"] as? String { self.card?.note = err; return }
            if (j?["kind"] as? String) == "external" {
                self.card?.note = (j?["note"] as? String) ?? "Handoff ready for (target)."
            } else {
                self.card?.note = (j?["note"] as? String) ?? "Handoff ready for (target)."
            }
        }
    }

    /// Take over in Terminal: the session continued by its own tool.
    func openCardInTerminal() {
        guard let c = card, let ext = Self.externalId(c.id) else { return }
        // Its own tab first (where it already runs); a new Terminal only when there is none.
        post("/ox/agents/focus", ["id": ext]) { [weak self] f in
            if (f?["focused"] as? Bool) == true {
                self?.card?.note = "Brought its \(f?["app"] as? String ?? "Terminal") tab to the front."
                return
            }
            self?.post("/ox/agents/open", ["id": ext]) { j in
                self?.card?.note = (j?["opened"] as? Bool) == true ? "Opened in Terminal." : ((j?["error"] as? [String: Any])?["message"] as? String ?? "Could not open it.")
            }
        }
    }

    /// Dev aid only (--render-runs): feed board rows as if polled.
    func previewBoard(_ runs: [[String: Any]]) { mergeApp(runs) }

    private func dropAppSessions(keep: Set<String>) {
        let gone: (AgentSession) -> Bool = { $0.id.hasPrefix("app:") && !keep.contains($0.id) }
        if sessions.contains(where: gone) { sessions.removeAll(where: gone) }
    }

    private func mergeApp(_ runs: [[String: Any]]) {
        let leads = runs.filter { ($0["parent"] as? String) == nil }
        var keep = Set<String>()
        for r in leads {
            guard let rid = r["id"] as? String else { continue }
            let id = "app:\(rid)"
            keep.insert(id)
            let state = r["state"] as? String ?? "thinking"
            let tool = r["tool"] as? String ?? ""
            let detail = r["detail"] as? String ?? ""
            let ended = (r["ended"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) }
            // Gone from the island 6 s after it ends, like a terminal run.
            if let ended, Date().timeIntervalSince(ended) > 6 { keep.remove(id); continue }
            // Claude Code / Codex sessions on this Mac (src/agents-live.js): shown, never driven.
            let ext = (r["ext"] as? Bool) == true
            update(id) { s in
                s.bot = ext ? r["project"] as? String ?? "agent" : r["who"] as? String ?? "ox"
                s.model = r["model"] as? String ?? ""
                s.cwd = ""
                s.lastText = r["title"] as? String ?? ""
                s.toolCount = r["steps"] as? Int ?? s.toolCount
                // Tokens: the run's so far (an app answer), or another agent's newest message.
                if let i = r["tokensIn"] as? Int { s.tokensIn = i }
                if let o = r["tokensOut"] as? Int { s.tokensOut = o }
                if ext {
                    let idle = r["idleSec"] as? Int ?? 0
                    // "Claude · idle for 3 m", "Codex · $ npm test": who, then what.
                    let who = (r["who"] as? String ?? "agent").replacingOccurrences(of: " Code", with: "")
                    s.tool = r["who"] as? String ?? "agent"
                    if !detail.isEmpty { s.note(detail) }
                    if state == "idle" {
                        s.mood = .idle
                        s.activity = "\(who) · " + (idle < 60 ? "idle, your turn" : "idle for \(idle / 60) m")
                    } else {
                        s.mood = state == "tool" ? .working(detail) : .thinking
                        s.activity = "\(who) · " + (detail.isEmpty ? "thinking" : detail)
                    }
                    s.closedAt = nil
                    return
                }
                switch state {
                case "tool":
                    let what = OxBridge.describe(tool: tool, preview: detail)
                    s.mood = .working(what); s.activity = what; s.note(what)
                case "writing": s.mood = .thinking; s.activity = "writing the answer"
                case "done": s.mood = .done; s.activity = "done"
                case "failed": s.mood = .error(detail.isEmpty ? "stopped" : detail); s.activity = "stopped"
                default: s.mood = .thinking; s.activity = "thinking"
                }
                s.closedAt = ended
                s.agents = runs.filter { ($0["parent"] as? String) == rid }.map { h in
                    var a = SubAgent(id: h["id"] as? String ?? UUID().uuidString, label: h["title"] as? String ?? "helper")
                    a.model = h["model"] as? String ?? ""
                    a.tool = h["tool"] as? String ?? ""
                    switch h["state"] as? String {
                    case "tool": a.phase = .working
                    case "done": a.phase = .done
                    case "failed": a.phase = .failed
                    default: a.phase = .thinking
                    }
                    a.endedAt = (h["ended"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) }
                    return a
                }
            }
        }
        dropAppSessions(keep: keep)
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
            // Written only when something changed: every write to `sessions` redraws
            // the whole island, and the app poll touches each session every 1.5 s.
            var copy = sessions[i]
            change(&copy)
            if copy != sessions[i] { sessions[i] = copy }
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
                // Another agent's hook relay (Claude Code, Codex…) names itself: "Claude Code wants to run bash", not "ox".
                if frame["agent"] is String, !s.bot.isEmpty { s.tool = s.bot }
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
            // AskUserQuestion: the question and its options travel in args.
            var question: String?, options: [String] = [], multi = false
            if tool == "AskUserQuestion", let q = ((frame["args"] as? [String: Any])?["questions"] as? [[String: Any]])?.first {
                question = q["question"] as? String
                options = ((q["options"] as? [Any]) ?? []).compactMap { ($0 as? [String: Any])?["label"] as? String ?? $0 as? String }
                multi = q["multiSelect"] as? Bool ?? false
            }
            update(path) { s in
                let risk = frame["risk"] as? [String: Any]
                s.pending = PendingApproval(id: id, tool: tool, preview: preview,
                                            deadline: Date(timeIntervalSince1970: deadlineMs / 1000),
                                            question: question, options: options, multiSelect: multi,
                                            riskWhy: (risk?["why"] as? String).flatMap { $0.isEmpty ? nil : $0 }, riskLevel: risk?["level"] as? String)
                s.mood = .needsYou
                s.activity = "wants to run \(tool)"
            }
            IslandSound.play("pop")
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
                if (ev["narrate"] as? Bool) == true, let text = ev["argsPreview"] as? String { DispatchQueue.main.async { self.showTicker(text, done: false, session: path) } }
                // Drawing with the cursor is said out loud (Vovy's "Taking your cursor", "Carving the left eye").
                if let n = ev["name"] as? String, n == "draw" || n.hasSuffix("__draw") {
                    let raw = ev["argsPreview"] as? String ?? ""
                    let label = raw.range(of: #""label"\s*:\s*"([^"]+)""#, options: .regularExpression).map { String(raw[$0]).components(separatedBy: "\"").dropLast().last ?? "" } ?? raw
                    DispatchQueue.main.async { self.showTicker(label.isEmpty ? "Taking your cursor" : "Drawing the \(label)", done: false, session: path) }
                }
                let name = ev["name"] as? String ?? "tool"
                s.lastText = "" // the next reply is a new message, not a continuation
                s.buddyReply = "" // only the final answer is spoken, not the narration
                s.toolCount += 1
                s.mood = .working(name)
                s.activity = Self.describe(tool: name, preview: ev["argsPreview"] as? String ?? "")
                s.note(s.activity)
            case "tool-end":
                if (ev["narrate"] as? Bool) == true || (ev["name"] as? String).map({ $0 == "draw" || $0.hasSuffix("__draw") }) == true, let t = ticker, t.sessionId == path { DispatchQueue.main.async { self.showTicker(t.text, done: true, session: path) } }
                if (ev["isError"] as? Bool) == true { s.activity = "\(ev["name"] as? String ?? "tool") failed — recovering" }
                // The live diff ticker: "editing app.js +12 −3".
                if let d = ev["diff"] as? [String: Any], let file = d["file"] as? String {
                    s.note("editing \(file) +\(d["plus"] as? Int ?? 0) −\(d["minus"] as? Int ?? 0)")
                }
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
        // Every answer leaves a line, so an "allow" can always be traced to a click here (or shown not to be).
        IslandLog.write("approval answered: \(decision.rawValue) · \(session.project) · \(p.tool): \(p.preview.prefix(80))")
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

    func peek(for seconds: TimeInterval = 4) {
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
    /// An ox run with a socket that can take a message now.
    var hasLiveRun: Bool { sessions.contains { $0.closedAt == nil && $0.pending == nil && connections[$0.id] != nil } }

    func ask(_ text: String, imagePaths: [String], audioPath: String? = nil, voice: Bool = true) -> Bool {
        // Only a run with a socket can take a question (the app's runs are shown, not driven).
        guard let s = sessions.last(where: { $0.closedAt == nil && $0.pending == nil && connections[$0.id] != nil }), let conn = connections[s.id] else { return false }
        var msg: [String: Any] = ["type": "user-message", "text": text, "imagePaths": imagePaths, "voice": voice]
        if let audioPath { msg["audioPath"] = audioPath }
        conn.send(msg)
        update(s.id) { s in
            // Only a spoken question is answered aloud; a typed one shows in the island.
            s.buddyAsk = voice
            s.buddyReply = ""
            s.activity = "you asked: \(Self.shortLabel(text))"
        }
        return true
    }

    /// The answer to an agent's question, chosen in the notch.
    func answerQuestion(_ session: AgentSession, _ answer: String) {
        guard let p = session.pending, let conn = connections[session.id] else { return }
        conn.send(["type": "approval-answer", "id": p.id, "decision": "answer", "answer": answer])
        IslandLog.write("answered \(session.project)'s question: \(answer)")
        update(session.id) { s in s.pending = nil; s.mood = .thinking; s.activity = "you answered: \(Self.shortLabel(answer))" }
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
    var hasExtraPanel: Bool { orgCard != nil || card != nil || tray != nil || officeSession != nil || canvasSession != nil }

    /// Commands about the island itself, typed or said ("make the island
    /// smaller", "bigger", "stay open", "close"): done here, no model, no AI.
    static func withoutName(_ raw: String) -> String {
        let name = NSRegularExpression.escapedPattern(for: OxName.current)
        let re = try! NSRegularExpression(pattern: #"^\s*(?:(?:ok(?:ay)?|hey|hi)[\s,]+)?(?:ox|"# + name + #")\b[\s,.:!]*"#, options: [.caseInsensitive])
        let ns = raw as NSString
        let out = re.stringByReplacingMatches(in: raw, range: NSRange(location: 0, length: ns.length), withTemplate: "")
        return out.isEmpty ? raw : out
    }

    /// One clause about the island itself, matched strictly: "make the text
    /// smaller", "close the tab" and "hide the dock" are not about the island
    /// and are left for ox (they used to be swallowed here).
    func islandCommand(_ raw: String) -> String? {
        let t = raw.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: " .!?,"))
        let full = { (p: String) in t.range(of: p, options: .regularExpression) != nil }
        // "call yourself Pixie", "your name is Pixie", "rename yourself to Pixie".
        if let m = try? NSRegularExpression(pattern: #"^(?:please\s+)?(?:call yourself|your name is|rename yourself(?: to)?|i(?:'ll| will) call you|be called)\s+([A-Za-z0-9][A-Za-z0-9 .'-]{0,23}?)[.!]*$"#, options: [.caseInsensitive])
            .firstMatch(in: raw, range: NSRange(location: 0, length: (raw as NSString).length)) {
            let name = (raw as NSString).substring(with: m.range(at: 1)).trimmingCharacters(in: .whitespaces)
            return OxName.set(name) ? "I'm \(OxName.current) now. Say \"\(OxName.current), …\" to talk to me." : "A name is up to 24 letters or digits."
        }
        let set = { (k: String, v: Any?) in UserDefaults.standard.set(v, forKey: k); self.objectWillChange.send() }
        let me = #"(?:the\s+)?(?:island|notch|yourself|you)"#
        let lead = #"^(?:please\s+)?(?:can you\s+|could you\s+)?"#
        if full(lead + #"(?:make|set|turn|get)\s+"# + me + #"\s+(?:a\s+(?:bit|little)\s+|much\s+)?(?:smaller|compact|tiny|small)$"#)
            || full(lead + #"(?:shrink|minimi[sz]e)\s+"# + me + #"$"#) || full(#"^(?:smaller|compact|shrink)$"#) {
            set("island.size", "compact"); return "Island is compact now. Say \"make the island bigger\" to undo."
        }
        if full(lead + #"(?:make|set|turn|get)\s+"# + me + #"\s+(?:a\s+(?:bit|little)\s+|much\s+)?(?:bigger|larger|full size|normal size|standard size)$"#)
            || full(lead + #"(?:grow|enlarge)\s+"# + me + #"$"#) || full(#"^(?:bigger|larger|full size)$"#) {
            set("island.size", "standard"); return "Island is back to its standard size."
        }
        if full(lead + #"(?:stay open|keep\s+"# + me + #"\s+open|keep (?:it\s+)?open|don.t close(?:\s+"# + me + #")?)$"#) {
            set("island.autoClose", 0.0); pinnedOpen = true; return "I'll stay open until you close me."
        }
        if full(lead + #"(?:close|hide|go away|dismiss)(?:\s+"# + me + #")?$"#) {
            set("island.autoClose", 6.0); pinnedOpen = false; tray = nil; return "Closing. I close by myself a few seconds after you leave."
        }
        return nil
    }

    /// "Make yourself smaller and turn down the volume": the island does its
    /// part here and the rest goes on to ox. Nil when no clause is about the island.
    func islandPart(_ raw: String) -> (said: String, rest: String?)? {
        let parts = raw.components(separatedBy: CharacterSet(charactersIn: ";"))
            .flatMap { $0.replacingOccurrences(of: #"(?i)\s*,?\s+(?:and then|and|then)\s+"#, with: "\u{1F}", options: .regularExpression).components(separatedBy: "\u{1F}") }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        var said: [String] = [], rest: [String] = []
        for p in parts { if let s = islandCommand(p) { said.append(s) } else { rest.append(p) } }
        guard !said.isEmpty else { return nil }
        return (said.joined(separator: " "), rest.isEmpty ? nil : rest.joined(separator: " and "))
    }

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


extension ISO8601DateFormatter {
    /// "2026-10-19T15:00:00.000Z" (Cal.com and most APIs send milliseconds).
    static let withFractions: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
}
