import SwiftUI
import UniformTypeIdentifiers

extension Color {
    init(hex: String) {
        var v: UInt64 = 0
        Scanner(string: hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))).scanHexInt64(&v)
        self.init(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }
}

enum Ink {
    static let text = Color(hex: "#EDEDED")
    static let muted = Color(hex: "#A1A1A1")
    static let dim = Color(hex: "#6B6B6B")
    static let card = Color(hex: "#141414")
    // Black and white like the app: "needs you" is the brightest thing on screen,
    // "working" a calm grey, red only for errors.
    static let amber = Color(hex: "#FFFFFF")
    static let green = Color(hex: "#A1A1A1")
    static let red = Color(hex: "#F4505E")
    static let gold = Color(hex: "#FFFFFF")
}

// MARK: - Shape

/// The island outline, centred in whatever rect it is given. top < 0 draws
/// concave "ears" that flare the top corners into the menu bar, so the island
/// reads as the notch itself growing.
struct IslandShape: Shape {
    var width: CGFloat
    var height: CGFloat
    var corner: CGFloat
    var top: CGFloat

    var animatableData: AnimatablePair<AnimatablePair<CGFloat, CGFloat>, AnimatablePair<CGFloat, CGFloat>> {
        get { .init(.init(width, height), .init(corner, top)) }
        set { width = newValue.first.first; height = newValue.first.second; corner = newValue.second.first; top = newValue.second.second }
    }

    func path(in rect: CGRect) -> Path {
        let x0 = (rect.width - width) / 2
        let cr = min(corner, height / 2)
        var p = Path()
        if top < 0 {
            let er = -top
            p.move(to: CGPoint(x: x0, y: 0))
            p.addArc(center: CGPoint(x: x0, y: er), radius: er, startAngle: .degrees(270), endAngle: .degrees(0), clockwise: false)
            p.addLine(to: CGPoint(x: x0 + er, y: height - cr))
            p.addArc(center: CGPoint(x: x0 + er + cr, y: height - cr), radius: cr, startAngle: .degrees(180), endAngle: .degrees(90), clockwise: true)
            p.addLine(to: CGPoint(x: x0 + width - er - cr, y: height))
            p.addArc(center: CGPoint(x: x0 + width - er - cr, y: height - cr), radius: cr, startAngle: .degrees(90), endAngle: .degrees(0), clockwise: true)
            p.addLine(to: CGPoint(x: x0 + width - er, y: er))
            p.addArc(center: CGPoint(x: x0 + width, y: er), radius: er, startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
        } else {
            p.move(to: CGPoint(x: x0, y: 0))
            p.addLine(to: CGPoint(x: x0, y: height - cr))
            p.addArc(center: CGPoint(x: x0 + cr, y: height - cr), radius: cr, startAngle: .degrees(180), endAngle: .degrees(90), clockwise: true)
            p.addLine(to: CGPoint(x: x0 + width - cr, y: height))
            p.addArc(center: CGPoint(x: x0 + width - cr, y: height - cr), radius: cr, startAngle: .degrees(90), endAngle: .degrees(0), clockwise: true)
            p.addLine(to: CGPoint(x: x0 + width, y: 0))
        }
        p.closeSubpath()
        return p
    }
}

// MARK: - Root

struct IslandRoot: View {
    @ObservedObject var bridge: OxBridge
    @State private var metrics = NotchMetrics.current()

    // Opening springs with a little overshoot; closing is a quick, decisive ease.
    private let open = Animation.spring(response: 0.48, dampingFraction: 0.74)
    private let close = Animation.timingCurve(0.45, 0, 0.2, 1, duration: 0.32)

