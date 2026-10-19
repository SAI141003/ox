import AppKit
import Combine
import SwiftUI
import UniformTypeIdentifiers

// The tray: small tools under the island, opened from the header.
//
//   Chat   type to ox alongside voice: to a live run, or offline / in a folder
//   Shelf  drop files on the notch; ask ox about one, or start an email with it
//   Focus  a focus timer whose countdown rides in the notch wing
//   Clips  the last things you copied, one click to copy again
//
// Everything here is real local state: the shelf is the files you dropped
// (kept across restarts), the clips are what the pasteboard actually held
// (memory only, and never anything a password manager marks as secret).

enum TrayTab: String, CaseIterable, Identifiable {
    case chat, shelf, focus, clips, mail, recap
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .chat: return "text.bubble"
        case .shelf: return "tray.and.arrow.down"
        case .focus: return "timer"
        case .clips: return "doc.on.clipboard"
        case .mail: return "envelope"
        case .recap: return "chart.bar"
        }
    }
    var title: String { T(rawValue.capitalized) }
}

// MARK: - Running ox

/// Runs the ox that started this island (`ox island start` passes OX_NODE and OX_CLI).
/// ~/.ox/island.log: what the island heard, which way it went, how long it
/// took and what came back. One line each, kept under a megabyte.
enum IslandLog {
    static let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ox/island.log")
    static func write(_ line: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        let text = "\(stamp) \(line.replacingOccurrences(of: "\n", with: " "))\n"
        let fm = FileManager.default
        if let size = (try? fm.attributesOfItem(atPath: file.path))?[.size] as? Int, size > 1_000_000 {
            try? fm.removeItem(at: file)
        }
        if let h = try? FileHandle(forWritingTo: file) {
            h.seekToEndOfFile(); h.write(Data(text.utf8)); try? h.close()
        } else {
            try? fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? Data(text.utf8).write(to: file)
        }
    }
}

/// The ox server that is already running (OX.app's, or `ox serve`), asked over
/// HTTP on this Mac: POST /ox/voice.
enum VoiceServer {
    struct Result: Decodable { let route: String; let handled: Bool; let say: String?; let why: String?; let model: String? }

    static func url() -> URL? {
        let home = NSHomeDirectory()
        for name in ["app.json", "serve.json"] {
            guard let d = FileManager.default.contents(atPath: home + "/.ox/" + name),
                  let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
            if let pid = j["pid"] as? Int, kill(pid_t(pid), 0) != 0 { continue }
            if let s = j["url"] as? String, let u = URL(string: s) { return u.appendingPathComponent("ox/voice") }
            if let p = j["port"] as? Int { return URL(string: "http://127.0.0.1:\(p)/ox/voice") }
        }
        return nil
    }

    /// offlineOnly: only ox's no-AI router answers (an errand done in ~0.1 s);
    /// anything else comes back unhandled, for the live run to take.
    static func ask(_ text: String, offlineOnly: Bool = false, done: @escaping (Result?) -> Void) {
        guard let u = url() else { done(nil); return }
        var req = URLRequest(url: u, timeoutInterval: offlineOnly ? 5 : 75)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["text": text, "offlineOnly": offlineOnly])
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
            let r = ok ? data.flatMap { try? JSONDecoder().decode(Result.self, from: $0) } : nil
            DispatchQueue.main.async { done(r) }
        }.resume()
    }
}

enum OxRunner {
    static var available: Bool { paths() != nil }

    /// Which ox to run. Started by `ox island start` it is told (OX_NODE,
    /// OX_CLI); started any other way (at login, its own Restart, OX.app) it
    /// used to know nothing, and every request ended in "start ox in a
    /// terminal". Now: the ox OX.app runs, the one OX.app was installed from,
    /// then the usual places. Every path is checked on disk first.
    static func paths() -> (node: String, cli: String)? {
        let fm = FileManager.default
        let usable = { (n: String?, c: String?) -> (String, String)? in
            guard let n, let c, fm.isExecutableFile(atPath: n), fm.fileExists(atPath: c) else { return nil }
            return (n, c)
        }
        let env = ProcessInfo.processInfo.environment
        if let p = usable(env["OX_NODE"], env["OX_CLI"]) { return p }
        let home = NSHomeDirectory()
        let read = { (path: String) -> [String: Any] in
            guard let d = fm.contents(atPath: path), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
            return j
        }
        let app = read(home + "/.ox/app.json")
        if let p = usable(app["node"] as? String, app["cli"] as? String) { return p }
        for bundle in [home + "/Applications/OX.app", "/Applications/OX.app"] {
            let res = bundle + "/Contents/Resources"
            if let p = usable(res + "/node", res + "/ox/bin/ox.js") { return p }
            let j = read(res + "/ox-paths.json")
            if let p = usable(j["node"] as? String, j["cli"] as? String) { return p }
        }
        for n in ["/opt/homebrew/bin/node", "/usr/local/bin/node", home + "/.hermes/node/bin/node", home + "/.volta/bin/node"] {
            for c in [home + "/ox/bin/ox.js", "/opt/homebrew/lib/node_modules/ox-agent/bin/ox.js", "/usr/local/lib/node_modules/ox-agent/bin/ox.js"] {
                if let p = usable(n, c) { return p }
            }
        }
        return nil
    }

