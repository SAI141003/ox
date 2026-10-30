import AppKit
import SwiftUI

// The open island's home as glowing tiles: the agent at work, the music, the
// focus timer. Each tile rises from black into its own colour and lights up
// when something happens in it. Tap the agent tile and the whole island takes
// that agent's colour: the turn's clock, its step, the file it is changing.

/// Each agent's colours, from the dark top of a tile to its lit bottom.
struct TilePalette {
    let accent: Color
    let mid: Color
    let bottom: Color

    static let music = TilePalette(accent: Color(hex: "#E0475A"), mid: Color(hex: "#250E10"), bottom: Color(hex: "#752836"))
    static let focus = TilePalette(accent: Color(hex: "#A558E3"), mid: Color(hex: "#24142C"), bottom: Color(hex: "#653486"))

    static func agent(_ s: AgentSession?) -> TilePalette {
        let tool = s?.tool.lowercased() ?? ""
        if tool.contains("claude") { return .init(accent: Color(hex: "#D97757"), mid: Color(hex: "#291B15"), bottom: Color(hex: "#835241")) }
        if tool.contains("codex") { return .init(accent: Color(hex: "#3ED6AE"), mid: Color(hex: "#0F231E"), bottom: Color(hex: "#1F6B58")) }
        if tool.contains("gemini") { return .init(accent: Color(hex: "#6EA8FE"), mid: Color(hex: "#10203A"), bottom: Color(hex: "#2A4F8A")) }
        if tool.contains("cursor") { return .init(accent: Color(hex: "#C9CDD4"), mid: Color(hex: "#1B1C1F"), bottom: Color(hex: "#4A4D55")) }
        let c = Color(hex: s?.color ?? "#7C5CFF")
        return .init(accent: c, mid: c.opacity(0.16), bottom: c.opacity(0.52))
    }
}

/// "Wed 28 Oct" quiet, the time bright: the header's clock.
struct HeaderClock: View {
    static let day: DateFormatter = { let f = DateFormatter(); f.setLocalizedDateFormatFromTemplate("EEE d MMM"); return f }()
    static let time: DateFormatter = { let f = DateFormatter(); f.dateFormat = "HH:mm"; return f }()
    var body: some View {
        TimelineView(.periodic(from: .now, by: 15)) { ctx in
            HStack(spacing: 4) {
                Text(HeaderClock.day.string(from: ctx.date))
                    .foregroundStyle(HomeInk.muted)
                Text(HeaderClock.time.string(from: ctx.date))
                    .foregroundStyle(HomeInk.text).fontWeight(.semibold)
            }
            .font(.system(size: 10.5).monospacedDigit())
            .lineLimit(1)
            .fixedSize()
        }
        .accessibilityHidden(true)
    }
}

/// A tile: black at the top, its colour rising from the bottom, brighter when lit.
struct GlowTile<Content: View>: View {
    let palette: TilePalette
    var lit = false
    var action: (() -> Void)? = nil
    @ViewBuilder var content: () -> Content
    @State private var hover = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 16, style: .continuous)
        ZStack(alignment: .topLeading) {
            shape.fill(LinearGradient(stops: [
                .init(color: .black, location: 0),
                .init(color: palette.mid, location: 0.5),
                .init(color: palette.bottom.opacity(lit ? 1 : 0.62), location: 1),
            ], startPoint: .top, endPoint: .bottom))
            shape.stroke(Color.white.opacity(hover ? 0.12 : 0.06), lineWidth: 1)
            content().padding(.horizontal, 12).padding(.vertical, 9)
        }
        .shadow(color: lit ? palette.bottom.opacity(0.55) : .clear, radius: 9, y: 3)
        .scaleEffect(hover && action != nil ? 1.015 : 1)
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: hover)
        .animation(.easeInOut(duration: 0.5), value: lit)
        .contentShape(shape)
        .onHover { hover = $0 }
        .onTapGesture { action?() }
    }
}

/// The round button in a tile's corner (white, with the tile's colour inside).
struct TileButton: View {
    let icon: String
    let tint: Color
    let label: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: icon).font(.system(size: 11, weight: .bold)).foregroundStyle(tint)
                .frame(width: 26, height: 26).background(Circle().fill(Color.white))
        }
        .buttonStyle(.plain).help(label).accessibilityLabel(label)
    }
}

struct GlowTilesHome: View {
    /// The tiles are the home; `defaults write dev.ox.island island.home classic` brings back the session cards.
    static var on: Bool { UserDefaults.standard.string(forKey: "island.home") != "classic" }
    @ObservedObject var bridge: OxBridge
    @ObservedObject var player: NowPlaying
    @ObservedObject var focus: FocusTimer

    var body: some View {
        HStack(spacing: 8) {
            agentTile
            musicTile
            focusTile
        }
    }