    var body: some View {
        let phase = IslandLayout.phase(bridge)
        let s = IslandLayout.shape(phase, metrics, office: bridge.hasExtraPanel, idle: bridge.idleIsland)
        // Top-centred, like the notch. Every child is laid out in the island's
        // own width; the shape both paints the black and clips the content.
        ZStack(alignment: .top) {
            Color.black
                .contentShape(Rectangle())
                .onTapGesture { bridge.pinnedOpen.toggle() }

            Group {
                switch phase {
                case .launch:
                    LaunchView(size: CGSize(width: s.w, height: s.h)) { bridge.launching = false }
                        .transition(.opacity)
                case .hidden:
                    Color.clear
                case .compact:
                    CompactBar(bridge: bridge, metrics: metrics)
                        .transition(.opacity)
                case .expanded:
                    ExpandedContent(bridge: bridge, metrics: metrics)
                        .transition(.opacity.combined(with: .scale(scale: 0.97, anchor: .top)))
                }
            }
            .frame(width: s.w, height: s.h, alignment: .top)
        }
        .frame(width: IslandLayout.panel.width, height: IslandLayout.panel.height, alignment: .top)
        .clipShape(IslandShape(width: s.w, height: s.h, corner: s.corner, top: s.top))
        .contextMenu { IslandMenu(buddy: bridge.buddy, bridge: bridge) }
        // Drop files on the notch: they land on the shelf.
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            var urls: [URL] = []
            let group = DispatchGroup()
            for p in providers {
                group.enter()
                _ = p.loadObject(ofClass: URL.self) { url, _ in
                    if let url { DispatchQueue.main.async { urls.append(url) } }
                    group.leave()
                }
            }
            group.notify(queue: .main) { bridge.receive(urls) }
            return true
        }
        .animation(phase == .expanded || phase == .launch ? open : close, value: phase)
        .animation(.easeInOut(duration: 0.2), value: bridge.pendingSession?.pending?.id)
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didChangeScreenParametersNotification)) { _ in
            metrics = NotchMetrics.current()
        }
    }
}

/// Where a point inside the island sits in panel coordinates (for the gaze).
private func panelPoint(islandWidth: CGFloat, x: CGFloat, y: CGFloat) -> CGPoint {
    CGPoint(x: (IslandLayout.panel.width - islandWidth) / 2 + x, y: y)
}

// MARK: - Compact: ox on the left wing, status on the right

struct CompactBar: View {
    @ObservedObject var bridge: OxBridge
    let metrics: NotchMetrics

    var body: some View {
        let w = IslandLayout.shape(.compact, metrics).w
        let oxSize = metrics.height + 2
        let lead = IslandLayout.ear + 8
        HStack(spacing: 0) {
            // The lane runs from the wing into the notch, whose camera housing
            // hides the far end: the bull patrols in and out, and sleeps in there.
            let wing = max(0, (w - metrics.width) / 2 - lead)
            OxWalker(mood: bridge.headlineMood, height: oxSize * 0.95, roam: true, onPoke: { bridge.showReaction() })
                .frame(width: wing + oxSize * 0.95 * 4 / 3 + 4)
            Spacer(minLength: 0)
            if let team = bridge.officeSession, team.agents.contains(where: { $0.endedAt == nil }) {
                // The notch crew: tiny helpers pace the right wing while a team works.
                let active = Array(team.agents.enumerated().filter { $0.element.endedAt == nil }.prefix(2))
                ZStack {
                    ForEach(active, id: \.element.id) { i, _ in
                        PixelWalker(person: PixelCast.helpers[i % PixelCast.helpers.count], height: metrics.height * 0.92,
                                    phaseOffset: Double(i) * 1.7)
                    }
                }
                .frame(width: 40)
            } else if bridge.focus.active, bridge.sessions.isEmpty || bridge.headlineMood == .idle {
                FocusWing(timer: bridge.focus)
                    .frame(width: 40)
            } else {
                StatusGlyph(bridge: bridge)
                    .frame(width: 26)
            }
        }
        .padding(.leading, lead)
        .padding(.trailing, IslandLayout.ear + 10)
        .frame(height: metrics.height)
    }
}

struct StatusGlyph: View {
    @ObservedObject var bridge: OxBridge

    var body: some View {
        switch bridge.headlineMood {
        case .needsYou:
            Circle().fill(Ink.amber).frame(width: 8, height: 8).shadow(color: Ink.amber, radius: 4)
        case .error:
            Circle().fill(Ink.red).frame(width: 8, height: 8).shadow(color: Ink.red, radius: 4)
        case .done:
            Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Ink.green)
        case .working, .thinking:
            // How many are at work now; idle sessions (yours to answer) are not counted.
            ActivityDots(count: bridge.sessions.filter { s in if case .working = s.mood { return true }; return s.mood == .thinking }.count)
        case .idle, .sleeping:
            Circle().fill(Ink.muted.opacity(0.6)).frame(width: 6, height: 6)
        }
    }
}