    /// timeout: a run that hangs is stopped, so the chat never stays "busy" for good.
    static func run(_ args: [String], cwd: URL, env extra: [String: String] = [:], timeout: TimeInterval = 20 * 60, completion: @escaping (Int32, String) -> Void) {
        let env = ProcessInfo.processInfo.environment
        guard let (node, cli) = paths() else {
            completion(127, "ox is not installed where the island can find it. Open OX once, or run  ox island start .")
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [cli] + args
        p.currentDirectoryURL = cwd
        var e = env
        for (k, v) in extra { e[k] = v }
        e["OX_ISLAND"] = "0"
        e["NO_COLOR"] = "1"
        p.environment = e
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        p.standardInput = FileHandle.nullDevice
        // Drained while it runs: a reply bigger than the pipe buffer would
        // otherwise block ox on write and never let it exit.
        let lock = NSLock()
        var buf = Data()
        pipe.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            lock.lock(); buf.append(d); lock.unlock()
        }
        p.terminationHandler = { proc in
            pipe.fileHandleForReading.readabilityHandler = nil
            let rest = pipe.fileHandleForReading.readDataToEndOfFile()
            lock.lock(); buf.append(rest); let all = buf; lock.unlock()
            let text = String(decoding: all, as: UTF8.self)
            DispatchQueue.main.async { completion(proc.terminationStatus, text) }
        }
        do { try p.run() } catch { completion(127, error.localizedDescription); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak p] in
            guard let p, p.isRunning else { return }
            IslandLog.write("stopped a run after \(Int(timeout / 60)) min: ox \(args.prefix(3).joined(separator: " "))")
            p.terminate()
        }
    }
}

// MARK: - Shelf

struct ShelfItem: Codable, Identifiable, Equatable {
    var id: String { path }
    let path: String
    let added: Date
    var name: String { (path as NSString).lastPathComponent }
    var exists: Bool { FileManager.default.fileExists(atPath: path) }
}

struct MailAccount: Codable, Hashable { let account: String; let address: String }

final class Shelf: ObservableObject {
    @Published private(set) var items: [ShelfItem] = []
    @Published var selected: String?
    @Published var busy = false
    @Published var answer = ""
    @Published var accounts: [MailAccount] = []
    @Published var mailNote = ""

