// ox-hands: ox's hands on this Mac, in milliseconds. Reads an app's controls
// straight from the Accessibility API (no AppleScript: that took seconds per
// window) and clicks, types and presses keys with CoreGraphics events. The
// pointer moves where it clicks, so you see what ox does.
//
// Policy (what ox may press) lives in src/mac-control.js; this only acts.
// Every command prints one JSON line. `ox-hands serve` stays running and
// answers one JSON array of arguments per line: macOS charges ~70 ms to open
// the Accessibility link in each new process, so a warm one answers in a few ms.
//
//   ox-hands serve
//   ox-hands trusted
//   ox-hands activate <app>
//   ox-hands list [--app <app>] [--max N]
//   ox-hands at <x> <y>
//   ox-hands press --app <app> --path 0.3.1
//   ox-hands click <x> <y> [--double]
//   ox-hands type <text> [--app <app>]
//   ox-hands key <code> [--mods cmd,shift,option,ctrl] [--times N] [--app <app>]
import AppKit
import ApplicationServices
import Foundation

struct Reply: Error { let o: [String: Any] }
func emit(_ o: [String: Any]) throws -> Never { throw Reply(o: o) }

var argv: [String] = []
func opt(_ name: String) -> String? {
    guard let i = argv.firstIndex(of: "--\(name)"), i + 1 < argv.count else { return nil }
    return argv[i + 1]
}
var started = Date()
func ms() -> Int { Int(Date().timeIntervalSince(started) * 1000) }

let accessHint = "macOS has not given ox Accessibility. Open System Settings › Privacy & Security › Accessibility and turn on the app ox runs in (OX Island, OX, or your terminal), then ask again."

// MARK: apps and windows

/// The app in front, from Accessibility (always current; NSWorkspace's answer
/// only refreshes when a run loop turns, which a server loop does not).
func frontPid() -> pid_t? {
    var v: AnyObject?
    guard AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute as CFString, &v) == .success, let v,
          CFGetTypeID(v) == AXUIElementGetTypeID() else { return NSWorkspace.shared.frontmostApplication?.processIdentifier }
    var pid: pid_t = 0
    AXUIElementGetPid(v as! AXUIElement, &pid)
    return pid
}
func frontApp() -> NSRunningApplication? { frontPid().flatMap { NSRunningApplication(processIdentifier: $0) } }
/// Let AppKit take in what changed (apps launched or quit) without blocking.
func pump(_ seconds: Double = 0) { RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(seconds)) }

func runningApp(_ name: String) -> NSRunningApplication? {
    let n = name.lowercased()
    // Regular apps first; a background one (OX Island, menu-bar apps) only by its name.
    let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy != .prohibited }
        .sorted { ($0.activationPolicy == .regular ? 0 : 1) < ($1.activationPolicy == .regular ? 0 : 1) }
    return apps.first { $0.localizedName?.lowercased() == n }
        ?? apps.first { $0.bundleIdentifier?.lowercased() == n }
        ?? apps.first { ($0.localizedName?.lowercased() ?? "").hasPrefix(n) }
}

func attr(_ el: AXUIElement, _ a: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(el, a as CFString, &v) == .success ? v : nil
}

func area(_ w: AXUIElement) -> Double { frame(pos: attr(w, kAXPositionAttribute), size: attr(w, kAXSizeAttribute)).map { $0[2] * $0[3] } ?? 0 }

