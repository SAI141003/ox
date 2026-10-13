import AppKit
import Combine
import SwiftUI
import UniformTypeIdentifiers

// The tray: three small tools under the island, opened from the header.
//
//   Shelf  drop files on the notch; ask ox about one, or start an email with it
//   Focus  a focus timer whose countdown rides in the notch wing
//   Clips  the last things you copied, one click to copy again
//
// Everything here is real local state: the shelf is the files you dropped
// (kept across restarts), the clips are what the pasteboard actually held
// (memory only, and never anything a password manager marks as secret).

enum TrayTab: String, CaseIterable, Identifiable {
    case shelf, focus, clips
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .shelf: return "tray.and.arrow.down"
        case .focus: return "timer"
        case .clips: return "doc.on.clipboard"
        }
    }
    var title: String { rawValue.capitalized }
}

// MARK: - Running ox

/// Runs the ox that started this island (`ox island start` passes OX_NODE and OX_CLI).
enum OxRunner {
    static var available: Bool {
        let env = ProcessInfo.processInfo.environment
        return env["OX_NODE"] != nil && env["OX_CLI"] != nil
    }

    static func run(_ args: [String], cwd: URL, completion: @escaping (Int32, String) -> Void) {
        let env = ProcessInfo.processInfo.environment
        guard let node = env["OX_NODE"], let cli = env["OX_CLI"] else {
            completion(127, "Start the island with `ox island start` so it knows which ox to run.")
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [cli] + args
        p.currentDirectoryURL = cwd
        var e = env
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
        do { try p.run() } catch { completion(127, error.localizedDescription) }
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
        NSSound(named: "Glass")?.play()
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
            case .shelf: ShelfView(shelf: bridge.shelf)
            case .focus: FocusView(timer: bridge.focus)
            case .clips: ClipsView(history: bridge.clips)
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
                Text("Drop files on the notch").font(.system(size: 13, weight: .semibold)).foregroundStyle(Ink.text)
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
                            TextField("Ask ox about \(shelf.current?.name ?? "it")…", text: $question)
                                .modifier(FieldStyle())
                                .onSubmit { shelf.ask(question) }
                            PillButton(title: shelf.busy ? "…" : "Ask", primary: true) { shelf.ask(question) }
                            PillButton(title: "Email", primary: false) { mailing = true; shelf.loadAccounts() }
                        }
                        ScrollView {
                            Text(shelf.busy ? "ox is reading it…" : shelf.answer)
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
            PillButton(title: "Draft in Mail", primary: true) {
                guard !from.isEmpty, !to.isEmpty else { shelf.mailNote = from.isEmpty ? "Pick which account it is from." : "Who is it to?"; return }
                shelf.draft(from: from, to: to, subject: "")
            }
            PillButton(title: "Back", primary: false) { mailing = false }
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
                    if timer.active { PillButton(title: "Reset", primary: false) { timer.reset() } }
                    if let f = timer.finishedAt, Date().timeIntervalSince(f) < 600 {
                        Text("Done. Take a break.").font(.system(size: 11)).foregroundStyle(Ink.green)
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
                Text("Nothing copied yet").font(.system(size: 13, weight: .semibold)).foregroundStyle(Ink.text)
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
                    Button("Clear") { history.clear() }.buttonStyle(.plain).font(.system(size: 10.5)).foregroundStyle(Ink.dim)
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