    private let file: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ox/island", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("shelf.json")
    }()

    init() {
        if let d = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode([ShelfItem].self, from: d) {
            items = saved.filter(\.exists)
        }
        selected = items.first?.path
    }

    var current: ShelfItem? { items.first { $0.path == selected } ?? items.first }

    func add(_ urls: [URL]) {
        for u in urls where u.isFileURL {
            let p = u.standardizedFileURL.path
            items.removeAll { $0.path == p }
            items.insert(ShelfItem(path: p, added: Date()), at: 0)
        }
        items = Array(items.prefix(12))
        selected = items.first?.path
        answer = ""
        mailNote = ""
        save()
    }

    func remove(_ item: ShelfItem) {
        items.removeAll { $0 == item }
        if selected == item.path { selected = items.first?.path }
        save()
    }

    private func save() {
        if let d = try? JSONEncoder().encode(items) { try? d.write(to: file, options: .atomic) }
    }

    /// One question about one file, answered by ox in ask mode: it can read
    /// the file, it cannot change anything.
    func ask(_ question: String) {
        guard let item = current, !busy else { return }
        let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
        let prompt = "\(q.isEmpty ? "Summarise this file in a few lines." : q)\n\nThe file: @\(item.name)"
        busy = true
        answer = ""
        let dir = URL(fileURLWithPath: item.path).deletingLastPathComponent()
        OxRunner.run(["--mode", "ask", "-p", prompt], cwd: dir) { [weak self] code, out in
            guard let self else { return }
            self.busy = false
            let text = Self.clean(out)
            self.answer = code == 0 ? text : "ox stopped: \(text.isEmpty ? "exit \(code)" : text)"
        }
    }

    func loadAccounts() {
        mailNote = "Reading Mail accounts…"
        OxRunner.run(["mail", "accounts", "--json"], cwd: FileManager.default.homeDirectoryForCurrentUser) { [weak self] _, out in
            guard let self else { return }
            struct R: Codable { let accounts: [MailAccount]?; let error: String? }
            let line = out.split(separator: "\n").last.map(String.init) ?? ""
            if let r = try? JSONDecoder().decode(R.self, from: Data(line.utf8)), let a = r.accounts {
                self.accounts = a
                self.mailNote = a.isEmpty ? "Mail has no accounts. Add one in Mail › Settings." : ""
            } else {
                self.mailNote = "Could not read Mail: allow ox under Privacy & Security › Automation."
            }
        }
    }

    /// A draft in Mail with the file attached, from the account chosen in the
    /// picker. Nothing is sent from here: the person presses Send in Mail.
    func draft(from: String, to: String, subject: String) {
        guard let item = current else { return }
        mailNote = "Opening a draft in Mail…"
        let args = ["mail", "draft", "--json", "--from", from, "--to", to, "--subject", subject.isEmpty ? item.name : subject, "--attach", item.path]
        OxRunner.run(args, cwd: URL(fileURLWithPath: item.path).deletingLastPathComponent()) { [weak self] _, out in
            guard let self else { return }
            struct R: Codable { let ok: Bool; let message: String }
            let line = out.split(separator: "\n").last.map(String.init) ?? ""
            if let r = try? JSONDecoder().decode(R.self, from: Data(line.utf8)) {
                self.mailNote = r.ok ? "Draft is open in Mail from \(from). Press Send there." : r.message.replacingOccurrences(of: "mail_compose: ", with: "")
            } else {
                self.mailNote = Self.clean(out)
            }
        }
    }

    /// ox's own progress lines start with a dot or a bullet; the answer is the rest.
    static func clean(_ s: String) -> String {
        s.split(separator: "\n", omittingEmptySubsequences: false)
            .map(String.init)
            .filter { l in !(l.hasPrefix("· ") || l.hasPrefix("● ") || l.hasPrefix("✓ ")) }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// MARK: - Focus

final class FocusTimer: ObservableObject {
    @Published private(set) var endsAt: Date?
    @Published private(set) var pausedLeft: TimeInterval?
    @Published var minutes: Int = UserDefaults.standard.integer(forKey: "focus.minutes") == 0 ? 25 : UserDefaults.standard.integer(forKey: "focus.minutes") {
        didSet { UserDefaults.standard.set(minutes, forKey: "focus.minutes") }
    }
    @Published private(set) var finishedAt: Date?
    private var ticker: Timer?

    var running: Bool { endsAt != nil }
    var active: Bool { endsAt != nil || pausedLeft != nil }

    func left(at now: Date = Date()) -> TimeInterval {
        if let e = endsAt { return max(0, e.timeIntervalSince(now)) }
        return pausedLeft ?? TimeInterval(minutes * 60)
    }

    func start() {
        endsAt = Date().addingTimeInterval(pausedLeft ?? TimeInterval(minutes * 60))
        pausedLeft = nil
        finishedAt = nil
        ticker?.invalidate()
        let t = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(t, forMode: .common)
        ticker = t
    }

    func pause() {
        guard let e = endsAt else { return }
        pausedLeft = max(0, e.timeIntervalSinceNow)
        endsAt = nil
        ticker?.invalidate()
    }

    func reset() {
        endsAt = nil
        pausedLeft = nil
        ticker?.invalidate()
    }

    private func tick() {
        guard let e = endsAt, e <= Date() else { return }
        reset()
        finishedAt = Date()
        IslandSound.play("glass")
    }

    static func clock(_ t: TimeInterval) -> String {
        let s = Int(t.rounded(.up))
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}

// MARK: - Clips

final class ClipHistory: ObservableObject {
    @Published private(set) var clips: [String] = []
    private var lastCount = NSPasteboard.general.changeCount
    private var ticker: Timer?
    private var selfCopy = false

    /// Pasteboard types password managers set so other apps do not keep secrets
    /// (nspasteboard.org): anything carrying one is never recorded.
    private static let secret: Set<NSPasteboard.PasteboardType> = [
        .init("org.nspasteboard.ConcealedType"),
        .init("org.nspasteboard.TransientType"),
        .init("org.nspasteboard.AutoGeneratedType"),
        .init("com.agilebits.onepassword"),
    ]

    func start() {
        guard ticker == nil else { return }
        let t = Timer(timeInterval: 0.8, repeats: true) { [weak self] _ in self?.poll() }
        RunLoop.main.add(t, forMode: .common)
        ticker = t
    }

    private func poll() {
        let pb = NSPasteboard.general
        guard pb.changeCount != lastCount else { return }
        lastCount = pb.changeCount
        if selfCopy { selfCopy = false; return }
        if let types = pb.types, types.contains(where: { Self.secret.contains($0) }) { return }
        guard let s = pb.string(forType: .string), !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        clips.removeAll { $0 == s }
        clips.insert(String(s.prefix(4000)), at: 0)
        clips = Array(clips.prefix(20))
    }

    func copy(_ s: String) {
        selfCopy = true
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
        clips.removeAll { $0 == s }
        clips.insert(s, at: 0)
    }

    func clear() { clips = [] }
}

// MARK: - Views

struct TrayButtons: View {
    @ObservedObject var bridge: OxBridge
    var body: some View {
        HStack(spacing: 4) {
            ForEach(TrayTab.allCases) { tab in
                Button {
                    bridge.tray = bridge.tray == tab ? nil : tab
                } label: {
                    Image(systemName: tab.icon)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(bridge.tray == tab ? Color.black : Ink.muted)
                        .frame(width: 22, height: 18)
                        .background(Capsule().fill(bridge.tray == tab ? Ink.text : Color.white.opacity(0.06)))
                }
                .buttonStyle(.plain)
                .help(tab.title)
            }
        }
    }
}

struct TrayPanel: View {
    @ObservedObject var bridge: OxBridge
    var body: some View {
        Group {
            switch bridge.tray {
            case .chat: ChatView(chat: bridge.chat, bridge: bridge)
            case .shelf: ShelfView(shelf: bridge.shelf)
            case .focus: FocusView(timer: bridge.focus)
            case .clips: ClipsView(history: bridge.clips)
            case .mail: MailView(mail: bridge.mail)
            case .recap: RecapView(bridge: bridge)
            case nil: EmptyView()
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Ink.card))
    }
}

private struct FieldStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .font(.system(size: 12))
            .foregroundStyle(Ink.text)
            .padding(.horizontal, 9).padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.07)))
    }
}