func windows(_ app: AXUIElement) -> [AXUIElement] { (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? [] }

func frontWindow(_ app: AXUIElement) -> AXUIElement? {
    // A background app's panel is not "focused"; take its biggest window (the island, not a tooltip).
    if let pid = { var p: pid_t = 0; AXUIElementGetPid(app, &p); return Optional(p) }(),
       let ra = NSRunningApplication(processIdentifier: pid), ra.activationPolicy != .regular {
        return windows(app).max { area($0) < area($1) }
    }
    if let w = attr(app, kAXFocusedWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() { return (w as! AXUIElement) }
    if let w = attr(app, kAXMainWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() { return (w as! AXUIElement) }
    return windows(app).first
}

/// Bring the app forward; an app running with no window is reopened (macOS gives it one).
@discardableResult
func activate(_ name: String) -> NSRunningApplication? {
    var app = runningApp(name)
    // A background app (no Dock icon, like OX Island) is never brought forward: its panels are already up.
    if let a = app, a.activationPolicy != .regular { return a }
    // Already in front: nothing to wait for (the common case between two steps).
    if let a = app, frontPid() == a.processIdentifier { return a }
    let hasWindow = app.map { !windows(AXUIElementCreateApplication($0.processIdentifier)).isEmpty } ?? false
    if app == nil || !hasWindow {
        let url = app?.bundleURL ?? NSWorkspace.shared.urlForApplication(withBundleIdentifier: name)
            ?? NSWorkspace.shared.urlForApplication(toOpen: URL(fileURLWithPath: "/")).flatMap { _ in nil }
            ?? ["/Applications", "/System/Applications", "/System/Applications/Utilities", NSHomeDirectory() + "/Applications"]
                .map { URL(fileURLWithPath: "\($0)/\(name).app") }.first { FileManager.default.fileExists(atPath: $0.path) }
        guard let url else { return app }
        // `open` sends the reopen event that gives a windowless app its window; it returns at once.
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        p.arguments = ["-a", url.path]
        try? p.run(); p.waitUntilExit()
        for _ in 0..<100 where app == nil { pump(0.02); app = runningApp(name) }
    }
    guard let app else { return nil }
    app.activate()
    // Wait (20 ms steps, 1.5 s at most) until it is in front with a window.
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    for _ in 0..<75 {
        if frontPid() == app.processIdentifier, frontWindow(ax) != nil { break }
        pump(0.02)
    }
    return app
}

func targetApp() -> NSRunningApplication? {
    if let name = opt("app"), !name.isEmpty { return activate(name) }
    return frontApp()
}

// MARK: reading controls

let keepRoles: Set<String> = ["AXButton", "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXCheckBox", "AXRadioButton",
    "AXPopUpButton", "AXMenuButton", "AXLink", "AXCell", "AXRow", "AXStaticText", "AXTab", "AXSlider", "AXIncrementor",
    "AXDisclosureTriangle", "AXImage", "AXMenuItem", "AXSwitch", "AXToggle"]
let wanted = [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute, kAXValueAttribute,
              kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute, kAXIdentifierAttribute, kAXEnabledAttribute] as [CFString]

func str(_ v: AnyObject?) -> String {
    guard let v else { return "" }
    if CFGetTypeID(v) == AXValueGetTypeID() { return "" }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return ""
}

func frame(pos: AnyObject?, size: AnyObject?) -> [Double]? {
    guard let pos, let size, CFGetTypeID(pos) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var p = CGPoint.zero, s = CGSize.zero
    AXValueGetValue(pos as! AXValue, .cgPoint, &p)
    AXValueGetValue(size as! AXValue, .cgSize, &s)
    return [Double(p.x), Double(p.y), Double(s.width), Double(s.height)]
}

func list(window: AXUIElement, max: Int) -> [[String: Any]] {
    var out: [[String: Any]] = []
    func walk(_ el: AXUIElement, _ path: [Int], _ depth: Int) {
        if out.count >= max || depth > 30 { return }
        var values: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(el, wanted as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success,
              let v = values as [AnyObject]? , v.count == wanted.count else { return }
        let role = str(v[0])
        if depth > 0, keepRoles.contains(role) {
            let name = str(v[1]), desc = str(v[2]), help = str(v[3]), ident = str(v[8])
            let value = ["AXStaticText", "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXCheckBox", "AXSwitch"].contains(role) ? String(str(v[4]).prefix(200)) : ""
            let f = frame(pos: v[5], size: v[6])
            if (!name.isEmpty || !desc.isEmpty || !value.isEmpty || !ident.isEmpty || role.contains("Text") || role.contains("Search")), f.map({ $0[2] > 0 && $0[3] > 0 }) ?? true {
                var e: [String: Any] = ["role": role, "name": name, "description": desc, "help": help, "value": value, "identifier": ident, "path": path.map(String.init).joined(separator: ".")]
                if let f { e["frame"] = f }
                if let en = v[9] as? Bool, !en { e["disabled"] = true }
                out.append(e)
            }
        }
        if let kids = v[7] as? [AXUIElement] {
            for (i, k) in kids.enumerated() { if out.count >= max { return }; walk(k, path + [i], depth + 1) }
        }
    }
    walk(window, [], 0)
    return out
}

func element(window: AXUIElement, path: String) -> AXUIElement? {
    var el = window
    for part in path.split(separator: ".") {
        guard let i = Int(part), let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement], i < kids.count else { return nil }
        el = kids[i]
    }
    return el
}

// MARK: acting

func post(_ e: CGEvent?) { e?.post(tap: .cghidEventTap) }

func click(_ p: CGPoint, double: Bool) {
    post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
    usleep(15_000)
    for n in 1...(double ? 2 : 1) {
        let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)
        let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)
        down?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
        up?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
        post(down); usleep(8_000); post(up); usleep(30_000)
    }
}

func key(_ code: CGKeyCode, flags: CGEventFlags) {
    let src = CGEventSource(stateID: .hidSystemState)
    let d = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)
    let u = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
    d?.flags = flags; u?.flags = flags
    post(d); usleep(6_000); post(u)
}

