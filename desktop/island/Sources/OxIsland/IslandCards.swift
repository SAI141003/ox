import AppKit
import SwiftUI

// Cards under the + tab: mail from the Mail app (Coucou's mail in the notch)
// and the week at a glance (Coucou's weekly recap). Mail is read only while
// Mail is open (the island never launches it); a reply is a draft you send
// yourself (ox never sends mail).

final class MailCenter: ObservableObject {
    struct Message: Identifiable, Equatable { let id: String; let sender: String; let subject: String; let ago: String; let excerpt: String }
    @Published private(set) var messages: [Message] = []
    @Published private(set) var note = ""
    @Published var selected: String?

    private var mailOpen: Bool { NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == "com.apple.mail" } }

    func refresh() {
        // Coucou-style mail cards should work from the Island itself. Launch
        // Mail on first use, then query it after the app has finished opening;
        // an unopened Mail app was the reason this card appeared permanently
        // empty even when an account had unread mail.
        if !mailOpen {
            note = "Opening Mail…"
            NSWorkspace.shared.launchApplication(withBundleIdentifier: "com.apple.mail", options: [.withoutActivation, .default], additionalEventParamDescriptor: nil, launchIdentifier: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.refresh() }
            return
        }
        note = "Reading Mail…"
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let script = """
            set out to ""
            tell application "Mail"
              set ms to (messages of inbox whose read status is false)
              set n to count of ms
              if n > 8 then set n to 8
              repeat with i from 1 to n
                set m to item i of ms
                set d to date received of m
                set secs to (current date) - d
                set c to ""
                try
                  set c to content of m
                  if (length of c) > 220 then set c to text 1 thru 220 of c
                end try
                set out to out & (message id of m) & tab & (sender of m) & tab & (subject of m) & tab & secs & tab & c & linefeed & "␞" & linefeed
              end repeat
            end tell
            return out
            """
            var err: NSDictionary?
            let raw = NSAppleScript(source: script)?.executeAndReturnError(&err).stringValue ?? ""
            let msgs = raw.components(separatedBy: "\n␞\n").compactMap { chunk -> Message? in
                let f = chunk.components(separatedBy: "\t")
                guard f.count >= 4, !f[0].isEmpty else { return nil }
                let secs = Int(Double(f[3].trimmingCharacters(in: .whitespaces)) ?? 0)
                let ago = secs < 3600 ? "\(max(1, secs / 60))m" : secs < 86400 ? "\(secs / 3600)h" : "\(secs / 86400)d"
                let sender = f[1].replacingOccurrences(of: #"\s*<.*>$"#, with: "", options: .regularExpression)
                return Message(id: f[0], sender: sender, subject: f[2], ago: ago, excerpt: f.count > 4 ? f[4...].joined(separator: " ").replacingOccurrences(of: "\n", with: " ") : "")
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.messages = msgs
                self.note = err != nil ? "Mail did not answer: allow OX Island under Privacy & Security › Automation." : msgs.isEmpty ? "No unread mail." : ""
            }
        }
    }

    private func run(_ body: String, then: (() -> Void)? = nil) {
        DispatchQueue.global(qos: .userInitiated).async {
            var err: NSDictionary?
            _ = NSAppleScript(source: "tell application \"Mail\"\n\(body)\nend tell")?.executeAndReturnError(&err)
            DispatchQueue.main.async { then?() }
        }
    }
    private func q(_ id: String) -> String { id.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") }

    func markRead(_ m: Message) {
        run("set read status of (first message of inbox whose message id is \"\(q(m.id))\") to true") { [weak self] in
            self?.messages.removeAll { $0 == m }
        }
    }
    func openInMail(_ m: Message) {
        run("open (first message of inbox whose message id is \"\(q(m.id))\")\nactivate")
    }
    /// A reply draft opens in Mail; you read it and press Send there.
    func reply(_ m: Message) {
        run("set r to reply (first message of inbox whose message id is \"\(q(m.id))\") opening window yes\nactivate")
        note = "A reply draft is open in Mail. Press Send there."
    }
}