    // MARK: agent

    private var agentTile: some View {
        let s = bridge.focused
        let p = TilePalette.agent(s)
        let busy = AgentSession.busy(s?.mood)
        return GlowTile(palette: p, lit: busy || s?.mood == .needsYou, action: {
            withAnimation(.spring(response: 0.42, dampingFraction: 0.8)) {
                if let s { bridge.card = nil; bridge.tray = nil; bridge.glowId = bridge.glowId == s.id ? nil : s.id }
                else { bridge.card = nil; bridge.tray = .chat }
            }
        }) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(s?.tool == "ox" || s == nil ? OxName.current : s!.tool)
                            .font(.system(size: 10.5, weight: .semibold)).foregroundStyle(HomeInk.text.opacity(0.85)).lineLimit(1)
                        others
                    }
                    Spacer(minLength: 4)
                    if let s, s.tool != "ox" { AgentSpark(mood: s.mood, tint: p.accent) }
                    if let s, OxBridge.externalId(s.id) != nil || s.closedAt == nil {
                        Button { bridge.glowId = nil; bridge.openCard(s) } label: {
                            Image(systemName: "bubble.left.fill").font(.system(size: 9)).foregroundStyle(HomeInk.text)
                                .frame(width: 22, height: 22).background(Circle().fill(Color.white.opacity(0.12)))
                        }
                        .buttonStyle(.plain).help("Chat with this session: read it, message it, open it in Terminal")
                        .accessibilityLabel("Chat with this session")
                    }
                }
                Spacer(minLength: 0)
                VStack(alignment: .leading, spacing: 0) {
                    TurnClock(session: s)
                    Text(s.map { Self.word($0) } ?? T("Type or talk to start"))
                        .font(.system(size: 10)).foregroundStyle(HomeInk.text.opacity(0.7)).lineLimit(1)
                }

            }
        }
        .help(s.map { "\($0.project) · \($0.activity)" } ?? "Nothing running")
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }

    /// The other sessions as dots; tap one to bring it to the tile.
    @ViewBuilder private var others: some View {
        let rest = bridge.sessions.filter { $0.id != bridge.focused?.id }.prefix(5)
        if !rest.isEmpty {
            HStack(spacing: 4) {
                ForEach(Array(rest)) { o in
                    Circle().fill(Color(hex: o.color)).frame(width: 6, height: 6)
                        .opacity(AgentSession.busy(o.mood) || o.mood == .needsYou ? 1 : 0.45)
                        .onTapGesture { withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) { bridge.focusId = o.id } }
                        .help("\(o.project) · \(o.activity)")
                }
            }
        }
    }

    static func word(_ s: AgentSession) -> String {
        switch s.mood {
        case .needsYou: return "Needs you"
        case .error: return "Stopped"
        case .done: return "Done"
        case .idle, .sleeping: return "Your turn"
        default: return ["Thinking", "Reading", "Making changes", "Testing", "Done"][min(4, max(0, s.stage))]
        }
    }

    // MARK: music

    private var musicTile: some View {
        let t = player.track
        return GlowTile(palette: .music, lit: t?.playing == true, action: nil) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(T("Music")).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(HomeInk.text.opacity(0.85))
                        MusicBars(playing: t?.playing == true).frame(width: 13, height: 7).opacity(t == nil ? 0.35 : 1)
                    }
                    Spacer(minLength: 4)
                    MiniArt(player: player, size: 34)
                        .shadow(color: Color(hex: "#C8323F").opacity(t?.playing == true ? 0.6 : 0), radius: 8)
                }
                Spacer(minLength: 0)
                HStack(alignment: .bottom, spacing: 6) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(t?.title ?? T("Nothing playing")).font(.system(size: 12, weight: .semibold)).foregroundStyle(HomeInk.text).lineLimit(1)
                        Text(t?.artist ?? "Spotify · Music").font(.system(size: 10)).foregroundStyle(HomeInk.text.opacity(0.6)).lineLimit(1)
                    }
                    Spacer(minLength: 2)
                    if t != nil {
                        TileButton(icon: t?.playing == true ? "pause.fill" : "play.fill", tint: .black, label: t?.playing == true ? "Pause" : "Play") { player.send("playpause") }
                    }
                }
            }
        }
    }

    // MARK: focus

    private var focusTile: some View {
        GlowTile(palette: .focus, lit: focus.running, action: nil) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top) {
                    Text(T("Focus")).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(HomeInk.text.opacity(0.85))
                    Spacer(minLength: 4)
                    TileButton(icon: focus.running ? "pause.fill" : "play.fill", tint: TilePalette.focus.accent,
                               label: focus.running ? "Pause focus" : "Start focus") {
                        if focus.running { focus.pause() } else { focus.start() }
                    }
                }
                Spacer(minLength: 0)
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    Text(FocusTimer.clock(focus.left(at: ctx.date)))
                        .font(.system(size: 24, weight: .semibold, design: .rounded).monospacedDigit())
                        .foregroundStyle(HomeInk.text)
                }
                Text(focus.running ? T("Focusing") : focus.active ? T("Paused") : T("Ready to start"))
                    .font(.system(size: 10)).foregroundStyle(HomeInk.text.opacity(0.7))
            }
        }
        .contextMenu {
            ForEach([15, 25, 45, 60], id: \.self) { m in Button("\(m) min") { focus.reset(); focus.minutes = m } }
            if focus.active { Button("Reset") { focus.reset() } }
        }
    }
}