/// Three dots that breathe in sequence; a number replaces them past one run.
struct ActivityDots: View {
    let count: Int
    var body: some View {
        if count > 1 {
            Text("\(count)").font(.system(size: 12, weight: .semibold, design: .rounded)).foregroundStyle(Ink.text)
        } else {
            TimelineView(.animation(minimumInterval: 1 / 30)) { ctx in
                let t = ctx.date.timeIntervalSinceReferenceDate
                HStack(spacing: 3) {
                    ForEach(0..<3) { i in
                        Circle().fill(Ink.text)
                            .frame(width: 4, height: 4)
                            .opacity(0.3 + 0.7 * max(0, sin(t * 5 - Double(i) * 0.7)))
                    }
                }
            }
        }
    }
}

// MARK: - Expanded

struct ExpandedContent: View {
    @ObservedObject var bridge: OxBridge
    let metrics: NotchMetrics

    static let oxSize: CGFloat = 84

    var body: some View {
        let w = IslandLayout.expanded.width
        let headerH = metrics.height
        let cardH = IslandLayout.expanded.height - headerH - 12 - (bridge.buddyActive ? 0 : IslandLayout.floorHeight) - (bridge.idleIsland ? IslandLayout.idleCardTrim : 0)
        VStack(spacing: 0) {
            Header(bridge: bridge, metrics: metrics)
                .frame(height: headerH)
            Card(wash: wash) {
                HStack(alignment: .center, spacing: 16) {
                    if bridge.buddyActive {
                        // OX Buddy: your avatar listens, thinks and talks here.
                        BuddyLane(buddy: bridge.buddy, mood: oxMood)
                            .frame(width: 120, height: Self.oxSize + 18)
                        BuddyBody(buddy: bridge.buddy)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        body(for: focus)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .frame(height: cardH)
            .padding(.horizontal, IslandLayout.ear + 10)
            .overlay(alignment: .bottom) {
                if let p = bridge.pendingSession?.pending { Countdown(deadline: p.deadline).padding(.horizontal, 40) }
            }
            if !bridge.buddyActive && IslandLayout.floorHeight > 0 {
                // The island's floor: the ox walks its whole width under your
                // cursor, and trots over to "press" whatever you click.
                let floorPad = IslandLayout.ear + 10
                OxWalker(mood: oxMood, height: Self.oxSize, roam: true, barn: true,
                         follow: true, origin: (IslandLayout.panel.width - w) / 2 + floorPad)
                    .frame(height: Self.oxSize)
                    .padding(.horizontal, floorPad)
                    .padding(.top, 4)
            }
            if let c = bridge.card, let session = bridge.sessions.first(where: { $0.id == c.id }) {
                // A session you clicked: its conversation, a message box, Open in Terminal.
                SessionCardView(bridge: bridge, session: session, card: c)
                    .padding(.horizontal, IslandLayout.ear + 10)
                    .padding(.top, 8)
                    .frame(height: IslandLayout.officeHeight + 40, alignment: .top)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            } else if bridge.tray != nil {
                // A tool the person opened wins over the ambient office/canvas.
                TrayPanel(bridge: bridge)
                    .padding(.horizontal, IslandLayout.ear + 10)
                    .padding(.top, 8)
                    .frame(height: IslandLayout.officeHeight, alignment: .top)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            } else if let team = bridge.officeSession {
                PixelOffice(bridge: bridge, session: team)
                    .padding(.horizontal, IslandLayout.ear + 18)
                    .padding(.top, 10)
                    .frame(height: IslandLayout.officeHeight, alignment: .top)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            } else if let canvas = bridge.canvasSession?.canvas {
                // What the agent chose to show: its OX Canvas, drawn natively.
                CanvasView(root: canvas)
                    .padding(.horizontal, IslandLayout.ear + 10)
                    .padding(.top, 8)
                    .frame(height: IslandLayout.officeHeight, alignment: .top)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
            Spacer(minLength: 0)
        }
    }

    private func rank(_ s: AgentSession) -> Int {
        switch s.mood { case .needsYou: return 0; case .error: return 1; case .working: return 2; case .thinking: return 3; case .done: return 4; default: return 5 }
    }

    private var oxMood: Mood {
        if let s = focus { return s.mood }
        return bridge.sessions.isEmpty ? .sleeping : bridge.headlineMood
    }

    private var focus: AgentSession? {
        bridge.pendingSession
            ?? bridge.sessions.first(where: { if case .error = $0.mood { return true }; return false })
            ?? (bridge.sessions.count == 1 ? bridge.sessions.first : nil)
    }

    private var wash: Color? {
        if bridge.pendingSession != nil { return Ink.amber }
        switch focus?.mood {
        case .error: return Ink.red
        case .done: return Ink.green
        default: return bridge.sessions.isEmpty ? nil : Color.white.opacity(0.18)
        }
    }

    @ViewBuilder private func body(for s: AgentSession?) -> some View {
        if let s, let p = s.pending {
            ApprovalBody(bridge: bridge, session: s, pending: p)
        } else if let s, case .error(let msg) = s.mood {
            VStack(alignment: .leading, spacing: 5) {
                Who(color: bridge.color(of: s), name: s.project, label: "stopped with an error")
                Text(msg).font(.system(size: 12)).foregroundStyle(Ink.text.opacity(0.9)).lineLimit(2)
                Text(s.id.hasPrefix("app:") ? "Open it in the OX app to see what happened." : s.id.contains("ox-ipc-island-") ? "Ask again from the chat, or open the OX app." : "The run is still open in your terminal.")
                    .font(.system(size: 11)).foregroundStyle(Ink.muted)
            }
        } else if let s, s.mood == .done {
            VStack(alignment: .leading, spacing: 5) {
                Who(color: bridge.color(of: s), name: s.project, label: s.closedAt == nil ? "finished, your turn" : "session ended")
                Text(s.lastText.isEmpty ? "Done." : s.lastText.trimmingCharacters(in: .whitespacesAndNewlines))
                    .font(.system(size: 12)).foregroundStyle(Ink.text.opacity(0.85))
                    .lineLimit(2).truncationMode(.head)
                Usage(session: s)
            }
        } else if bridge.sessions.isEmpty {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text("Nothing running").font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Ink.text)
                    Text("· type or talk to ox, or start it in a terminal").font(.system(size: 12)).foregroundStyle(Ink.muted).lineLimit(1)
                }
                if let t = bridge.today { TodayMeter(today: t) }
                ConnectedRow(tools: bridge.connected)
                NowPlayingPill(player: bridge.player)
            }
        } else {
            VStack(alignment: .leading, spacing: 4) {
                // Working ones first; each row is a session you can click open.
                let ordered = bridge.sessions.sorted { rank($0) < rank($1) }
                ForEach(ordered.prefix(4)) { s in RunRow(bridge: bridge, session: s) }
                if bridge.sessions.count > 4 {
                    Text("and \(bridge.sessions.count - 4) more").font(.system(size: 11)).foregroundStyle(Ink.dim)
                }
            }
        }
    }
}

/// The strip beside the notch: wordmark and run dots on the left, model on the right.
struct Header: View {
    @ObservedObject var bridge: OxBridge
    let metrics: NotchMetrics

