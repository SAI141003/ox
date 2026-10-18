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
