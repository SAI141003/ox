import AppKit
import SwiftUI

// What is playing in Spotify or Apple Music, with play/pause and next (the
// Spotify pill in Coucou). Asked only when that app is already open, so the
// island never launches one; asking needs your OK once (macOS Automation).
final class NowPlaying: ObservableObject {
    struct Track: Equatable { let app: String; let title: String; let artist: String; let playing: Bool }
    @Published private(set) var track: Track?
    private var timer: Timer?

    static let apps: [(name: String, bundle: String)] = [("Spotify", "com.spotify.client"), ("Music", "com.apple.Music")]

    func start() {
        guard UserDefaults.standard.object(forKey: "island.nowPlaying") as? Bool ?? true else { return }
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func stop() { timer?.invalidate(); timer = nil; track = nil }

    private var runningApp: String? {
        let ids = Set(NSWorkspace.shared.runningApplications.compactMap(\.bundleIdentifier))
        return Self.apps.first { ids.contains($0.bundle) }?.name
    }

    func refresh() {
        guard let app = runningApp else { if track != nil { track = nil }; return }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let script = """
            tell application "\(app)"
              if player state is stopped then return ""
              set t to current track
              return (name of t) & linefeed & (artist of t) & linefeed & ((player state is playing) as text)
            end tell
            """
            var err: NSDictionary?
            let out = NSAppleScript(source: script)?.executeAndReturnError(&err).stringValue ?? ""
            let parts = out.components(separatedBy: "\n")
            let t: Track? = parts.count >= 3 && !parts[0].isEmpty ? Track(app: app, title: parts[0], artist: parts[1], playing: parts[2] == "true") : nil
            DispatchQueue.main.async { if self?.track != t { self?.track = t } }
        }
    }

    func send(_ command: String) {
        guard let app = track?.app ?? runningApp else { return }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var err: NSDictionary?
            _ = NSAppleScript(source: "tell application \"\(app)\" to \(command)")?.executeAndReturnError(&err)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self?.refresh() }
        }
    }
}

struct NowPlayingPill: View {
    @ObservedObject var player: NowPlaying
    var body: some View {
        if let t = player.track {
            HStack(spacing: 8) {
                Image(systemName: t.app == "Spotify" ? "music.note" : "music.quarternote.3").font(.system(size: 10)).foregroundStyle(Ink.dim)
                Text(t.title).font(.system(size: 11.5, weight: .medium)).foregroundStyle(Ink.text).lineLimit(1)
                Text(t.artist).font(.system(size: 11)).foregroundStyle(Ink.muted).lineLimit(1)
                Spacer(minLength: 4)
                Button { player.send("playpause") } label: { Image(systemName: t.playing ? "pause.fill" : "play.fill").font(.system(size: 10)) }
                    .buttonStyle(.plain).foregroundStyle(Ink.text).help(t.playing ? "Pause" : "Play").accessibilityLabel(t.playing ? "Pause" : "Play")
                Button { player.send("next track") } label: { Image(systemName: "forward.fill").font(.system(size: 10)) }
                    .buttonStyle(.plain).foregroundStyle(Ink.text).help("Next").accessibilityLabel("Next track")
            }
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(Capsule().fill(Color.white.opacity(0.06)))
        }
    }
}

/// Coucou's agent pills: the AI tools on this Mac, ready (white dot) or waiting
/// for a sign-in (amber dot, the fix in the tooltip).
struct ConnectedRow: View {
    let tools: [OxBridge.ConnectedTool]
    var body: some View {
        if !tools.isEmpty {
            HStack(spacing: 6) {
                ForEach(tools.prefix(6)) { t in
                    HStack(spacing: 4) {
                        Circle().fill(t.ready ? Ink.text.opacity(0.85) : Ink.amber).frame(width: 5, height: 5)
                        Text(t.name).font(.system(size: 10.5, weight: .medium)).foregroundStyle(t.ready ? Ink.text.opacity(0.85) : Ink.muted).lineLimit(1)
                    }
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(Capsule().fill(Color.white.opacity(0.05)))
                    .help(t.ready ? "\(t.name) · \(t.via)" : "\(t.name) needs you: \(t.fix ?? "sign in")")
                    .accessibilityLabel(t.ready ? "\(t.name), ready" : "\(t.name), needs sign-in")
                }
                if tools.count > 6 { Text("+\(tools.count - 6)").font(.system(size: 10.5)).foregroundStyle(Ink.dim) }
            }
        }
    }
}