    var body: some View {
        HStack(spacing: 0) {
            HStack(spacing: 6) {
                Text(OxName.current).font(.system(size: 13, weight: .heavy, design: .rounded)).foregroundStyle(Ink.text)
                ForEach(bridge.sessions.prefix(5)) { s in
                    Circle().fill(Color(hex: bridge.color(of: s))).frame(width: 6, height: 6)
                }
            }
            Spacer(minLength: metrics.width + 16)
            Text(headerRight)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Ink.muted)
                .lineLimit(1)
            VoiceStatusChip(bridge: bridge).padding(.leading, 8)
            ForEach(bridge.gauges) { g in PlanGaugePill(gauge: g).padding(.leading, 8) }
            TrayButtons(bridge: bridge)
                .padding(.leading, 10)
            MicButton(buddy: bridge.buddy)
                .padding(.leading, 8)
        }
        .padding(.horizontal, IslandLayout.ear + 20)
    }

    private var headerRight: String {
        let models = Set(bridge.sessions.map(\.model).filter { !$0.isEmpty })
        if models.count == 1, let m = models.first { return m }
        if bridge.sessions.isEmpty { return "idle" }
        return "\(bridge.sessions.count) runs"
    }
}

/// Near-black card with a coloured wash rising from below: the colour says
/// what kind of moment this is (amber asks, green finished, red failed).
struct Card<Content: View>: View {
    let wash: Color?
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
            .padding(.horizontal, 18)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(Ink.card)
                    .overlay(
                        RadialGradient(colors: [(wash ?? .clear).opacity(0.42), .clear],
                                       center: UnitPoint(x: 0.5, y: 1.35), startRadius: 0, endRadius: 300)
                            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    )
                    .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Color.white.opacity(0.04), lineWidth: 1))
            )
    }
}