func labels(_ el: AXUIElement) -> [String: Any] {
    ["role": str(attr(el, kAXRoleAttribute)), "name": str(attr(el, kAXTitleAttribute)), "description": str(attr(el, kAXDescriptionAttribute)),
     "help": str(attr(el, kAXHelpAttribute)), "identifier": str(attr(el, kAXIdentifierAttribute))]
}

// An app that hangs must not hang ox: each Accessibility question waits 0.6 s at most.
let axTimeoutSet: Void = { AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.6) }()

func handle(_ args: [String]) -> [String: Any] {
    _ = axTimeoutSet
    argv = args
    started = Date()
    pump()
    do {
        guard let cmd = argv.first else { try emit(["error": "usage: ox-hands serve | trusted | activate | list | at | press | click | type | key"]) }
        if cmd == "trusted" { try emit(["trusted": AXIsProcessTrusted()]) }
        if !AXIsProcessTrusted() { try emit(["error": accessHint, "access": false]) }
        switch cmd {
        case "activate":
            guard argv.count > 1, let a = activate(argv[1]) else { try emit(["error": "\(argv.dropFirst().first ?? "") is not an app on this Mac"]) }
            try emit(["app": a.localizedName ?? argv[1], "ms": ms()])

        case "list":
            guard let app = targetApp() else { try emit(["error": opt("app").map { "\($0) is not an app on this Mac" } ?? "no app in front"]) }
            let ax = AXUIElementCreateApplication(app.processIdentifier)
            guard let w = frontWindow(ax) else { try emit(["app": app.localizedName ?? "", "error": "it has no window open"]) }
            let els = list(window: w, max: Int(opt("max") ?? "") ?? 300)
            try emit(["app": app.localizedName ?? "", "window": str(attr(w, kAXTitleAttribute)), "elements": els, "ms": ms()])

        case "at":
            // The control under a point, and the ones around it, so a click there can be checked first.
            guard argv.count > 2, let x = Double(argv[1]), let y = Double(argv[2]) else { try emit(["error": "at <x> <y>"]) }
            var hit: AXUIElement?
            guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(x), Float(y), &hit) == .success, var el = hit else { try emit(["chain": [], "ms": ms()]) }
            var chain: [[String: Any]] = []
            for _ in 0..<4 {
                chain.append(labels(el))
                guard let p = attr(el, kAXParentAttribute), CFGetTypeID(p) == AXUIElementGetTypeID() else { break }
                el = p as! AXUIElement
                if str(attr(el, kAXRoleAttribute)) == "AXWindow" { break }
            }
            try emit(["chain": chain, "ms": ms()])

        case "press":
            guard let app = targetApp(), let w = frontWindow(AXUIElementCreateApplication(app.processIdentifier)) else { try emit(["error": "no window to press in"]) }
            guard let p = opt("path"), let el = element(window: w, path: p) else { try emit(["error": "that control is gone (the window changed): list it again"]) }
            // A path read earlier is pressed only if it is still the same control (same label).
            if let want = opt("expect"), !want.isEmpty {
                let l = labels(el)
                let have = ["name", "description", "identifier"].compactMap { l[$0] as? String }.filter { !$0.isEmpty }
                if !have.contains(want) { try emit(["error": "changed", "changed": true]) }
            }
            // A path read earlier is pressed only if it is still the same control (same label).
            if let want = opt("expect"), !want.isEmpty {
                let l = labels(el)
                let have = ["name", "description", "identifier"].compactMap { l[$0] as? String }.filter { !$0.isEmpty }
                if !have.contains(want) { try emit(["error": "changed", "changed": true]) }
            }
            let f = frame(pos: attr(el, kAXPositionAttribute), size: attr(el, kAXSizeAttribute))
            // The pointer goes to it, so you see what ox presses; then the control's own press, else a real click.
            if let f { post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: f[0] + f[2] / 2, y: f[1] + f[3] / 2), mouseButton: .left)) }
            // On screen: a real click at its centre (SwiftUI buttons in a panel that never takes focus,
            // like OX Island's, report an Accessibility press as done and ignore it). Off screen: the press.
            let onScreen = f.map { f in NSScreen.screens.contains { s in
                let top = (NSScreen.screens.first?.frame.maxY ?? 0) - s.frame.maxY
                return CGRect(x: s.frame.minX, y: top, width: s.frame.width, height: s.frame.height).contains(CGPoint(x: f[0] + f[2] / 2, y: f[1] + f[3] / 2))
            } } ?? false
            var acts: CFArray?
            let canPress = AXUIElementCopyActionNames(el, &acts) == .success && ((acts as? [String]) ?? []).contains(kAXPressAction as String)
            if onScreen || argv.contains("--double") || !canPress || AXUIElementPerformAction(el, kAXPressAction as CFString) != .success {
                guard let f else { try emit(["error": "it cannot be pressed and has no place on screen"]) }
                click(CGPoint(x: f[0] + f[2] / 2, y: f[1] + f[3] / 2), double: argv.contains("--double"))
                try emit(["done": "clicked", "ms": ms()])
            }
            try emit(["done": "pressed", "ms": ms()])

        case "click":
            guard argv.count > 2, let x = Double(argv[1]), let y = Double(argv[2]) else { try emit(["error": "click <x> <y>"]) }
            if opt("app") != nil { _ = targetApp() }
            click(CGPoint(x: x, y: y), double: argv.contains("--double"))
            try emit(["done": "clicked", "ms": ms()])

        case "type":
            guard argv.count > 1 else { try emit(["error": "type <text>"]) }
            let text = argv[1]
            if opt("app") != nil { guard targetApp() != nil else { try emit(["error": "\(opt("app")!) is not an app on this Mac"]) } }
            // Pasted (any language, emoji, several lines; a paste never presses Return), the clipboard put back after.
            let pb = NSPasteboard.general
            let saved: [[NSPasteboard.PasteboardType: Data]] = (pb.pasteboardItems ?? []).map { item in
                var d: [NSPasteboard.PasteboardType: Data] = [:]
                for t in item.types { if let v = item.data(forType: t) { d[t] = v } }
                return d
            }
            pb.clearContents()
            pb.setString(text, forType: .string)
            key(9, flags: .maskCommand)   // ⌘V
            usleep(180_000)               // the app reads the clipboard after the key; then it is put back
            pb.clearContents()
            if !saved.isEmpty {
                pb.writeObjects(saved.map { d in let it = NSPasteboardItem(); for (t, v) in d { it.setData(v, forType: t) }; return it })
            }
            try emit(["done": "typed", "chars": text.count, "ms": ms()])

        case "key":
            guard argv.count > 1, let code = UInt16(argv[1]) else { try emit(["error": "key <code>"]) }
            if opt("app") != nil { _ = targetApp() }
            var flags: CGEventFlags = []
            for m in (opt("mods") ?? "").split(separator: ",") {
                switch m { case "cmd": flags.insert(.maskCommand); case "shift": flags.insert(.maskShift); case "option": flags.insert(.maskAlternate); case "ctrl": flags.insert(.maskControl); default: break }
            }
            let times = max(1, min(20, Int(opt("times") ?? "1") ?? 1))
            for _ in 0..<times { key(CGKeyCode(code), flags: flags); usleep(15_000) }
            try emit(["done": "pressed", "ms": ms()])

        default:
            try emit(["error": "unknown command \(cmd)"])
        }
    } catch let r as Reply { return r.o } catch { return ["error": String(describing: error)] }
}

func write(_ o: [String: Any]) {
    let d = (try? JSONSerialization.data(withJSONObject: o)) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(d + Data("\n".utf8))
}

let cli = Array(CommandLine.arguments.dropFirst())
if cli.first == "serve" {
    // One request per line: a JSON array of the same arguments as the command line.
    setvbuf(stdout, nil, _IONBF, 0)
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8), let args = (try? JSONSerialization.jsonObject(with: data)) as? [String] else {
            write(["error": "send one JSON array of arguments per line"]); continue
        }
        write(handle(args))
    }
    exit(0)
}
let out = handle(cli)
write(out)
exit(out["error"] == nil ? 0 : 1)