struct MailView: View {
    @ObservedObject var mail: MailCenter
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "envelope").font(.system(size: 10)).foregroundStyle(Ink.muted)
                Text("Mail · Inbox").font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Ink.text)
                if !mail.messages.isEmpty { Text("\(mail.messages.count) unread").font(.system(size: 10.5)).foregroundStyle(Color(hex: "#60A5FA")) }
                Spacer()
                Button { mail.refresh() } label: { Image(systemName: "arrow.clockwise").font(.system(size: 10)) }.buttonStyle(.plain).foregroundStyle(Ink.dim).help(T("Refresh"))
            }
            if let id = mail.selected, let m = mail.messages.first(where: { $0.id == id }) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Button { mail.selected = nil } label: { Image(systemName: "chevron.left").font(.system(size: 10)) }.buttonStyle(.plain).foregroundStyle(Ink.muted)
                        Text(m.sender).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Ink.text).lineLimit(1)
                        Spacer(); Text(m.ago).font(.system(size: 10.5)).foregroundStyle(Ink.dim)
                    }
                    Text(m.subject).font(.system(size: 11.5)).foregroundStyle(Ink.text.opacity(0.9)).lineLimit(1)
                    Text(m.excerpt).font(.system(size: 11)).foregroundStyle(Ink.muted).lineLimit(3)
                    HStack(spacing: 8) {
                        Button(T("Open in Mail")) { mail.openInMail(m) }
                        Button(T("Reply")) { mail.reply(m) }
                        Button(T("Mark as read")) { mail.markRead(m); mail.selected = nil }
                    }
                    .buttonStyle(.plain).font(.system(size: 11, weight: .medium)).foregroundStyle(Color(hex: "#60A5FA"))
                }
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(mail.messages) { m in
                            HStack(spacing: 6) {
                                Circle().fill(Color(hex: "#60A5FA")).frame(width: 5, height: 5)
                                Text(m.sender).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Ink.text).lineLimit(1).frame(maxWidth: 120, alignment: .leading)
                                Text(m.ago).font(.system(size: 10)).foregroundStyle(Ink.dim)
                                Text(m.subject).font(.system(size: 11)).foregroundStyle(Ink.muted).lineLimit(1)
                                Spacer(minLength: 0)
                            }
                            .contentShape(Rectangle())
                            .onTapGesture { mail.selected = m.id }
                        }
                    }
                }
            }
            if !mail.note.isEmpty { Text(mail.note).font(.system(size: 10.5)).foregroundStyle(Ink.dim).lineLimit(2) }
        }
        .onAppear { mail.refresh() }
    }
}

// MARK: - the week at a glance

struct RecapView: View {
    @ObservedObject var bridge: OxBridge
    @State private var week: [String: Any] = [:]
    @State private var saved = ""