struct ShelfView: View {
    @ObservedObject var shelf: Shelf
    @State private var question = ""
    @State private var mailing = false
    @State private var from = ""
    @State private var to = ""

    var body: some View {
        if shelf.items.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(T("Drop files on the notch")).font(.system(size: 13, weight: .semibold)).foregroundStyle(Ink.text)
                Text("They wait here. Ask ox about one, or start an email with it attached, from the account you pick.")
                    .font(.system(size: 12)).foregroundStyle(Ink.muted).fixedSize(horizontal: false, vertical: true)
            }
        } else {
            HStack(alignment: .top, spacing: 12) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(shelf.items) { item in
                            HStack(spacing: 6) {
                                Image(nsImage: NSWorkspace.shared.icon(forFile: item.path)).resizable().frame(width: 16, height: 16)
                                Text(item.name).font(.system(size: 11.5)).lineLimit(1).truncationMode(.middle)
                                    .foregroundStyle(item.path == shelf.current?.path ? Ink.text : Ink.muted)
                                Spacer(minLength: 0)
                                Button { shelf.remove(item) } label: { Image(systemName: "xmark").font(.system(size: 9)) }
                                    .buttonStyle(.plain).foregroundStyle(Ink.dim)
                            }
                            .contentShape(Rectangle())
                            .onTapGesture { shelf.selected = item.path; shelf.answer = ""; shelf.mailNote = "" }
                            .onDrag { NSItemProvider(contentsOf: URL(fileURLWithPath: item.path)) ?? NSItemProvider() }
                        }
                    }
                }
                .frame(width: 170)
                VStack(alignment: .leading, spacing: 6) {
                    if mailing {
                        mailForm
                    } else {
                        HStack(spacing: 6) {
                            TextField("Ask \(OxName.current) about \(shelf.current?.name ?? "it")…", text: $question)
                                .modifier(FieldStyle())
                                .onSubmit { shelf.ask(question) }
                            PillButton(title: shelf.busy ? "…" : "Ask", primary: true) { shelf.ask(question) }
                            PillButton(title: T("Email"), primary: false) { mailing = true; shelf.loadAccounts() }
                        }
                        ScrollView {
                            Text(shelf.busy ? "\(OxName.current) is reading it…" : shelf.answer)
                                .font(.system(size: 11.5)).foregroundStyle(Ink.text.opacity(0.9))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private var mailForm: some View {
        HStack(spacing: 6) {
            Picker("", selection: $from) {
                Text("From…").tag("")
                ForEach(shelf.accounts, id: \.address) { a in Text("\(a.address) · \(a.account)").tag(a.address) }
            }
            .labelsHidden()
            .frame(width: 210)
            TextField("To", text: $to).modifier(FieldStyle())
        }
        HStack(spacing: 8) {
            // From is never preselected: with several accounts signed in, the
            // sender is the one thing that must be chosen on purpose.
            PillButton(title: T("Draft in Mail"), primary: true) {
                guard !from.isEmpty, !to.isEmpty else { shelf.mailNote = from.isEmpty ? "Pick which account it is from." : "Who is it to?"; return }
                shelf.draft(from: from, to: to, subject: "")
            }
            PillButton(title: T("Back"), primary: false) { mailing = false }
            Text(shelf.mailNote).font(.system(size: 11)).foregroundStyle(Ink.muted).lineLimit(2)
        }
    }
}

struct FocusView: View {
    @ObservedObject var timer: FocusTimer
    var body: some View {
        HStack(spacing: 18) {
            TimelineView(.periodic(from: .now, by: 0.5)) { ctx in
                Text(FocusTimer.clock(timer.left(at: ctx.date)))
                    .font(.system(size: 34, weight: .semibold, design: .rounded).monospacedDigit())
                    .foregroundStyle(timer.running ? Ink.text : Ink.muted)
            }
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    ForEach([15, 25, 50], id: \.self) { m in
                        PillButton(title: "\(m)m", primary: timer.minutes == m && !timer.active) {
                            timer.reset(); timer.minutes = m
                        }
                    }
                }
                HStack(spacing: 6) {
                    PillButton(title: timer.running ? "Pause" : (timer.active ? "Resume" : "Start"), primary: true) {
                        timer.running ? timer.pause() : timer.start()
                    }
                    if timer.active { PillButton(title: T("Reset"), primary: false) { timer.reset() } }
                    if let f = timer.finishedAt, Date().timeIntervalSince(f) < 600 {
                        Text(T("Done. Take a break.")).font(.system(size: 11)).foregroundStyle(Ink.green)
                    }
                }
            }
        }
    }
}