struct Who: View {
    let color: String
    let name: String
    let label: String
    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(Color(hex: color)).frame(width: 8, height: 8)
            Text(name).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Ink.text).lineLimit(1)
            Text(label).font(.system(size: 12)).foregroundStyle(Ink.muted).lineLimit(1)
        }
    }
}

/// What the microphone is doing: call notes (red, with the time), dictation
/// (what it heard), « OK ox » listening (an ear), or a message for you.
struct VoiceStatusChip: View {
    @ObservedObject var bridge: OxBridge
    var body: some View {
        let notes = MainActor.assumeIsolated { bridge.notes }
        let dict = MainActor.assumeIsolated { bridge.dictation }
        let wake = MainActor.assumeIsolated { bridge.wake }
        Group {
            if notes.recording, let s = notes.startedAt {
                TimelineView(.periodic(from: s, by: 1)) { ctx in
                    let secs = Int(ctx.date.timeIntervalSince(s))
                    HStack(spacing: 4) {
                        Circle().fill(Ink.red).frame(width: 6, height: 6)
                        Text(String(format: "notes %d:%02d", secs / 60, secs % 60)).font(.system(size: 10.5, weight: .medium)).foregroundStyle(Ink.text)
                    }
                }
                .help(notes.live.isEmpty ? "Recording call notes" : notes.live)
                .onTapGesture { notes.stop() }
            } else if dict.phase == .listening {
                Text(dict.heard.isEmpty ? "dictating…" : "“\(dict.heard.suffix(28))”").font(.system(size: 10.5)).foregroundStyle(Ink.text).lineLimit(1)
            } else if case .message(let m) = dict.phase {
                Text(m).font(.system(size: 10.5)).foregroundStyle(Ink.muted).lineLimit(1).help(m)
            } else if let m = notes.message {
                Text(m).font(.system(size: 10.5)).foregroundStyle(Ink.muted).lineLimit(1).help(m).onTapGesture { notes.message = nil }
            } else if wake.listening {
                Image(systemName: "ear").font(.system(size: 10)).foregroundStyle(Ink.dim).help("Listening for “OK ox” (on this Mac)")
            }
        }
    }
}

/// One plan's usage (Coucou's gauge): green under 50 %, amber to 80 %, red past it.
struct PlanGaugePill: View {
    let gauge: OxBridge.PlanGauge
    var body: some View {
        let tint = gauge.percent >= 80 ? Ink.red : gauge.percent >= 50 ? Ink.amber : Ink.green
        HStack(spacing: 4) {
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.12)).frame(width: 22, height: 4)
                Capsule().fill(tint).frame(width: max(2, 22 * min(1, gauge.percent / 100)), height: 4)
            }
            Text("\(Int(gauge.percent.rounded()))%").font(.system(size: 10, weight: .medium)).foregroundStyle(Ink.muted)
        }
        .help("\(gauge.label): \(Int(gauge.percent.rounded()))% of the \(gauge.window) limit used\(gauge.resetsAt.map { ", resets " + $0.formatted(date: .abbreviated, time: .shortened) } ?? "")")
        .accessibilityLabel("\(gauge.label) plan, \(Int(gauge.percent.rounded())) percent used")
    }
}

/// Today's AI use at a glance (the usage meter in Coucou's widget gallery):
/// tokens, runs, cost when the models are priced, and the model used most.
struct TodayMeter: View {
    let today: OxBridge.Today
    var body: some View {
        let tok = today.tokens >= 1_000_000 ? String(format: "%.2fM", Double(today.tokens) / 1e6)
            : today.tokens >= 1000 ? String(format: "%.1fk", Double(today.tokens) / 1000) : "\(today.tokens)"
        let cost = today.cost.map { $0 < 0.01 ? String(format: " · $%.4f", $0) : String(format: " · $%.2f", $0) } ?? ""
        HStack(spacing: 6) {
            Image(systemName: "gauge.with.dots.needle.33percent").font(.system(size: 10)).foregroundStyle(Ink.dim)
            Text("Today \(tok) tokens · \(today.runs) run\(today.runs == 1 ? "" : "s")\(cost)\(today.topModel.isEmpty ? "" : " · mostly \(today.topModel)")")
                .font(.system(size: 11)).foregroundStyle(Ink.dim).lineLimit(1).truncationMode(.tail)
        }
        .accessibilityLabel("Today: \(today.tokens) tokens over \(today.runs) runs")
    }
}