    var body: some View {
        let dict = DictationStats.week()
        let total = week["total"] as? [String: Any] ?? [:]
        let tokens = ((total["in"] as? Int) ?? 0) + ((total["out"] as? Int) ?? 0)
        let runs = total["runs"] as? Int ?? 0
        let top = ((week["byModel"] as? [[String: Any]])?.first?["key"] as? String) ?? "—"
        let days = (week["byDay"] as? [[String: Any]]) ?? []
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Your week with \(OxName.current)").font(.system(size: 12, weight: .semibold)).foregroundStyle(Ink.text)
                Spacer()
                Button(saved.isEmpty ? "Save as image" : saved) { saveImage(tokens: tokens, runs: runs, top: top, dict: dict) }
                    .buttonStyle(.plain).font(.system(size: 10.5)).foregroundStyle(Color(hex: "#60A5FA"))
            }
            HStack(spacing: 18) {
                stat(week.isEmpty ? "…" : "\(runs)", T("runs"))
                stat(week.isEmpty ? "…" : tokens >= 1_000_000 ? String(format: "%.1fM", Double(tokens) / 1e6) : tokens >= 1000 ? String(format: "%.0fk", Double(tokens) / 1000) : "\(tokens)", "tokens")
                stat("\(dict.words)", T("words dictated"))
                stat("\(dict.savedMinutes) min", T("saved typing"))
                stat("\(dict.wpm)", T("words/min")).help(dict.apps.isEmpty ? "Speaking speed" : "Dictated most into: " + dict.apps.map { "\($0.0) (\($0.1) words)" }.joined(separator: ", "))
                if let code = week["code"] as? [String: Any], let f = code["files"] as? Int, f > 0 {
                    stat("\(f)", T("files changed")).help("From git this week, in the folders ox's runs worked in: \(code["commits"] as? Int ?? 0) commits")
                    stat("+\(code["added"] as? Int ?? 0) −\(code["removed"] as? Int ?? 0)", T("lines"))
                    if let share = code["aiShare"] as? Int {
                        // Coucou's "Claude wrote 90% of your code": from the commits' authors and Co-authored-by lines.
                        stat("\(share)%", T("written with AI")).help("\(code["aiCommits"] as? Int ?? 0) of \(code["commits"] as? Int ?? 0) commits this week name an AI as author or co-author")
                    }
                }
                stat(top, T("most used"))
                stat(waterText(), T("water (est.)")).help("Estimated data-centre cooling water for cloud models: ~18 mL per 1,000 tokens, from Li et al. 2023, \"Making AI Less Thirsty\" (about 0.5 L per 20–50 responses). Local models are not counted." + (waterByTool().isEmpty ? "" : "\nBy tool: " + waterByTool().map { "\($0.0) \(litres($0.1))" }.joined(separator: ", ")))
            }
            // Runs per day, the last 7 days.
            HStack(alignment: .bottom, spacing: 6) {
                let counts = days.suffix(7).map { (($0["runs"] as? Int) ?? 0) }
                let mx = max(1, counts.max() ?? 1)
                ForEach(Array(counts.enumerated()), id: \.offset) { _, c in
                    RoundedRectangle(cornerRadius: 3).fill(Color(hex: "#7C5CFF").opacity(0.85)).frame(width: 18, height: max(3, CGFloat(c) / CGFloat(mx) * 34))
                }
            }
            .frame(height: 36, alignment: .bottom)
        }
        .onAppear(perform: load)
    }

    /// Water per tool (Claudex): cloud tokens grouped by who runs the model.
    private func waterByTool() -> [(String, Double)] {
        var by: [String: Double] = [:]
        for m in (week["byModel"] as? [[String: Any]]) ?? [] {
            let k = (m["key"] as? String ?? "").lowercased()
            if k.contains("ollama") || k.contains("qwen2.5") || k.contains("llama3") || k.hasPrefix("local") { continue }
            let tool = k.contains("claude") || k.contains("anthropic") || k.contains("opus") || k.contains("sonnet") || k.contains("haiku") ? "Claude"
                : k.contains("gpt") || k.contains("codex") || k.contains("openai") || k.contains("o3") || k.contains("o4") ? "OpenAI"
                : k.contains("gemini") || k.contains("google") ? "Gemini" : k.contains("grok") ? "Grok" : k.contains("mistral") ? "Mistral" : "Other"
            by[tool, default: 0] += Double((m["in"] as? Int) ?? 0) + Double((m["out"] as? Int) ?? 0)
        }
        return by.map { ($0.key, $0.value / 1000 * 0.018) }.filter { $0.1 > 0 }.sorted { $0.1 > $1.1 }
    }
    private func litres(_ l: Double) -> String { l < 1 ? String(format: "%.0f mL", l * 1000) : String(format: "%.1f L", l) }

    /// Cloud tokens only: local models (Ollama) cool on your own desk.
    private func waterText() -> String {
        let models = (week["byModel"] as? [[String: Any]]) ?? []
        let cloud = models.filter { m in
            let k = (m["key"] as? String ?? "").lowercased()
            return !(k.contains("ollama") || k.contains("qwen2.5") || k.contains("llama3") || k.hasPrefix("local"))
        }.reduce(0) { $0 + (($1["in"] as? Int) ?? 0) + (($1["out"] as? Int) ?? 0) }
        let litres = Double(cloud) / 1000 * 0.018
        return litres < 1 ? String(format: "%.0f mL", litres * 1000) : String(format: "%.1f L", litres)
    }

    private func stat(_ v: String, _ l: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(v).font(.system(size: 15, weight: .semibold, design: .rounded)).foregroundStyle(Ink.text).lineLimit(1)
            Text(l).font(.system(size: 10)).foregroundStyle(Ink.dim)
        }
    }

    private func load() {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let docs = ["serve.json", "app.json"].compactMap { n -> Int? in
            guard let d = try? Data(contentsOf: home.appendingPathComponent(".ox/\(n)")), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return nil }
            if let pid = j["pid"] as? Int, kill(pid_t(pid), 0) != 0 { return nil }   // a server that is gone
            return j["port"] as? Int
        }
        guard let port = docs.first, let url = URL(string: "http://127.0.0.1:\(port)/ox/usage?days=7") else { return }
        URLSession.shared.dataTask(with: url) { d, _, _ in
            let j = d.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            DispatchQueue.main.async { week = j }
        }.resume()
    }

    /// A shareable picture of the week, on the Desktop.
    private func saveImage(tokens: Int, runs: Int, top: String, dict: DictationStats.Summary) {
        let card = VStack(alignment: .leading, spacing: 10) {
            Text("My week with \(OxName.current)").font(.system(size: 22, weight: .bold, design: .rounded))
            Text("\(runs) runs · \(tokens) tokens · \(dict.words) words dictated · \(dict.savedMinutes) min saved").font(.system(size: 14))
            if let code = week["code"] as? [String: Any], let f = code["files"] as? Int, f > 0 {
                Text("\(f) files changed · +\(code["added"] as? Int ?? 0) −\(code["removed"] as? Int ?? 0) lines · \(code["commits"] as? Int ?? 0) commits").font(.system(size: 14))
            }
            Text("Most used: \(top)").font(.system(size: 13)).opacity(0.7)
        }
        .foregroundStyle(.white).padding(28).frame(width: 560, alignment: .leading).background(Color(hex: "#141518"))
        let r = ImageRenderer(content: card)
        r.scale = 2
        let out = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Desktop/ox-week.png")
        if let img = r.nsImage, let tiff = img.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            try? png.write(to: out); saved = "Saved to Desktop"
        }
    }
}