struct ClipsView: View {
    @ObservedObject var history: ClipHistory
    var body: some View {
        if history.clips.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(T("Nothing copied yet")).font(.system(size: 13, weight: .semibold)).foregroundStyle(Ink.text)
                Text("Copy text anywhere and it shows up here. Kept in memory only; passwords are never kept.")
                    .font(.system(size: 12)).foregroundStyle(Ink.muted)
            }
        } else {
            VStack(alignment: .leading, spacing: 4) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(Array(history.clips.enumerated()), id: \.offset) { _, s in
                            Button { history.copy(s) } label: {
                                Text(s.replacingOccurrences(of: "\n", with: " ⏎ "))
                                    .font(.system(size: 11.5)).foregroundStyle(Ink.text.opacity(0.88))
                                    .lineLimit(1).truncationMode(.tail)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 8).padding(.vertical, 3)
                                    .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.04)))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                HStack {
                    Text("click to copy again").font(.system(size: 10.5)).foregroundStyle(Ink.dim)
                    Spacer()
                    Button(T("Clear")) { history.clear() }.buttonStyle(.plain).font(.system(size: 10.5)).foregroundStyle(Ink.dim)
                }
            }
        }
    }
}

/// The focus countdown, small enough for the notch wing.
struct FocusWing: View {
    @ObservedObject var timer: FocusTimer
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            Text(FocusTimer.clock(timer.left(at: ctx.date)))
                .font(.system(size: 11, weight: .semibold, design: .rounded).monospacedDigit())
                .foregroundStyle(timer.running ? Ink.amber : Ink.muted)
        }
    }
}

// MARK: - Chat