struct Usage: View {
    let session: AgentSession
    var body: some View {
        let total = session.tokensIn + session.tokensOut
        if total > 0 {
            let tok = total >= 1000 ? String(format: "%.1fk tokens", Double(total) / 1000) : "\(total) tokens"
            let cost = session.costUsd > 0 ? String(format: ", $%.3f", session.costUsd) : ""
            Text("\(tok)\(cost), \(session.toolCount) tool calls")
                .font(.system(size: 11)).foregroundStyle(Ink.dim)
        }
    }
}

struct RunRow: View {
    @ObservedObject var bridge: OxBridge
    let session: AgentSession

    var body: some View {
        HStack(spacing: 8) {
            SessionCharacter(session: session, height: 18)
            Text(session.project).font(.system(size: 12, weight: .semibold)).foregroundStyle(Ink.text).lineLimit(1)
                .frame(maxWidth: 140, alignment: .leading)
            Text(session.activity).font(.system(size: 12)).foregroundStyle(activityColor)
                .lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 6)
            let total = session.tokensIn + session.tokensOut
            if total > 0 {
                Text(total >= 1000 ? String(format: "%.1fk", Double(total) / 1000) : "\(total)")
                    .font(.system(size: 11).monospacedDigit()).foregroundStyle(Ink.dim)
            }
            Image(systemName: bridge.card?.id == session.id ? "chevron.up" : "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Ink.dim)
        }
        .contentShape(Rectangle())
        .onTapGesture { bridge.openCard(session) }
        .help("Open this session: read it, message it, open it in Terminal")
    }

    private var activityColor: Color {
        switch session.mood {
        case .error: return Ink.red
        case .needsYou: return Ink.amber
        case .done: return Ink.green
        default: return Ink.muted
        }
    }
}

// MARK: - Approval

struct ApprovalBody: View {
    @ObservedObject var bridge: OxBridge
    let session: AgentSession
    let pending: PendingApproval
    @State private var shownAt = Date()

    /// Misclick guard: a card that just slid under the pointer cannot be
    /// answered by the click that was aimed at whatever was there before.
    private func guarded(_ d: OxBridge.Decision) {
        guard Date().timeIntervalSince(shownAt) > 0.6 else { return }
        bridge.answer(session, d)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Who(color: bridge.color(of: session), name: session.project, label: "wants to run \(pending.tool)")
            Text(pending.preview.isEmpty ? pending.tool : pending.preview)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(Color(hex: "#E8E9EC"))
                // You read what you approve: up to three lines, the full text on hover.
                .lineLimit(3).truncationMode(.middle)
                .help(pending.preview)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.07)))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.white.opacity(0.06)))
            HStack(spacing: 8) {
                PillButton(title: "Deny", primary: false) { guarded(.deny) }
                PillButton(title: "Allow", primary: true) { guarded(.allow) }
                PillButton(title: "Always", primary: false) { guarded(.always) }
                Spacer(minLength: 4)
                Button("Answer in terminal") { bridge.deferToTerminal(session) }
                    .buttonStyle(.plain)
                    .font(.system(size: 11))
                    .foregroundStyle(Ink.dim)
            }
        }
        .onChange(of: pending.id) { shownAt = Date() }
    }
}

/// A hairline that drains toward the moment ox stops waiting and falls back
/// to the terminal prompt.
struct Countdown: View {
    let deadline: Date
    @State private var total: TimeInterval = 115

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.25)) { ctx in
            let left = max(0, deadline.timeIntervalSince(ctx.date))
            GeometryReader { g in
                Capsule().fill(Ink.amber.opacity(0.7))
                    .frame(width: g.size.width * CGFloat(left / max(total, 1)), height: 2)
                    .frame(maxWidth: .infinity, alignment: .center)
            }
            .frame(height: 2)
            .padding(.bottom, 1)
        }
        .onAppear { total = max(1, deadline.timeIntervalSinceNow) }
    }
}