/// The turn's running clock, "0:04", in big figures.
struct TurnClock: View {
    let session: AgentSession?
    var size: CGFloat = 24
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            Text(Self.text(session, now: ctx.date))
                .font(.system(size: size, weight: .semibold, design: .rounded).monospacedDigit())
                .foregroundStyle(HomeInk.text)
                .contentTransition(.numericText())
        }
    }
    static func text(_ s: AgentSession?, now: Date) -> String {
        guard let start = s?.turnStartedAt else { return "0:00" }
        let n = Int(max(0, (s?.turnEndedAt ?? now).timeIntervalSince(start)))
        return n >= 3600 ? String(format: "%d:%02d:%02d", n / 3600, n / 60 % 60, n % 60) : String(format: "%d:%02d", n / 60, n % 60)
    }
}

/// The agent's mark in its tile's corner: a turning spark while it works.
struct AgentSpark: View {
    let mood: Mood
    let tint: Color
    var body: some View {
        let busy = AgentSession.busy(mood)
        TimelineView(.animation(minimumInterval: 1 / 30, paused: !busy)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            ZStack {
                Circle().fill(Color.black.opacity(0.35))
                if busy {
                    Circle().trim(from: 0, to: 0.28).stroke(Color.white.opacity(0.9), style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
                        .rotationEffect(.radians(t * 4))
                }
                Image(systemName: mood == .needsYou ? "exclamationmark" : mood == .done ? "checkmark" : "asterisk")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(mood == .needsYou ? EyeInk.amber : .white)
                    .rotationEffect(.radians(busy ? t * 1.5 : 0))
            }
            .frame(width: 26, height: 26)
        }
    }
}

// MARK: - a session's turn, in its colour

struct GlowSessionPanel: View {
    @ObservedObject var bridge: OxBridge
    let session: AgentSession

    var body: some View {
        let p = TilePalette.agent(session)
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    RoundedRectangle(cornerRadius: 4).fill(p.accent).frame(width: 16, height: 16)
                        .overlay(Image(systemName: "asterisk").font(.system(size: 9, weight: .bold)).foregroundStyle(.white))
                    Text(session.project).font(.system(size: 11.5, weight: .medium)).foregroundStyle(HomeInk.text.opacity(0.9)).lineLimit(1)
                }
                TurnClock(session: session, size: 34)
                Text(subtitle).font(.system(size: 10.5)).foregroundStyle(HomeInk.text.opacity(0.7)).lineLimit(1)
            }
            .frame(width: 210, alignment: .leading)
            VStack(alignment: .leading, spacing: 8) {
                ChangeCard(session: session)
                StageBar(stage: session.stage, accent: p.accent)
            }
            VStack(spacing: 6) {
                HomeButton(title: "Chat", style: .primary) { bridge.glowId = nil; bridge.openCard(session) }
                HomeButton(title: "Open", style: .plain) { bridge.openSessionInApp(session) }
            }
            .frame(width: 70)
        }
        .padding(.horizontal, 16).padding(.top, 4)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { bridge.openSessionInApp(session) }
    }

    private var subtitle: String {
        let word = GlowTilesHome.word(session)
        return AgentSession.busy(session.mood) && session.stage > 0 ? "\(word) · step \(min(4, session.stage)) of 4" : word
    }
}

