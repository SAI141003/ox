// "Silent words" (Subvox in ox): its own small app, ~/.ox/island/Silent Words.app,
// so it asks for Motion under its own name and never stops the island (one
// island at a time is enforced by process name). `ox island silent` opens it.
import AppKit
import SwiftUI
import Subvox

final class SilentWordsDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Built as a plain executable, it would start as a background process with no window in front.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
struct OxSubvoxApp: App {
    @NSApplicationDelegateAdaptor(SilentWordsDelegate.self) var delegate
    var body: some Scene {
        WindowGroup("Silent words") { SubvoxRootView() }
            .windowResizability(.contentMinSize)
    }
}
