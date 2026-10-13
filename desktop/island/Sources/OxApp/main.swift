import AppKit
import WebKit

// OX, the desktop app on macOS: one window onto the ox running on this Mac.
// It shows the same chat as `ox serve` (agents, modes, approvals, sessions),
// so the terminal, the island and this window are one ox, not three.
//
// `ox app` starts the local server and opens this app with OX_APP_URL set;
// opened from the Dock it asks `ox` for the URL the same way.

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        let config = WKWebViewConfiguration()
        config.preferences.isElementFullscreenEnabled = true
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground") // no white flash before the dark page paints

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 760),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "ox"
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(red: 0.055, green: 0.059, blue: 0.071, alpha: 1)
        window.minSize = NSSize(width: 520, height: 420)
        window.contentView = web
        window.setFrameAutosaveName("ox.main")
        if !window.setFrameUsingName("ox.main") { window.center() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        load()
    }

    /// The page to show: given by `ox app`, or asked of `ox` when opened from the Dock.
    func load() {
        if let s = ProcessInfo.processInfo.environment["OX_APP_URL"], let u = URL(string: s) {
            web.load(URLRequest(url: u))
            return
        }
        showMessage("Starting ox…")
        DispatchQueue.global().async {
            let url = Self.askOxForURL()
            // The island comes with ox: started here when it is switched on (Settings).
            _ = Self.ox(["island", "start"])
            DispatchQueue.main.async {
                if let url { self.web.load(URLRequest(url: url)) }
                else { self.showMessage("Could not start ox. Run  ox app  once in a terminal, then open OX again.") }
            }
        }
    }

    /// File › Open Folder…: ox works in the folder you pick.
    @objc func openFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.prompt = "Work here"
        panel.beginSheetModal(for: window) { r in
            guard r == .OK, let dir = panel.url?.path else { return }
            self.showMessage("Opening \((dir as NSString).lastPathComponent)…")
            DispatchQueue.global().async {
                let url = Self.askOxForURL(cwd: dir)
                DispatchQueue.main.async {
                    if let url { self.web.load(URLRequest(url: url)) }
                    self.window.title = "ox — \((dir as NSString).lastPathComponent)"
                }
            }
        }
    }

    /// Put `ox` on the command line: a small script in ~/.local/bin that runs
    /// the ox inside this app (no administrator password needed).
    @objc func installCommand() {
        guard let (node, cli) = Self.oxPaths() else { return }
        let dir = NSHomeDirectory() + "/.local/bin"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let script = "#!/bin/sh\nexec \"\(node)\" \"\(cli)\" \"$@\"\n"
        let path = dir + "/ox"
        let a = NSAlert()
        do {
            try script.write(toFile: path, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path)
            let onPath = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").contains { $0 == Substring(dir) }
            a.messageText = "Installed: ox"
            a.informativeText = onPath ? "Open a terminal and type  ox" : "Installed at \(path). Add ~/.local/bin to your PATH, then type  ox  in a terminal."
        } catch {
            a.messageText = "Could not install the ox command"
            a.informativeText = error.localizedDescription
        }
        a.beginSheetModal(for: window)
    }

    /// The ox to run: the one inside this app (a downloaded release carries its
    /// own Node and ox), else the one that last opened it.
    static func oxPaths() -> (node: String, cli: String)? {
        let env = ProcessInfo.processInfo.environment
        if let n = env["OX_NODE"], let c = env["OX_CLI"] { return (n, c) }
        if let res = Bundle.main.resourceURL {
            let n = res.appendingPathComponent("node").path, c = res.appendingPathComponent("ox/bin/ox.js").path
            if FileManager.default.isExecutableFile(atPath: n), FileManager.default.fileExists(atPath: c) { return (n, c) }
        }
        let saved = savedState()
        if let n = saved["node"], let c = saved["cli"] { return (n, c) }
        return nil
    }

    static func savedState() -> [String: String] {
        guard let d = FileManager.default.contents(atPath: NSHomeDirectory() + "/.ox/app.json"),
              let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
        return j.compactMapValues { $0 as? String }
    }

    /// Run one ox command (in `cwd`) and return its last line of output.
    static func ox(_ args: [String], cwd: String? = nil) -> String? {
        guard let (node, cli) = oxPaths() else { return nil }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [cli] + args
        p.currentDirectoryURL = URL(fileURLWithPath: cwd ?? savedState()["cwd"] ?? NSHomeDirectory())
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        p.waitUntilExit()
        let out = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        return out.split(separator: "\n").last.map { String($0).trimmingCharacters(in: .whitespaces) }
    }

    /// `ox app --print-url` starts the server if needed and prints where it is.
    static func askOxForURL(cwd: String? = nil) -> URL? {
        guard let (node, cli) = oxPaths() else { return nil }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [cli, "app", "--print-url"]
        p.currentDirectoryURL = URL(fileURLWithPath: cwd ?? savedState()["cwd"] ?? NSHomeDirectory())
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        p.waitUntilExit()
        let out = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        return out.split(separator: "\n").last.flatMap { URL(string: String($0).trimmingCharacters(in: .whitespaces)) }
    }

    func showMessage(_ text: String) {
        let html = "<html><body style='margin:0;height:100vh;display:grid;place-items:center;background:#0E0F12;color:#8E939C;font:14px -apple-system'>\(text)</body></html>"
        web.loadHTMLString(html, baseURL: nil)
    }

    // Links to other sites open in the browser, not inside ox.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = action.request.url, action.navigationType == .linkActivated, !(u.host == "127.0.0.1" || u.host == "localhost") {
            NSWorkspace.shared.open(u)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // The chat's attach button: a real file picker.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { r in completionHandler(r == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    /// The standard menus: without Edit, ⌘C / ⌘V / ⌘A do nothing in a web view.
    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About ox", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Install Command-Line Tool…", action: #selector(installCommand), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide ox", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit ox", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let fileItem = NSMenuItem(); main.addItem(fileItem)
        let file = NSMenu(title: "File")
        file.addItem(withTitle: "Open Folder…", action: #selector(openFolder), keyEquivalent: "o")
        fileItem.submenu = file

        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        viewItem.submenu = view

        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        winItem.submenu = win
        NSApp.windowsMenu = win
        NSApp.mainMenu = main
    }

    @objc func reload() { web.reload() }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