/// Type to ox from the notch, alongside voice. With an ox run open, the text
/// goes to it. Without one, small tasks are done offline (`ox do`), and
/// anything bigger runs ox in the chosen folder, continuing the conversation.
final class IslandChat: ObservableObject {
    struct Line: Identifiable { let id = UUID(); let mine: Bool; let text: String; var who: String? = nil }
    struct Agent: Decodable, Hashable { let name: String; let bot: String?; let mode: String; let description: String }
    @Published private(set) var lines: [Line] = []
    @Published private(set) var busy = false
    /// Your agents (`ox agent new`), and which one you are talking to (nil = ox).
    @Published private(set) var agents: [Agent] = []
    @Published var agent: String? = UserDefaults.standard.string(forKey: "chat.agent") {
        didSet { UserDefaults.standard.set(agent, forKey: "chat.agent") }
    }
    private var startedFor: Set<String> = []
    @Published var folder: String {
        didSet { UserDefaults.standard.set(folder, forKey: "chat.folder"); startedFor = [] }
    }

    init() {
        folder = UserDefaults.standard.string(forKey: "chat.folder") ?? FileManager.default.homeDirectoryForCurrentUser.path
    }

    var folderName: String { (folder as NSString).lastPathComponent }

    func loadAgents() {
        OxRunner.run(["agent", "list", "--json"], cwd: FileManager.default.homeDirectoryForCurrentUser) { [weak self] _, out in
            struct R: Decodable { let agents: [Agent] }
            let line = out.split(separator: "\n").last.map(String.init) ?? ""
            guard let self, let r = try? JSONDecoder().decode(R.self, from: Data(line.utf8)) else { return }
            self.agents = r.agents
            if let a = self.agent, !r.agents.contains(where: { $0.name == a }) { self.agent = nil }
        }
    }

    /// A stable colour per agent name, from the island's palette.
    static func color(for name: String) -> Color {
        let sum = name.unicodeScalars.reduce(0) { $0 + Int($1.value) }
        return Color(hex: OxBridge.palette[sum % OxBridge.palette.count])
    }

    /// Called with the answer, for the voice to speak it.
    private var onReply: ((String) -> Void)?
    /// What you sent while ox was busy: done next, in order (it used to be dropped).
    private var queued: [(text: String, bridge: OxBridge, onReply: ((String) -> Void)?)] = []