/// The file being changed and how much ("checkout.ts · being edited", +3 −1),
/// or the latest step when no file is open.
struct ChangeCard: View {
    let session: AgentSession
    var body: some View {
        let edit = session.steps.last { $0.wholeMatch(of: #/(.+) \+(\d+) −(\d+)/#) != nil || $0.hasPrefix("editing") || $0.hasPrefix("writing") }
        let m = edit?.wholeMatch(of: #/(?:editing |writing )?(.+) \+(\d+) −(\d+)/#)
        let file = m.map { String($0.1) } ?? edit.map { $0.replacingOccurrences(of: "editing ", with: "").replacingOccurrences(of: "writing ", with: "") }
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(ext(file)).font(.system(size: 8, weight: .heavy, design: .monospaced)).foregroundStyle(.black)
                    .padding(.horizontal, 3).padding(.vertical, 1).background(RoundedRectangle(cornerRadius: 3).fill(Color.white.opacity(0.85)))
                Text(file.map { ($0 as NSString).lastPathComponent } ?? (session.steps.last ?? session.activity))
                    .font(.system(size: 11, weight: .medium)).foregroundStyle(HomeInk.text).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 4)
                Text(file != nil && AgentSession.busy(session.mood) ? "being edited" : session.lastText.isEmpty ? "" : "latest")
                    .font(.system(size: 9.5)).foregroundStyle(HomeInk.text.opacity(0.55))
            }
            if let m {
                HStack(spacing: 6) {
                    diffRow("− \(m.3) removed", Color(hex: "#F4505E"))
                    diffRow("+ \(m.2) added", Color(hex: "#34D399"))
                }
            } else if let last = session.steps.last {
                Text(last).font(.system(size: 10, design: last.hasPrefix("$") ? .monospaced : .default)).foregroundStyle(HomeInk.text.opacity(0.7)).lineLimit(1)
            }
        }
        .padding(.horizontal, 9).padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.white.opacity(0.07)))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Color.white.opacity(0.08), lineWidth: 1))
    }

    private func ext(_ f: String?) -> String {
        let e = ((f ?? "") as NSString).pathExtension.uppercased()
        return e.isEmpty ? "•" : String(e.prefix(3))
    }

    private func diffRow(_ text: String, _ c: Color) -> some View {
        Text(text).font(.system(size: 9.5, weight: .medium, design: .monospaced)).foregroundStyle(c)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 4).fill(c.opacity(0.16)))
    }
}

/// Read · Edit · Test · Done, filled as the turn moves on.
struct StageBar: View {
    let stage: Int
    let accent: Color
    var body: some View {
        HStack(spacing: 6) {
            ForEach(Array(["Read", "Edit", "Test", "Done"].enumerated()), id: \.offset) { i, name in
                VStack(alignment: .leading, spacing: 4) {
                    GeometryReader { g in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.white.opacity(0.18))
                            Capsule().fill(Color.white.opacity(0.95))
                                .frame(width: g.size.width * (i + 1 < stage ? 1 : i + 1 == stage ? (stage == 4 ? 1 : 0.55) : 0))
                        }
                    }
                    .frame(height: 3)
                    Text(name).font(.system(size: 9.5, weight: i + 1 == stage ? .semibold : .regular))
                        .foregroundStyle(HomeInk.text.opacity(i + 1 <= stage ? 0.9 : 0.45))
                }
            }
        }
        .animation(.spring(response: 0.45, dampingFraction: 0.85), value: stage)
    }
}

// MARK: - the glow around the island

/// A light along the island's edge, with sparks drifting off its bottom:
/// gold while a run needs you, violet while it listens.
struct IslandEdgeGlow: View {
    let width: CGFloat
    let height: CGFloat
    let corner: CGFloat
    let top: CGFloat
    let colour: Color
    var sparks = true

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            Canvas { g, size in
                let edge = IslandShape(width: width, height: height, corner: corner, top: top).path(in: CGRect(origin: .zero, size: size))
                let pulse = 0.75 + 0.25 * sin(t * 2.6)
                g.drawLayer { l in
                    l.addFilter(.blur(radius: 10))
                    l.stroke(edge, with: .color(colour.opacity(0.85 * pulse)), lineWidth: 6)
                }
                g.drawLayer { l in
                    l.addFilter(.blur(radius: 2.5))
                    l.stroke(edge, with: .color(colour.opacity(0.9)), lineWidth: 2)
                }
                g.stroke(edge, with: .color(Color.white.opacity(0.55 * pulse)), lineWidth: 0.8)
                guard sparks else { return }
                let x0 = (size.width - width) / 2
                for i in 0..<34 {
                    let seed = Double(i) * 0.618_033_988
                    let life = (t * (0.35 + 0.25 * (seed.truncatingRemainder(dividingBy: 1))) + seed).truncatingRemainder(dividingBy: 1)
                    let fx = (seed * 7.3).truncatingRemainder(dividingBy: 1)
                    let x = x0 + 14 + CGFloat(fx) * (width - 28) + CGFloat(sin(t * 1.3 + seed * 9)) * 3
                    let y = height + 2 + CGFloat(life) * 26
                    let r = CGFloat(0.6 + 1.2 * (1 - life))
                    g.fill(Path(ellipseIn: CGRect(x: x - r, y: y - r, width: 2 * r, height: 2 * r)), with: .color(colour.opacity(0.9 * (1 - life))))
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
