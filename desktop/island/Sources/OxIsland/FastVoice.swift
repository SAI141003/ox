import AppKit
import ApplicationServices
import Foundation

/// Voice control's hot path, done inside the island itself.
///
/// A spoken command used to travel: island → the app's server → a new `ox do`
/// process → ox-hands, started once per key. Measured on an M3: 0.45 s for one
/// key, 0.8 s to type a sentence, 1 s for "clear", on top of the wait for the
/// end of the sentence. The commands said most ("new chat", "type …", "send",
/// "open Claude", plain dictation) are a key press or some typed characters,
/// and the island already holds the Accessibility permission: here they are
/// done in a few milliseconds, with no process started.
///
/// The words are the same ones src/voice-control.js knows (WINDOW_WORDS,
/// EDIT_WORDS, SEND_WORDS, TYPE_WORDS): a change there belongs here too. What
/// this file does not know (timers, music, search, sessions, clicking a named
/// button) returns nil and takes the long way, unchanged.
enum FastVoice {
    enum Step: Equatable {
        case keys([Key])
        case type(String, focusedOnly: Bool)
        case send
        case open(String)      // the app's name as installed
        case newChat
    }
    struct Key: Equatable { let code: CGKeyCode; let mods: [String] }
    private static func k(_ code: CGKeyCode, _ mods: String...) -> Key { Key(code: code, mods: mods) }