struct PillButton: View {
    let title: String
    let primary: Bool
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12.5, weight: .medium))
                .padding(.horizontal, 14).padding(.vertical, 6)
                .background(Capsule().fill(primary ? Ink.text : Color.white.opacity(hover ? 0.15 : 0.09)))
                .foregroundStyle(primary ? Color.black : Ink.text)
                .scaleEffect(hover ? 1.03 : 1)
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.12), value: hover)
    }
}


/// A session's own character (the pixel cast), posed by what it is doing.
struct SessionCharacter: View {
    let session: AgentSession
    let height: CGFloat
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 6.0)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            let pose: PixelPose = {
                switch session.mood {
                case .working: return PixelPose(dir: .front, pose: Int(t * 2) % 2 == 0 ? "point" : "open", mouth: "small")
                case .thinking: return PixelPose(dir: .front, pose: "think", mouth: "closed", blink: Int(t * 3) % 9 == 0)
                case .needsYou: return PixelPose(dir: .front, pose: "wave", frame: Int(t * 4) % 2, mouth: "open")
                case .done: return PixelPose(dir: .front, pose: "open", mouth: "smile")
                case .error: return PixelPose(dir: .front, pose: "stand", mouth: "round")
                default: return PixelPose(dir: .front, pose: "stand", mouth: "rest", blink: Int(t * 2) % 7 == 0)
                }
            }()
            PixelPersonView(person: OxBridge.character(for: session.id), pose: pose, height: height)
        }
        .frame(width: height * 18 / 26, height: height)
    }
}

/// The session you clicked: what it said, a box to message it, Open in Terminal.
struct SessionCardView: View {
    @ObservedObject var bridge: OxBridge
    let session: AgentSession
    let card: OxBridge.SessionCard
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                SessionCharacter(session: session, height: 26)
                VStack(alignment: .leading, spacing: 1) {
                    Text(session.project).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Ink.text).lineLimit(1)
                    Text([session.activity, session.model].filter { !$0.isEmpty }.joined(separator: " · ")).font(.system(size: 10.5)).foregroundStyle(Ink.muted).lineLimit(1)
                }
                Spacer(minLength: 4)
                if OxBridge.externalId(session.id) != nil {
                    PillButton(title: "Open in Terminal", primary: false) { bridge.openCardInTerminal() }
                }
                Button { bridge.card = nil } label: { Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)) }
                    .buttonStyle(.plain).foregroundStyle(Ink.dim).help("Close")
            }
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(card.lines) { l in
                            Text(l.text).font(.system(size: 11.5)).foregroundStyle(l.mine ? Color.black : Ink.text.opacity(0.9))
                                .lineLimit(6).textSelection(.enabled)
                                .padding(.horizontal, 8).padding(.vertical, 4)
                                .background(RoundedRectangle(cornerRadius: 9).fill(l.mine ? Ink.text : Color.white.opacity(0.07)))
                                .frame(maxWidth: .infinity, alignment: l.mine ? .trailing : .leading)
                                .id(l.id)
                        }
                        if card.busy { ActivityDots(count: 1).padding(.leading, 6) }
                    }
                }
                .onChange(of: card.lines.count) { withAnimation { proxy.scrollTo(card.lines.last?.id, anchor: .bottom) } }
                .onAppear { proxy.scrollTo(card.lines.last?.id, anchor: .bottom) }
            }
            if !card.note.isEmpty { Text(card.note).font(.system(size: 10.5)).foregroundStyle(Ink.muted).lineLimit(2) }
            if card.canSend {
                HStack(spacing: 6) {
                    TextField("Message \(session.project)…", text: $draft)
                        .textFieldStyle(.plain).font(.system(size: 12)).foregroundStyle(Ink.text)
                        .padding(.horizontal, 9).padding(.vertical, 5)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.07)))
                        .focused($focused)
                        .onSubmit { bridge.sendToCard(draft); draft = "" }
                    PillButton(title: card.busy ? "…" : "Send", primary: true) { bridge.sendToCard(draft); draft = "" }
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Ink.card))
        .onAppear { focused = true }
    }
}