    func send(_ raw: String, bridge: OxBridge, onReply: ((String) -> Void)? = nil) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if busy {
            queued.append((text, bridge, onReply))
            lines.append(Line(mine: true, text: text))
            lines.append(Line(mine: false, text: "Queued: I'll do this next (\(queued.count) waiting)."))
            IslandLog.write("queued: \(text)")
            return
        }
        start(text, bridge: bridge, onReply: onReply, echo: true)
    }

    private func start(_ text: String, bridge: OxBridge, onReply: ((String) -> Void)?, echo: Bool) {
        self.onReply = onReply
        if echo { lines.append(Line(mine: true, text: text)) }
        IslandLog.write("heard: \(text)")
        var text = text
        if let part = bridge.islandPart(text) {
            IslandLog.write("island command: \(part.said)")
            guard let rest = part.rest else { reply(part.said, who: nil); return }
            lines.append(Line(mine: false, text: part.said))
            text = rest
        }
        if let name = agent {
            run(text, extra: ["--agent", name], key: name, who: name)
            return
        }
        // A coding run is open: errands are still done offline first, the rest goes to that run.
        if bridge.hasLiveRun {
            busy = true
            VoiceServer.ask(text, offlineOnly: true) { [weak self] r in
                guard let self else { return }
                self.busy = false
                if let r, r.handled { IslandLog.write("offline (live run open): \(r.say ?? "")"); self.reply(r.say ?? "Done.", who: nil); return }
                if bridge.ask(text, imagePaths: [], audioPath: nil, voice: false) {
                    self.lines.append(Line(mine: false, text: "Sent to your ox run. Its answer shows in the island."))
                    self.onReply = nil
                } else { self.start(text, bridge: bridge, onReply: self.onReply, echo: false) }
            }
            return
        }
        busy = true
        // The ox that is already running answers first (Coucou's shape): no new
        // process per request, small tasks in a quarter second, questions from
        // the quickest model, and only real tasks become an agent run.
        let started = Date()
        VoiceServer.ask(text) { [weak self] r in
            guard let self else { return }
            let ms = Int(Date().timeIntervalSince(started) * 1000)
            if let r, r.handled {
                IslandLog.write("\(r.route) in \(ms) ms\(r.model.map { " (\($0))" } ?? ""): \(r.say ?? "")")
                self.busy = false
                self.reply(r.say ?? "Done.", who: nil)
                return
            }
            if let r, r.route == "screen" {
                // A question about the screen: answered from a picture of it, read-only.
                guard let shot = MainActor.assumeIsolated({ Buddy.captureScreen() }) else {
                    // You asked about the screen: ask macOS once, which adds this OX Island (its current signature) to the list.
                    let asked = CGRequestScreenCaptureAccess()
                    IslandLog.write("screen question, but Screen Recording is off for OX Island (asked macOS: \(asked))")
                    self.busy = false
                    self.reply("I need to see your screen for that: turn on Screen Recording for OX Island in System Settings, Privacy and Security.", who: nil)
                    return
                }
                IslandLog.write("screen question: looking at the screen after \(ms) ms")
                self.lines.append(Line(mine: false, text: "Looking…"))
                self.run(text, extra: ["--mode", "ask", "--image", shot], key: "ox-screen", who: nil)
                return
            }
            if let r, r.route == "agent" {
                IslandLog.write("agent run (\(r.why ?? "")) after \(ms) ms")
                self.lines.append(Line(mine: false, text: "On it…"))
                MainActor.assumeIsolated { bridge.buddy.speak("On it.") }
                self.run(text, extra: ["--mode", "auto"], key: "ox", who: nil)
                return
            }
            IslandLog.write("no running ox answered (\(ms) ms): starting ox for it")
            self.runLocally(text)
        }
    }

    /// No ox server running: start ox for this one request (the old way).
    private func runLocally(_ text: String) {
        OxRunner.run(["do", "--json", text], cwd: URL(fileURLWithPath: folder)) { [weak self] _, out in
            guard let self else { return }
            struct R: Decodable { let handled: Bool; let message: String? }
            let line = out.split(separator: "\n").last.map(String.init) ?? ""
            if let r = try? JSONDecoder().decode(R.self, from: Data(line.utf8)), r.handled {
                self.busy = false
                self.reply(r.message ?? "done", who: nil)
                return
            }
            // A real task: ox works on it in the folder, continuing this chat.
            self.run(text, extra: ["--mode", "auto"], key: "ox", who: nil)
        }
    }

    /// One turn in the folder, continuing that agent's conversation.
    private func run(_ text: String, extra: [String], key: String, who: String?) {
        busy = true
        // Its own socket in the temp dir, where this island looks for runs: the
        // run's approvals (open an app, run a command) appear here as
        // Allow / Deny instead of being declined for want of a terminal.
        let sock = (NSTemporaryDirectory() as NSString).appendingPathComponent("ox-ipc-island-\(UUID().uuidString.prefix(8)).sock")
        let args = extra + ["--ipc=\(sock)", "-p", text] + (startedFor.contains(key) ? ["-c"] : [])
        OxRunner.run(args, cwd: URL(fileURLWithPath: folder), env: ["OX_IPC_WAIT_CLIENT_MS": "4000"]) { [weak self] code, out in
            guard let self else { return }
            self.busy = false
            self.startedFor.insert(key)
            let answer = Shelf.clean(out)
            self.reply(code == 0 ? (answer.isEmpty ? "Done." : answer) : "stopped: \(answer.isEmpty ? "exit \(code)" : answer)", who: who)
        }
    }

    private func reply(_ text: String, who: String?) {
        lines.append(Line(mine: false, text: text, who: who))
        IslandLog.write("replied: \(text.prefix(200))")
        onReply?(text)
        onReply = nil
        // The next thing you sent while ox was busy.
        if !busy, !queued.isEmpty {
            let next = queued.removeFirst()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
                self?.start(next.text, bridge: next.bridge, onReply: next.onReply, echo: false)
            }
        }
    }

    func clear() { lines = []; startedFor = [] }

    func pickFolder() {
        NSApp.activate(ignoringOtherApps: true)
        let p = NSOpenPanel()
        p.canChooseDirectories = true
        p.canChooseFiles = false
        p.directoryURL = URL(fileURLWithPath: folder)
        p.prompt = "Work here"
        if p.runModal() == .OK, let u = p.url { folder = u.path }
    }
}