    // What is said → what is pressed. Nothing here quits an app or deletes a file.
    private static let fixed: [(String, [Key])] = [
        (#"^close (?:this |the |that )?tab$"#, [k(13, "cmd")]),
        (#"^next tab$"#, [k(48, "ctrl")]),
        (#"^(?:previous|prev|last) tab$"#, [k(48, "ctrl", "shift")]),
        (#"^(?:go )?back$"#, [k(33, "cmd")]),
        (#"^(?:go )?forward$"#, [k(30, "cmd")]),
        (#"^(?:refresh|reload)(?: (?:the |this )?page)?$"#, [k(15, "cmd")]),
        (#"^zoom in$"#, [k(24, "cmd")]),
        (#"^zoom out$"#, [k(27, "cmd")]),
        (#"^(?:new|next) line$"#, [k(36, "shift")]),
        (#"^minimi[sz]e(?: (?:this|the|that))?(?: window)?$"#, [k(46, "cmd")]),
        (#"^(?:(?:enter|go|toggle|exit|leave) )?full ?screen$"#, [k(3, "cmd", "ctrl")]),
        (#"^hide(?: (?:this|the|that))?(?: (?:app|window))?$"#, [k(4, "cmd")]),
        (#"^(?:switch|change) (?:apps?|windows?)$|^(?:last|previous) app$"#, [k(48, "cmd")]),
        (#"^save(?: (?:it|this|that|the file|the document))?$"#, [k(1, "cmd")]),
        (#"^clear(?: (?:it|that|this|the text|the box|the field|everything|all))?$|^(?:delete|erase) (?:everything|all|it all|the text)$"#, [k(0, "cmd"), k(51)]),
        (#"^select (?:all|everything)$"#, [k(0, "cmd")]),
        (#"^copy(?: (?:that|this|it|the selection))?$"#, [k(8, "cmd")]),
        (#"^paste(?: (?:that|this|it|here))?$"#, [k(9, "cmd")]),
        (#"^cut(?: (?:that|this|it|the selection))?$"#, [k(7, "cmd")]),
        (#"^undo(?: (?:that|this|it))?$|^scratch that$"#, [k(6, "cmd")]),
        (#"^(?:scroll|page) down$"#, [k(121)]),
        (#"^(?:scroll|page) up$"#, [k(116)]),
        // ⌘↑ / ⌘↓: the cursor goes there in a text box, and a page scrolls there (Home and End only scroll).
        (#"^(?:scroll|go) to (?:the )?(?:top|start|beginning)$"#, [k(126, "cmd")]),
        (#"^(?:scroll|go) to (?:the )?(?:bottom|end)$"#, [k(125, "cmd")]),
        (#"^(?:delete|erase)(?: (?:that|this|it|the selection))?$"#, [k(51)]),
        (#"^(?:open |make )?(?:a )?new (?:window|document|file)$"#, [k(45, "cmd")]),
    ]
    private static let closeWindow = #"^close (?:this |the |that )?window$"#
    private static let newChat = #"^(?:(?:start|open|make|create|begin)\s+)?(?:a\s+)?new\s+(?:chat|conversation|session|thread|prompt)$"#
    private static let send = #"^(?:(?:press|hit|click|tap|push)\s+(?:on\s+)?(?:the\s+)?(?:send|enter|return|submit)(?:\s+(?:button|key))?|send(?:\s+(?:it|that|this|the message))?|enter|return|submit(?:\s+(?:it|that|this))?)$"#
    private static let typed = #"^(?:type in|type|enter text)[,:]?\s+(.+)$"#
    private static let thenSend = #"\s*,?\s+(?:and\s+(?:then\s+)?|then\s+)(?:(?:press|hit)\s+)?(?:send|enter)(?:\s+it)?$"#
    private static let open = #"^(?:open|launch|switch to|bring up|go to)\s+(?:the\s+)?(.+?)(?:\s+app)?$"#

    private static func match(_ pattern: String, _ text: String) -> [String]? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return nil }
        let ns = text as NSString
        guard let m = re.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<m.numberOfRanges).map { m.range(at: $0).location == NSNotFound ? "" : ns.substring(with: m.range(at: $0)) }
    }
    private static func clean(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: ".!?,"))
    }

    /// The steps for a sentence, or nil when it is not one of the fast ones.
    /// `apps`: the installed apps by lowercased name (injected in checks).
    static func parse(_ raw: String, apps: [String: String] = installedApps(), browserInFront: Bool = false) -> [Step]? {
        let t = clean(raw)
        guard !t.isEmpty else { return nil }
        if match(send, t) != nil { return [.send] }
        if match(newChat, t) != nil { return browserInFront ? nil : [.newChat] }
        if match(closeWindow, t) != nil { return [.keys([browserInFront ? k(13, "cmd", "shift") : k(13, "cmd")])] }
        for (pattern, keys) in fixed where match(pattern, t) != nil { return [.keys(keys)] }
        if let m = match(typed, t) {
            var words = m[1].trimmingCharacters(in: CharacterSet(charactersIn: "\"“”' "))
            if let tail = match(thenSend, words) {
                words = String(words.dropLast(tail[0].count)).trimmingCharacters(in: .whitespaces)
                return words.isEmpty ? nil : [.type(words, focusedOnly: false), .send]
            }
            return [.type(words, focusedOnly: false)]
        }
        if let m = match(open, t), let app = resolveApp(m[1], apps: apps) { return [.open(app)] }
        return nil
    }

    /// A sentence that cannot grow into a longer command: done the moment it is
    /// heard, with no wait for a pause ("new chat", "send", "go back"). "type …",
    /// "open …" and dictation are not: more words may follow.
    static func isWhole(_ raw: String) -> Bool {
        let t = clean(raw)
        // One word on its own ("send", "back", "save") may be the start of a sentence being
        // dictated ("send it to John tomorrow"): it waits for the pause like anything else.
        guard t.contains(" ") else { return false }
        if match(newChat, t) != nil || match(closeWindow, t) != nil || match(send, t) != nil { return true }
        return fixed.contains { match($0.0, t) != nil }
    }

    /// "open Claude", with an app of that name on this Mac: nothing more is expected after it.
    static func opensApp(_ raw: String) -> Bool {
        guard let m = match(open, clean(raw)) else { return false }
        return resolveApp(m[1], apps: installedApps()) != nil
    }

    // ---- apps -------------------------------------------------------------------

    private static var appCache: (at: Date, apps: [String: String], urls: [String: URL]) = (.distantPast, [:], [:])
    private static let spoken: [String: [String]] = [
        "codex": ["Codex", "ChatGPT"], "codecs": ["Codex", "ChatGPT"], "code x": ["Codex", "ChatGPT"], "open code": ["OpenCode"], "opencode": ["OpenCode"],
        "chat gpt": ["ChatGPT"], "chat g p t": ["ChatGPT"], "cloud": ["Claude"], "claud": ["Claude"], "clawed": ["Claude"], "claude code": ["Claude"], "claude app": ["Claude"],
        "curser": ["Cursor"], "chrome": ["Google Chrome"], "crome": ["Google Chrome"], "terminal": ["Terminal", "iTerm", "Ghostty", "Warp"],
        "code": ["Visual Studio Code", "Cursor"], "vs code": ["Visual Studio Code"], "vscode": ["Visual Studio Code"], "ox": ["OX"],
        "word": ["Microsoft Word"], "excel": ["Microsoft Excel"], "outlook": ["Microsoft Outlook"], "settings": ["System Settings"], "system preferences": ["System Settings"],
    ]
    private static func scanApps() {
        guard Date().timeIntervalSince(appCache.at) > 60 else { return }
        var apps: [String: String] = [:], urls: [String: URL] = [:]
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        for dir in ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", home + "/Applications"] {
            for name in (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? [] where name.hasSuffix(".app") {
                let n = String(name.dropLast(4))
                if apps[n.lowercased()] == nil { apps[n.lowercased()] = n; urls[n] = URL(fileURLWithPath: dir + "/" + name) }
            }
        }
        appCache = (Date(), apps, urls)
    }
    static func installedApps() -> [String: String] { scanApps(); return appCache.apps }
    static func resolveApp(_ said: String, apps: [String: String]) -> String? {
        let n = said.trimmingCharacters(in: .whitespaces).lowercased()
        if let a = apps[n] { return a }
        for other in spoken[n] ?? [] { if let a = apps[other.lowercased()] { return a } }
        return nil
    }

    // ---- doing it ---------------------------------------------------------------

    private static let work = DispatchQueue(label: "ox.fastvoice")
    private static var lastTyped: (at: Date, pid: pid_t) = (.distantPast, 0)

    private static func flags(_ mods: [String]) -> CGEventFlags {
        var f: CGEventFlags = []
        for m in mods { switch m { case "cmd": f.insert(.maskCommand); case "shift": f.insert(.maskShift); case "option": f.insert(.maskAlternate); case "ctrl": f.insert(.maskControl); default: break } }
        return f
    }
    private static func press(_ key: Key) {
        let src = CGEventSource(stateID: .hidSystemState)
        let d = CGEvent(keyboardEventSource: src, virtualKey: key.code, keyDown: true)
        let u = CGEvent(keyboardEventSource: src, virtualKey: key.code, keyDown: false)
        d?.flags = flags(key.mods); u?.flags = flags(key.mods)
        d?.post(tap: .cghidEventTap); usleep(6_000); u?.post(tap: .cghidEventTap); usleep(12_000)
    }
    /// The characters as key events (no clipboard; a Return is never among them).
    private static func typeOut(_ text: String) {
        let src = CGEventSource(stateID: .hidSystemState)
        let chars = Array(text.replacingOccurrences(of: "\n", with: " ").utf16)
        var i = 0
        while i < chars.count {
            let chunk = Array(chars[i..<min(i + 16, chars.count)])
            let d = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)
            let u = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
            chunk.withUnsafeBufferPointer { b in
                d?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: b.baseAddress)
                u?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: b.baseAddress)
            }
            d?.flags = []; u?.flags = []
            d?.post(tap: .cghidEventTap); usleep(3_000); u?.post(tap: .cghidEventTap); usleep(7_000)
            i += 16
        }
    }
    /// The role of what has the cursor, "" when the app does not say (Claude, ChatGPT and other Electron apps).
    private static func focusedRole() -> String {
        let sys = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(sys, 0.25)
        var el: CFTypeRef?
        guard AXUIElementCopyAttributeValue(sys, kAXFocusedUIElementAttribute as CFString, &el) == .success, let e = el else { return "" }
        var role: CFTypeRef?
        AXUIElementCopyAttributeValue(e as! AXUIElement, kAXRoleAttribute as CFString, &role)
        return role as? String ?? ""
    }
    static var browserIsInFront: Bool {
        let n = NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
        return n.range(of: "chrome|safari|arc|firefox|brave|edge|opera", options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// Run the steps. `done(ok, what)` on the main queue: what was done, in a few words.
    static func run(_ steps: [Step], done: @escaping (Bool, String) -> Void) {
        guard AXIsProcessTrusted() else { done(false, "Allow OX Island in System Settings › Privacy › Accessibility"); return }
        work.async {
            var said: [String] = []
            var ok = true
            for step in steps {
                switch step {
                case .keys(let keys): keys.forEach(press); said.append("done")
                case .send: press(Key(code: 36, mods: [])); said.append("sent")
                case .newChat: press(Key(code: 45, mods: ["cmd"])); said.append("new chat")
                case .open(let name):
                    let running = NSWorkspace.shared.runningApplications.first { $0.localizedName == name && $0.activationPolicy == .regular }
                    if let running { running.activate(options: [.activateAllWindows]) }
                    else if let url = appCache.urls[name] { NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) }
                    else { ok = false; said.append("no \(name)"); continue }
                    // The next step (a new chat, typed words) waits until it is in front.
                    if steps.count > 1 { for _ in 0..<40 { if NSWorkspace.shared.frontmostApplication?.localizedName == name { break }; usleep(50_000) }; usleep(120_000) }
                    said.append("opened \(name)")
                case .type(let text, let focusedOnly):
                    let role = focusedRole()
                    // A named control that is not a text box (a button, a page with no field
                    // chosen): keys typed at it can be shortcuts. An app that names nothing gets the words.
                    if focusedOnly, !role.isEmpty, role.range(of: "TextArea|TextField|ComboBox|SearchField", options: .regularExpression) == nil {
                        ok = false; said.append("the cursor is not in a text box"); continue
                    }
                    // Sentence after sentence into the same app: a space between them.
                    let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
                    let joined = focusedOnly && pid == lastTyped.pid && Date().timeIntervalSince(lastTyped.at) < 45
                    typeOut((joined ? " " : "") + text)
                    lastTyped = (Date(), pid)   // dictation right after "type …" gets its space too
                    said.append("typed")
                }
                if !ok { break }
            }
            // Anything but dictation ends the run of sentences (a new chat, a send, another app).
            if !steps.contains(where: { if case .type = $0 { return true }; return false }) || steps.contains(.send) { lastTyped = (.distantPast, 0) }
            let what = said.joined(separator: ", ")
            DispatchQueue.main.async { done(ok, what) }
        }
    }
}
