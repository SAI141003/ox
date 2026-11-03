import Foundation

private let appleScriptLock = NSLock()

/// NSAppleScript is not thread-safe, and these run off the main thread so a slow
/// Music or Mail cannot freeze the island. One at a time: two compiling together
/// crashed the island inside AppleScript (NowPlaying.refresh, on its timer).
func runAppleScript(_ source: String, _ error: inout NSDictionary?) -> NSAppleEventDescriptor? {
    appleScriptLock.lock()
    defer { appleScriptLock.unlock() }
    return NSAppleScript(source: source)?.executeAndReturnError(&error)
}
