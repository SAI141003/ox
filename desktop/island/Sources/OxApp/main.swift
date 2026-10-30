import AppKit
import WebKit

// OX, the desktop app on macOS: one window onto the ox running on this Mac.
// It shows the same chat as `ox serve` (agents, modes, approvals, sessions),
// so the terminal, the island and this window are one ox, not three.
//
// `ox app` starts the local server and opens this app with OX_APP_URL set;
// opened from the Dock it asks `ox` for the URL the same way.

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    private var desktopPet: DesktopPetController!
    private var pendingPetEvent: String?

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        let config = WKWebViewConfiguration()
        config.preferences.isElementFullscreenEnabled = true
        config.userContentController.add(self, name: "oxMiniPet")
        config.userContentController.addUserScript(WKUserScript(
            source: "document.documentElement.classList.add('native-desktop-pet');",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
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

        desktopPet = DesktopPetController()
        desktopPet.onOpenChat = { [weak self] in self?.openMain(with: "ox:pet-open-chat") }
        desktopPet.onTalk = { [weak self] in self?.openMain(with: "ox:pet-talk") }
        desktopPet.onSettings = { [weak self] in self?.openMain(with: "ox:pet-settings") }
        desktopPet.onHide = { [weak self] in
            guard let self else { return }
            self.web.evaluateJavaScript("window.dispatchEvent(new Event('ox:pet-hide'))")
        }
        load()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "oxMiniPet", let state = message.body as? [String: Any] else { return }
        desktopPet.update(state)
    }

    private func openMain(with event: String) {
        pendingPetEvent = event
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        if !web.isLoading { deliverPendingPetEvent() }
    }

    private func deliverPendingPetEvent() {
        guard let event = pendingPetEvent else { return }
        pendingPetEvent = nil
        let safeEvent = event.replacingOccurrences(of: "'", with: "")
        web.evaluateJavaScript("window.dispatchEvent(new Event('\(safeEvent)'))")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        deliverPendingPetEvent()
    }

    /// The page to show: given by `ox app`, or asked of `ox` when opened from the Dock.
    /// The server went away (stopped, updated, crashed): ask ox again, which
    /// starts a new one, at most once every 10 s.
    private var lastRecover = Date.distantPast
    private var usedEnvURL = false
    func recover() {
        guard Date().timeIntervalSince(lastRecover) > 10 else { return }
        lastRecover = Date()
        usedEnvURL = true
        load()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let host = webView.url?.host ?? (error as NSError).userInfo[NSURLErrorFailingURLStringErrorKey].flatMap { URL(string: "\($0)")?.host }
        if host == "127.0.0.1" || host == "localhost" { recover() }
    }

    /// Opened again from the Dock or by `ox app`: if the server is gone, bring it back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        checkServer()
        if !window.isVisible { window.makeKeyAndOrderFront(nil) }
        return true
    }
    func applicationDidBecomeActive(_ notification: Notification) { checkServer() }

    private func checkServer() {
        guard let u = web.url, u.host == "127.0.0.1" || u.host == "localhost" else { return }
        var req = URLRequest(url: u.appendingPathComponent("health"))
        req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { [weak self] _, resp, _ in
            if resp == nil { DispatchQueue.main.async { self?.recover() } }
        }.resume()
    }

    /// The ox server this window was pointed at: the only origin given the microphone.
    private var oxOrigin: (scheme: String, host: String, port: Int)?

    private func loadOx(_ url: URL) {
        if let host = url.host, let scheme = url.scheme {
            oxOrigin = (scheme, host, url.port ?? (scheme == "https" ? 443 : 80))
        }
        web.load(URLRequest(url: url))
    }

    func load() {
        if !usedEnvURL, let s = ProcessInfo.processInfo.environment["OX_APP_URL"], let u = URL(string: s) {
            // `ox app` may have handed this process a URL from an older server.
            // Loading it blindly leaves the native window on a permanent blank
            // / "Starting ox…" page when that port has since been recycled.
            // Verify the endpoint first; if it is stale, ask ox for the current
            // server instead of waiting for WebKit's provisional navigation to
            // fail (which is not reliable for an about:blank startup page).
            showMessage("Connecting to ox…")
            var req = URLRequest(url: u.appendingPathComponent("health"))
            req.timeoutInterval = 1.5
            URLSession.shared.dataTask(with: req) { [weak self] _, response, _ in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                        self.loadOx(u)
                    } else {
                        self.usedEnvURL = true
                        self.load()
                    }
                }
            }.resume()
            return
        }
        showMessage("Starting ox…")
        DispatchQueue.global().async {
            let url = Self.askOxForURL()
            // The island comes with ox: started here when it is switched on (Settings).
            _ = Self.ox(["island", "start"])
            DispatchQueue.main.async {
                if let url { self.loadOx(url) }
                else { self.showMessage(Self.oxPaths() == nil ? "ox is not on this Mac yet. Download OX for Mac from github.com/SAI141003/ox/releases and open it from there." : "ox did not start. Open OX again; if it still does not start, run  ox doctor  in a terminal to see why.") }
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
                    if let url { self.loadOx(url) }
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
        let fm = FileManager.default
        // Every candidate is checked on disk: a path that is gone (a deleted
        // test build) is skipped, never handed to Process.
        let usable = { (n: String?, c: String?) -> (String, String)? in
            guard let n, let c, fm.isExecutableFile(atPath: n), fm.fileExists(atPath: c) else { return nil }
            return (n, c)
        }
        let env = ProcessInfo.processInfo.environment
        if let p = usable(env["OX_NODE"], env["OX_CLI"]) { return p }
        if let res = Bundle.main.resourceURL {
            // A downloaded release: its own Node and ox inside.
            if let p = usable(res.appendingPathComponent("node").path, res.appendingPathComponent("ox/bin/ox.js").path) { return p }
            // `ox app install`: the Node and ox it was installed from.
            if let d = fm.contents(atPath: res.appendingPathComponent("ox-paths.json").path),
               let j = try? JSONSerialization.jsonObject(with: d) as? [String: String],
               let p = usable(j["node"], j["cli"]) { return p }
        }
        let saved = savedState()
        if let p = usable(saved["node"], saved["cli"]) { return p }
        // Last: the usual places for Node and an ox checkout.
        let home = NSHomeDirectory()
        for n in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node", home + "/.volta/bin/node"] {
            for c in [home + "/ox/bin/ox.js", "/opt/homebrew/lib/node_modules/ox-agent/bin/ox.js", "/usr/local/lib/node_modules/ox-agent/bin/ox.js"] {
                if let p = usable(n, c) { return p }
            }
        }
        return nil
    }

    static func savedState() -> [String: String] {
        guard let d = FileManager.default.contents(atPath: NSHomeDirectory() + "/.ox/app.json"),
              let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
        return j.compactMapValues { $0 as? String }
    }

    /// Dock launches have no caller-selected project. Reuse the last project
    /// unless it is ox's own source tree; in that case start in a clean,
    /// dedicated workspace so normal app use cannot accidentally edit ox.
    /// `ox app` from a terminal and File > Open Folder remain explicit choices.
    static func defaultWorkingDirectory() -> String {
        let fm = FileManager.default
        let home = NSHomeDirectory()
        let workspace = URL(fileURLWithPath: home)
            .appendingPathComponent("Documents", isDirectory: true)
            .appendingPathComponent("Ox Workspace", isDirectory: true)
        let saved = savedState()["cwd"]
        if let saved, fm.fileExists(atPath: saved), !isOxSourcePath(saved) {
            return saved
        }
        try? fm.createDirectory(at: workspace, withIntermediateDirectories: true)
        return workspace.path
    }

    private static func isOxSourcePath(_ candidate: String) -> Bool {
        guard let (_, cli) = oxPaths() else { return false }
        let fm = FileManager.default
        let root = URL(fileURLWithPath: cli)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .standardizedFileURL.resolvingSymlinksInPath()
        let path = URL(fileURLWithPath: candidate)
            .standardizedFileURL.resolvingSymlinksInPath()
        let package = root.appendingPathComponent("package.json")
        guard let data = fm.contents(atPath: package.path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["name"] as? String == "ox-agent" else { return false }
        return path.path == root.path || path.path.hasPrefix(root.path + "/")
    }

    /// Run one ox command (in `cwd`) and return its last line of output.
    static func ox(_ args: [String], cwd: String? = nil) -> String? {
        guard let (node, cli) = oxPaths() else { return nil }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [cli] + args
        p.currentDirectoryURL = URL(fileURLWithPath: cwd ?? defaultWorkingDirectory())
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
        p.currentDirectoryURL = URL(fileURLWithPath: cwd ?? defaultWorkingDirectory())
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

    // The chat's microphone: only ox's own page (the exact scheme, loopback host
    // and port this window loaded) may use it; macOS still asks the person once,
    // through NSMicrophoneUsageDescription. Another local service on a different
    // port is a different origin and is refused, as is everything else.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let loopback = ["127.0.0.1", "localhost", "::1"].contains(origin.host)
        let port = origin.port == 0 ? (origin.protocol == "https" ? 443 : 80) : origin.port
        let ours = oxOrigin.map { $0.scheme == origin.protocol && $0.host == origin.host && $0.port == port } ?? false
        decisionHandler(loopback && ours && type == .microphone ? .grant : .deny)
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

    // The main chat window can close while the independent desktop companion
    // remains visible. Quit Ox explicitly from its menu to stop both.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

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