struct ChatView: View {
    @ObservedObject var chat: IslandChat
    @ObservedObject var bridge: OxBridge
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Your agents, as faces: tap one to talk to it (ox is the default).
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    agentChip(name: nil, label: OxName.current, color: Ink.gold, help: "\(OxName.current): your messages go to a live run, or run here")
                    ForEach(chat.agents, id: \.self) { a in
                        agentChip(name: a.name, label: a.name, color: IslandChat.color(for: a.name),
                                  help: "\(a.name) · \(a.bot ?? "default bot") · \(a.mode)\(a.description.isEmpty ? "" : " — \(a.description)")")
                    }
                    if chat.agents.isEmpty {
                        Text("make agents with  ox agent new <name>").font(.system(size: 10.5)).foregroundStyle(Ink.dim)
                    }
                }
            }
            .frame(height: 30)
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 5) {
                        if chat.lines.isEmpty {
                            Text(bridge.sessions.contains { $0.closedAt == nil }
                                 ? "Type to your ox run, or hold ⌃⌥Space to talk."
                                 : "Ask anything. Small things (open an app, a timer, math) work offline; bigger ones run ox in \(chat.folderName).")
                                .font(.system(size: 11.5)).foregroundStyle(Ink.muted)
                            // Everyday errands (Wajo): a tap writes the start of the request; you finish it and send.
                            // ox finds and drafts; it never pays, books or sends on its own.
                            FlowChips(items: ["Track my package ", "Cancel my subscription to ", "Find a table for 2 tonight near ", "Remind me at 5pm to ", "Cheapest flight to ", "Summarize my unread mail"].map(T)) { draft = $0 }
                        }
                        ForEach(chat.lines) { l in
                            Text(l.who.map { "\($0): \(l.text)" } ?? l.text)
                                .font(.system(size: 12))
                                .foregroundStyle(l.mine ? Color.black : Ink.text.opacity(0.92))
                                .textSelection(.enabled)
                                .padding(.horizontal, 9).padding(.vertical, 5)
                                .background(RoundedRectangle(cornerRadius: 10).fill(l.mine ? Ink.text : Color.white.opacity(0.07)))
                                .frame(maxWidth: .infinity, alignment: l.mine ? .trailing : .leading)
                                .id(l.id)
                        }
                        if chat.busy {
                            ActivityDots(count: 1).padding(.leading, 6)
                        }
                    }
                }
                .onChange(of: chat.lines.count) { withAnimation { proxy.scrollTo(chat.lines.last?.id, anchor: .bottom) } }
            }
            HStack(spacing: 6) {
                Button { chat.pickFolder() } label: {
                    Label(chat.folderName, systemImage: "folder").labelStyle(.titleAndIcon)
                        .font(.system(size: 11)).foregroundStyle(Ink.muted).lineLimit(1)
                }
                .buttonStyle(.plain)
                .frame(maxWidth: 110, alignment: .leading)
                .help("The folder ox works in when no run is open")
                TextField(T("Message ox…"), text: $draft)
                    .modifier(FieldStyle())
                    .focused($focused)
                    .onSubmit { chat.send(draft, bridge: bridge); draft = "" }
                PillButton(title: chat.busy ? "…" : "Send", primary: true) { chat.send(draft, bridge: bridge); draft = "" }
            }
        }
        .onAppear { focused = true; chat.loadAgents() }
    }

    private func agentChip(name: String?, label: String, color: Color, help: String) -> some View {
        let on = chat.agent == name
        return Button { chat.agent = name } label: {
            HStack(spacing: 5) {
                AgentFace(color: color, mood: chat.busy && on ? .working("") : (on ? .idle : .sleeping), size: 18)
                Text(label).font(.system(size: 11, weight: on ? .semibold : .regular)).foregroundStyle(on ? Ink.text : Ink.muted).lineLimit(1)
            }
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(Capsule().fill(on ? Color.white.opacity(0.1) : .clear))
        }
        .buttonStyle(.plain)
        .help(help)
    }
}


/// Small tappable suggestions in rows that wrap.
struct FlowChips: View {
    let items: [String]
    let pick: (String) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(Array(stride(from: 0, to: items.count, by: 3)), id: \.self) { i in
                HStack(spacing: 5) {
                    ForEach(items[i..<min(i + 3, items.count)], id: \.self) { t in
                        Button { pick(t) } label: {
                            Text(t.trimmingCharacters(in: .whitespaces)).font(.system(size: 10.5)).foregroundStyle(Ink.text.opacity(0.85))
                                .padding(.horizontal, 8).padding(.vertical, 4)
                                .background(Capsule().fill(Color.white.opacity(0.07)))
                        }.buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(.top, 4)
    }
}
