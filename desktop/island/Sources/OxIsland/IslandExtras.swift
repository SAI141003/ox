import SwiftUI
import AppKit
import Carbon.HIToolbox

/// The island's sounds, each replaceable (Coucou's "your own sounds"): drop a
/// file named after the event in ~/.ox/island/sounds (pop.aiff, done.mp3, …)
/// or run  ox island sound <event> <file>. Without one, the system sound plays.
enum IslandSound {
    static let defaults: [String: String] = ["pop": "Pop", "glass": "Glass", "capture": "Tink", "done": "Hero", "needs-you": "Ping", "error": "Basso"]
    static var dir: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ox/island/sounds", isDirectory: true) }

    static func play(_ event: String) {
        for ext in ["aiff", "wav", "mp3", "m4a", "caf"] {
            let f = dir.appendingPathComponent("\(event).\(ext)")
            if FileManager.default.fileExists(atPath: f.path), let s = NSSound(contentsOf: f, byReference: true) { s.play(); return }
        }
        NSSound(named: defaults[event] ?? "Pop")?.play()
    }
}

/// ⌃⌥S: capture part of the screen into the island's shelf, ready to ask
/// about or attach (Coucou's capture shortcut; ⌘⇧S stays Save As in your apps).
@MainActor
enum Capture {
    static func install(_ bridge: OxBridge) {
        BuddyHotKey.register(id: 4, keyCode: kVK_ANSI_S, modifiers: controlKey | optionKey,
                             press: { MainActor.assumeIsolated { take(bridge) } }, release: {})
    }

    static func take(_ bridge: OxBridge) {
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ox/island/captures", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
        let url = dir.appendingPathComponent("Capture \(f.string(from: Date())).png")
        DispatchQueue.global(qos: .userInitiated).async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            p.arguments = ["-i", "-x", url.path]
            try? p.run(); p.waitUntilExit()
            DispatchQueue.main.async {
                // Esc in the crosshair: no file, nothing happens.
                guard FileManager.default.fileExists(atPath: url.path) else { return }
                bridge.shelf.add([url])
                IslandSound.play("capture")
                IslandLog.write("captured \(url.lastPathComponent)")
                bridge.tray = .shelf
                bridge.pinnedOpen = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 6) { if bridge.tray == .shelf { bridge.pinnedOpen = false } }
            }
        }
    }
}


/// Drop the ox on a window to give it as context (Coucou): the window under
/// the drop point is captured into the shelf, named after its app.
@MainActor
enum WindowContext {
    /// The topmost window of another app under a screen point (AppKit coordinates).
    static func window(at p: NSPoint) -> (id: CGWindowID, app: String)? {
        guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        let h = NSScreen.screens.first?.frame.height ?? 0
        let q = CGPoint(x: p.x, y: h - p.y)   // CG windows count from the top
        let mine = ProcessInfo.processInfo.processIdentifier
        for w in info {
            guard (w[kCGWindowLayer as String] as? Int) == 0,
                  (w[kCGWindowOwnerPID as String] as? Int32) != mine,
                  let b = w[kCGWindowBounds as String] as? [String: CGFloat],
                  let id = w[kCGWindowNumber as String] as? CGWindowID else { continue }
            let r = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
            if r.contains(q) { return (id, w[kCGWindowOwnerName as String] as? String ?? "window") }
        }
        return nil
    }

    static func drop(at p: NSPoint, bridge: OxBridge) {
        guard let w = window(at: p) else { return }
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ox/island/captures", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("\(w.app.replacingOccurrences(of: "/", with: "-")) window \(Int(Date().timeIntervalSince1970)).png")
        DispatchQueue.global(qos: .userInitiated).async {
            let pr = Process()
            pr.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            pr.arguments = ["-x", "-o", "-l", String(w.id), url.path]
            try? pr.run(); pr.waitUntilExit()
            DispatchQueue.main.async {
                guard FileManager.default.fileExists(atPath: url.path) else { IslandLog.write("window capture failed (Screen Recording permission?)"); return }
                bridge.shelf.add([url])
                IslandSound.play("capture")
                IslandLog.write("context from \(w.app)")
                bridge.tray = .shelf
                bridge.pinnedOpen = true
            }
        }
    }
}
