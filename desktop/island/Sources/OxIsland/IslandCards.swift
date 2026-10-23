import AppKit
import SwiftUI

/// Read-only view of the WhatsApp desktop window already on this Mac. WhatsApp
/// has no supported local history API; we therefore read only visible
/// accessibility text after the user opens/selects a chat, never scrape its
/// private database or claim that Cloud API messages are personal messages.
final class WhatsAppCenter: ObservableObject {
    struct Line: Identifiable, Equatable { let id = UUID(); let text: String }
    @Published private(set) var lines: [Line] = []
    @Published private(set) var note = ""

    private var open: Bool { NSWorkspace.shared.runningApplications.contains { ($0.localizedName ?? "").lowercased().contains("whatsapp") } }
    func refresh() {
        if !open {
            note = "Opening WhatsApp… select a chat, then refresh."
            NSWorkspace.shared.launchApplication(withBundleIdentifier: "net.whatsapp.WhatsApp", options: [], additionalEventParamDescriptor: nil, launchIdentifier: nil)
            return
        }
        note = "Reading the visible WhatsApp chat…"
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let script = ##"""
tell application "System Events" to tell process "WhatsApp"
if exists front window then
  set xs to value of every static text of front window
  return xs as text
else
  return ""
end if
end tell
"""##
            var err: NSDictionary?
            let raw = NSAppleScript(source: script)?.executeAndReturnError(&err).stringValue ?? ""
            let values = raw.components(separatedBy: ", ").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { $0.count > 1 }
            DispatchQueue.main.async {
                guard let self else { return }
                self.lines = values.suffix(12).map { Line(text: $0) }
                if let err { self.note = "WhatsApp access needs Accessibility permission: \((err[NSAppleScript.errorMessage] as? String) ?? "allow OX Island")" }
                else if self.lines.isEmpty { self.note = "Open a WhatsApp chat, then press refresh; only visible text is available." }
                else { self.note = "Visible chat text only · WhatsApp does not expose personal history to Ox." }
            }
        }
    }
}

struct WhatsAppView: View {
    @ObservedObject var whatsapp: WhatsAppCenter
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack { Image(systemName: "message").foregroundStyle(Ink.muted); Text("WhatsApp · on this Mac").font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Ink.text); Spacer(); Button { whatsapp.refresh() } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(.plain).foregroundStyle(Ink.dim) }
            ScrollView { VStack(alignment: .leading, spacing: 3) { ForEach(whatsapp.lines) { Text($0.text).font(.system(size: 11)).foregroundStyle(Ink.text).lineLimit(3).padding(.vertical, 2) } } }
            if !whatsapp.note.isEmpty { Text(whatsapp.note).font(.system(size: 10)).foregroundStyle(Ink.dim).lineLimit(3) }
        }.onAppear { whatsapp.refresh() }
    }
}

// Cards under the + tab: mail from the Mail app (Coucou's mail in the notch)
// and the week at a glance (Coucou's weekly recap). Mail access stays local
// to the user's Mail app; the Island can open Mail to refresh, while replies
// remain drafts the user sends themselves.

final class MailCenter: ObservableObject {
    struct Message: Identifiable, Equatable {
        let id: String
        let mailID: String
        let account: String
        let address: String
        let sender: String
        let subject: String
        let ago: String
        let unread: Bool
        let excerpt: String
    }
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
              set accts to every account whose enabled is true
              repeat with ai from 1 to count of accts
                set a to item ai of accts
                set accountName to name of a
                set accountAddress to ""
                try
                  set addrs to email addresses of a
                  if (count of addrs) > 0 then set accountAddress to item 1 of addrs
                end try
                set boxes to every mailbox of a
                repeat with bi from 1 to count of boxes
                  set b to item bi of boxes
                  set boxName to (name of b as text)
                  if boxName is "INBOX" or boxName is "Inbox" then
                    set ms to messages of b
                  else
                    set ms to {}
                  end if
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
                    set out to out & (message id of m) & tab & accountName & tab & accountAddress & tab & (sender of m) & tab & (subject of m) & tab & (read status of m is false) & tab & secs & tab & c & linefeed & "␞" & linefeed
                  end repeat
                end repeat
              end repeat
            end tell
            return out
            """
            var err: NSDictionary?
            let raw = NSAppleScript(source: script)?.executeAndReturnError(&err).stringValue ?? ""
            let msgs = raw.components(separatedBy: "\n␞\n").compactMap { chunk -> Message? in
                let f = chunk.components(separatedBy: "\t")
                guard f.count >= 7, !f[0].isEmpty else { return nil }
                let secs = Int(Double(f[6].trimmingCharacters(in: .whitespaces)) ?? 0)
                let ago = secs < 3600 ? "\(max(1, secs / 60))m" : secs < 86400 ? "\(secs / 3600)h" : "\(secs / 86400)d"
                let sender = f[3].replacingOccurrences(of: #"\s*<.*>$"#, with: "", options: .regularExpression)
                let account = f[1].isEmpty ? "Mail account" : f[1]
                let excerpt = f.count > 7 ? f[7...].joined(separator: " ").replacingOccurrences(of: "\n", with: " ") : ""
                return Message(id: "\(account)|\(f[0])", mailID: f[0], account: account, address: f[2], sender: sender, subject: f[4], ago: ago, unread: f[5].lowercased() == "true", excerpt: excerpt)
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.messages = msgs
                if let err {
                    let detail = (err[NSAppleScript.errorMessage] as? String) ?? "Mail did not answer"
                    self.note = "Mail access needs approval: \(detail). Open System Settings › Privacy & Security › Automation and allow OX Island, then refresh."
                } else {
                    self.note = msgs.isEmpty ? "No recent mail across your Mail accounts." : ""
                }
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
        run("set read status of (first message of inbox whose message id is \"\(q(m.mailID))\") to true") { [weak self] in
            self?.messages.removeAll { $0 == m }
        }
    }
    func openInMail(_ m: Message) {
        run("open (first message of inbox whose message id is \"\(q(m.mailID))\")\nactivate")
    }
    /// A reply draft opens in Mail; you read it and press Send there.
    func reply(_ m: Message) {
        run("set r to reply (first message of inbox whose message id is \"\(q(m.mailID))\") opening window yes\nactivate")
        note = "A reply draft is open in Mail. Press Send there."
    }

    /// macOS Automation grants are per application.  A successful Terminal
    /// AppleScript does not grant the Island permission, so give the user a
    /// direct recovery path instead of leaving an unexplained empty inbox.
    func openAutomationSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation") else { return }
        NSWorkspace.shared.open(url)
    }
}

struct MailView: View {
    @ObservedObject var mail: MailCenter
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "envelope").font(.system(size: 10)).foregroundStyle(Ink.muted)
                Text("Mail · Inbox").font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Ink.text)
                let unreadCount = mail.messages.filter(\.unread).count
                if unreadCount > 0 { Text("\(unreadCount) unread").font(.system(size: 10.5)).foregroundStyle(Color(hex: "#60A5FA")) }
                if !mail.messages.isEmpty {
                    let accountCount = Set(mail.messages.map { $0.account }).count
                    if accountCount > 1 { Text("\(accountCount) accounts").font(.system(size: 9.5)).foregroundStyle(Ink.dim) }
                }
                Spacer()
                Button { mail.refresh() } label: { Image(systemName: "arrow.clockwise").font(.system(size: 10)) }.buttonStyle(.plain).foregroundStyle(Ink.dim).help(T("Refresh"))
            }
            if let id = mail.selected, let m = mail.messages.first(where: { $0.id == id }) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Button { mail.selected = nil } label: { Image(systemName: "chevron.left").font(.system(size: 10)) }.buttonStyle(.plain).foregroundStyle(Ink.muted)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(m.sender).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Ink.text).lineLimit(1)
                            Text(m.address.isEmpty ? m.account : "\(m.account) · \(m.address)").font(.system(size: 9.5)).foregroundStyle(Ink.dim).lineLimit(1)
                        }
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
                                Circle().fill(m.unread ? Color(hex: "#60A5FA") : Ink.dim).frame(width: 5, height: 5)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(m.sender).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Ink.text).lineLimit(1)
                                    Text(m.address.isEmpty ? m.account : m.account).font(.system(size: 9)).foregroundStyle(Color(hex: "#60A5FA")).lineLimit(1)
                                }.frame(maxWidth: 145, alignment: .leading)
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
            if mail.note.localizedCaseInsensitiveContains("needs approval") {
                HStack(spacing: 8) {
                    Button(T("Open Automation Settings")) { mail.openAutomationSettings() }
                    Button(T("Try again")) { mail.refresh() }
                }
                .buttonStyle(.plain).font(.system(size: 10.5, weight: .medium)).foregroundStyle(Color(hex: "#60A5FA"))
            }
            if !mail.note.isEmpty {
                Text(mail.note).font(.system(size: 10.5)).foregroundStyle(mail.note.hasPrefix("Mail access") ? Color(hex: "#FBBF24") : Ink.dim).lineLimit(3)
            }
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
