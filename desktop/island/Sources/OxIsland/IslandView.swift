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
            // Keep the panel transparent outside the island. Coucou's reference
            // uses a single black island surface; the cards inside carry the
            // hierarchy and colour, so the desktop never becomes a black slab.
            IslandShape(width: s.w, height: s.h, corner: s.corner, top: s.top)
                .fill(Color.black)
                .overlay(
                    IslandShape(width: s.w, height: s.h, corner: s.corner, top: s.top)
                        .stroke(Color.white.opacity(0.10), lineWidth: 1)
                )
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
                    VStack(spacing: 0) {
                        CompactBar(bridge: bridge, metrics: metrics)
                        if let t = bridge.ticker { TickerLine(ticker: t).transition(.opacity.combined(with: .move(edge: .top))) }
                    }
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
    @AppStorage("pet.kind") private var petKind = "none"

    var body: some View {
        let w = IslandLayout.shape(.compact, metrics).w
        let lead = IslandLayout.ear + 8
        HStack(spacing: 0) {
            // Keep the compact Island quiet: status, approvals, and a chosen
            // pet are useful here; the permanent orange Ox head was not.
            Spacer().frame(width: max(0, (w - metrics.width) / 2 - lead))
            Spacer(minLength: 0)
            if let pet = IslandPetKind(rawValue: petKind), pet != .none {
                IslandPet(kind: pet, mood: bridge.headlineMood, height: metrics.height * 0.82)
                    .frame(width: 31, height: metrics.height)
            }
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
            } else if !bridge.sessions.isEmpty {
                // Coucou's compact mini grid: one small character per session, two by two.
                MiniGrid(sessions: Array(bridge.sessions.prefix(4)))
                    .frame(width: 40, height: 28)
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
            PulsingDots()
        }
    }
}

/// Three dots that pulse in turn. A repeating animation that the system's render
/// server plays, so the island does no work per frame (a TimelineView redrew
/// the view 30 times a second on the main thread).
struct PulsingDots: View {
    @State private var on = false
    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<3) { i in
                Circle().fill(Ink.text)
                    .frame(width: 4, height: 4)
                    .opacity(on ? 1 : 0.3)
                    .animation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true).delay(Double(i) * 0.2), value: on)
            }
        }
        .onAppear { on = true }
    }
}


// MARK: - Expanded

struct ExpandedContent: View {
    @ObservedObject var bridge: OxBridge
    let metrics: NotchMetrics

    static let oxSize: CGFloat = 84

    var body: some View {
        VStack(spacing: 0) {
            HomeHeader(bridge: bridge, notchWidth: metrics.width)
                .frame(height: 34)
                .padding(.top, 8)
            Group {
                if let s = bridge.pendingSession, let p = s.pending {
                    ApprovalHome(bridge: bridge, session: s, pending: p)
                        .overlay(alignment: .bottom) { Countdown(deadline: p.deadline).padding(.horizontal, 40) }
                } else if let alert = bridge.meshAlerts.first {
                    MeshAlertHome(bridge: bridge, alert: alert)
                } else if let u = bridge.updateCard {
                    UpdateHome(bridge: bridge, card: u)
                } else if let hire = bridge.proposedHire {
                    HireHome(bridge: bridge, hire: hire)
                } else if bridge.buddyActive {
                    // Talking to ox (Pixie's listening card): the face, and what it heard or says.
                    HomeCard(wash: Color(hex: "#6366F1").opacity(0.22)) {
                        HStack(spacing: 14) {
                            BuddyLane(buddy: bridge.buddy, mood: oxMood).frame(width: 110, height: 92)
                            VStack(alignment: .leading, spacing: 4) {
                                BuddyBody(buddy: bridge.buddy)
                                VoiceLevel(buddy: bridge.buddy)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.horizontal, 12)
                        .contentShape(Rectangle())
                        .onTapGesture { MainActor.assumeIsolated { bridge.buddy.stopIfListening() } }
                    }
                    .help(bridge.buddy.phase == .listening ? "Tap to stop listening" : "")
                } else {
                    OverviewHome(bridge: bridge, mood: shownMood)
                }
            }
            .frame(height: 98)
            .padding(.horizontal, 10)
            .transition(.opacity.combined(with: .scale(scale: 0.97)))
            .animation(.spring(response: 0.4, dampingFraction: 0.8), value: bridge.pendingSession?.pending?.id)
            extraPanel
                .padding(.horizontal, 10)
                .padding(.top, 8)
            Spacer(minLength: 0)
        }
        .padding(.bottom, 10)
    }

    @ViewBuilder private var extraPanel: some View {
        if let id = bridge.orgCard, let a = bridge.org.first(where: { $0.id == id }) {
            OrgAgentCard(bridge: bridge, agent: a)
                .frame(height: 110)
                .transition(.opacity.combined(with: .move(edge: .top)))
        } else if let c = bridge.card, let session = bridge.sessions.first(where: { $0.id == c.id }) {
            // A session you opened: its conversation, a message box, Open in Terminal.
            SessionCardView(bridge: bridge, session: session, card: c)
                .frame(height: IslandLayout.panelExtra)
                .transition(.opacity.combined(with: .move(edge: .top)))
        } else if bridge.tray != nil {
            VStack(spacing: 6) {
                if [.shelf, .focus, .clips, .mail, .whatsapp, .recap, .office, .controls].contains(bridge.tray) {
                    // The + tab: files dropped on the notch, the focus timer, what you copied.
                    HStack(spacing: 5) {
                        ForEach([TrayTab.shelf, .focus, .clips, .mail, .whatsapp, .recap, .office, .controls]) { t in
                            TabCapsule(icon: t.icon, on: bridge.tray == t, label: t.title) { bridge.tray = t }
                        }
                        Spacer()
                    }
                }
                TrayPanel(bridge: bridge)
            }
            .frame(height: bridge.tray == .office ? IslandLayout.officeTall : IslandLayout.panelExtra)
            .transition(.opacity.combined(with: .move(edge: .top)))
        } else if let team = bridge.officeSession {
            PixelOffice(bridge: bridge, session: team)
                .frame(height: IslandLayout.officeHeight, alignment: .top)
                .transition(.opacity.combined(with: .move(edge: .top)))
        } else if let canvas = bridge.canvasSession?.canvas {
            // What the agent chose to show: its OX Canvas, drawn natively.
            CanvasView(root: canvas)
                .frame(height: IslandLayout.officeHeight, alignment: .top)
                .transition(.opacity.combined(with: .move(edge: .top)))
        }
    }

    /// Past 80 % of a plan's limit the ox worries (Claudex's panicking mascot).
    private var shownMood: Mood {
        let stressed = (bridge.gauges.contains { $0.percent >= 80 } || MacLoad.stressed) && [Mood.idle, .sleeping, .done].contains(oxMood)
        return stressed ? .needsYou : oxMood
    }

    private var oxMood: Mood {
        if let f = bridge.focused { return f.mood }
        return bridge.sessions.isEmpty ? .sleeping : bridge.headlineMood
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
                HStack(spacing: 4) {
                    Image(systemName: "stop.circle.fill").font(.system(size: 10)).foregroundStyle(Color(hex: "#7DD3FC"))
                    Text(dict.heard.isEmpty ? "dictating…" : "“\(dict.heard.suffix(28))”").font(.system(size: 10.5)).foregroundStyle(Ink.text).lineLimit(1)
                }
                .contentShape(Rectangle())
                .help("Tap to finish (pasted)")
                .onTapGesture { MainActor.assumeIsolated { dict.stop() } }
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
        .simultaneousGesture(TapGesture(count: 2).onEnded { bridge.openCardInTerminal() })
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
                PillButton(title: T("Deny"), primary: false) { guarded(.deny) }
                PillButton(title: T("Allow"), primary: true) { guarded(.allow) }
                PillButton(title: T("Always"), primary: false) { guarded(.always) }
                Spacer(minLength: 4)
                Button(T("Answer in terminal")) { bridge.deferToTerminal(session) }
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


/// A session's own character: one of the ox's friends (Puff the lamb, Pebble the
/// goat kid, Dot the calf; art/ox_cute_render.py), the same one every time,
/// animated by its own agent's state. Falls back to the pixel cast when the
/// friends' frames are not bundled.
struct SessionCharacter: View {
    let session: AgentSession
    let height: CGFloat
    static let friends = ["puff", "pebble", "dot"]

    static func friend(for id: String) -> String {
        let sum = id.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFFFF }
        return friends[sum % friends.count]
    }

    static func cycle(_ m: Mood, t: Double) -> String {
        switch m {
        case .working: return "gallop"
        case .thinking: return "think"
        case .needsYou: return "alert"
        case .done: return "happy"
        case .error: return "dizzy"
        case .sleeping: return "doze"
        case .idle: return Int(t / 6) % 3 == 2 ? "graze" : "idle"
        }
    }

    /// Only a session that is doing something moves; one waiting or asleep holds still (no redraws).
    private var moving: Bool {
        switch session.mood { case .working, .thinking, .needsYou, .done, .error: return true; default: return false }
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: Energy.interval(12, active: true), paused: !moving)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            let name = Self.friend(for: session.id)
            let frames = Frames.load("friends/\(name)/\(Self.cycle(session.mood, t: t))")
            let fallback = frames.isEmpty ? Frames.load("friends/\(name)/idle") : frames
            if !fallback.isEmpty {
                Image(nsImage: fallback[Int(t * 12) % fallback.count]).resizable().interpolation(.high)
                    .aspectRatio(4 / 3, contentMode: .fit)
                    .frame(height: height)
            } else {
                PixelPersonView(person: OxBridge.character(for: session.id), pose: PixelPose(dir: .front, pose: session.mood == .idle ? "stand" : "point"), height: height)
            }
        }
        .frame(width: height * 4 / 3, height: height)
    }
}

/// The session you clicked: what it said, a box to message it, Open in Terminal.
struct SessionCardView: View {
    @ObservedObject var bridge: OxBridge
    let session: AgentSession
    let card: OxBridge.SessionCard
    @State private var draft = ""
    @State private var modelDraft = ""
    @State private var transferTarget = "ox"
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
                    PillButton(title: T("Go to Terminal"), primary: false) { bridge.openCardInTerminal() }
                }
                Button { bridge.card = nil } label: { Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)) }
                    .buttonStyle(.plain).foregroundStyle(Ink.dim).help(T("Close"))
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
                if OxBridge.externalId(session.id) != nil {
                    HStack(spacing: 6) {
                        Text("Model").font(.system(size: 10.5)).foregroundStyle(Ink.muted)
                        TextField(session.model.isEmpty ? "keep current" : session.model, text: $modelDraft)
                            .textFieldStyle(.plain).font(.system(size: 10.5)).foregroundStyle(Ink.text)
                            .padding(.horizontal, 7).padding(.vertical, 4)
                            .background(RoundedRectangle(cornerRadius: 7).fill(Color.white.opacity(0.07)))
                    }
                    HStack(spacing: 6) {
                        Text("Transfer").font(.system(size: 10.5)).foregroundStyle(Ink.muted)
                        Picker("Target", selection: $transferTarget) {
                            Text("Ox").tag("ox")
                            Text("Claude").tag("claude")
                            Text("Codex").tag("codex")
                            Text("Hermes").tag("hermes")
                            Text("Gemini").tag("gemini")
                            Text("Cursor").tag("cursor")
                            Text("Cline").tag("cline")
                            Text("Kimi").tag("kimi")
                            Text("Kilo").tag("kilo")
                            Text("Handoff file").tag("file")
                        }
                        .labelsHidden().pickerStyle(.menu).font(.system(size: 10.5))
                        PillButton(title: "Transfer", primary: false) { bridge.transferCard(to: transferTarget) }
                    }
                }
                HStack(spacing: 6) {
                    TextField("Message \(session.project)…", text: $draft)
                        .textFieldStyle(.plain).font(.system(size: 12)).foregroundStyle(Ink.text)
                        .padding(.horizontal, 9).padding(.vertical, 5)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.07)))
                        .focused($focused)
                        .onSubmit { bridge.sendToCard(draft, model: modelDraft); draft = "" }
                    PillButton(title: card.busy ? "…" : "Send", primary: true) { bridge.sendToCard(draft, model: modelDraft); draft = "" }
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Ink.card))
        .onAppear { focused = true }
    }
}


/// Up to four sessions as tiny characters in the collapsed notch; a working one bobs.
struct MiniGrid: View {
    let sessions: [AgentSession]
    var body: some View {
        let cols = [GridItem(.fixed(17), spacing: 3), GridItem(.fixed(17), spacing: 3)]
        LazyVGrid(columns: cols, spacing: 1) {
            ForEach(sessions) { s in
                SessionCharacter(session: s, height: 13)
                    .opacity({ if case .idle = s.mood { return 0.55 }; return 1 }())
                    .help("\(s.project) · \(s.activity)")
            }
        }
    }
}


/// The Mac itself under strain (Coucou's character reacting to load): running
/// hot, or the 1-minute load well above the cores. Read at most every 10 s.
enum MacLoad {
    private static var at = Date.distantPast
    private static var last = false
    static var stressed: Bool {
        if Date().timeIntervalSince(at) < 10 { return last }
        at = Date()
        var loads = [Double](repeating: 0, count: 3)
        let n = getloadavg(&loads, 3)
        let busy = n > 0 && loads[0] / Double(max(1, ProcessInfo.processInfo.activeProcessorCount)) > 1.5
        let hot = ProcessInfo.processInfo.thermalState == .serious || ProcessInfo.processInfo.thermalState == .critical
        last = busy || hot
        return last
    }
    static var reason: String? {
        guard stressed else { return nil }
        return ProcessInfo.processInfo.thermalState.rawValue >= 2 ? "your Mac is running hot" : "your Mac is very busy"
    }
}

/// Dots that move with your voice while ox listens (Glance / Murmure's "light that dances with your voice").
struct VoiceLevel: View {
    @ObservedObject var buddy: Buddy
    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30)) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            HStack(spacing: 3) {
                ForEach(0..<7, id: \.self) { i in
                    let wave = 0.5 + 0.5 * sin(t * 9 + Double(i) * 0.9)
                    Capsule().fill(Color(hex: "#7DD3FC"))
                        .frame(width: 3, height: 4 + 18 * CGFloat(buddy.phase == .listening ? buddy.level * (0.55 + 0.45 * wave) : 0.05))
                        .shadow(color: Color(hex: "#38BDF8").opacity(buddy.level), radius: 4)
                }
            }
            .frame(height: 24)
            .opacity(buddy.phase == .listening ? 1 : 0)
            .animation(.easeOut(duration: 0.2), value: buddy.phase == .listening)
        }
    }
}


/// One narrated step under the closed notch: a spinner while it runs, a green
/// check when it is done (Vovy's "Claude Code is building ✓").
struct TickerLine: View {
    let ticker: OxBridge.Ticker
    @State private var spin = false
    var body: some View {
        HStack(spacing: 7) {
            if ticker.done {
                Image(systemName: "checkmark.circle.fill").font(.system(size: 11, weight: .semibold)).foregroundStyle(Color(hex: "#34D399"))
            } else {
                Circle().trim(from: 0, to: 0.7).stroke(Color(hex: "#7DD3FC"), style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
                    .frame(width: 10, height: 10).rotationEffect(.degrees(spin ? 360 : 0))
                    .onAppear { withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) { spin = true } }
            }
            if ticker.lanes.count > 1 {
                // A race: one row per lane, the tool's name bold, its time and latest moment after.
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(ticker.lanes.enumerated()), id: \.offset) { _, lane in
                        let parts = lane.components(separatedBy: " · ")
                        HStack(spacing: 6) {
                            Text(parts[0]).font(.system(size: 11.5, weight: .semibold).monospacedDigit()).foregroundStyle(lane.contains("✓") ? Color(hex: "#34D399") : Ink.text)
                            if parts.count > 1 {
                                Text(parts.dropFirst().joined(separator: " · ")).font(.system(size: 10.5, weight: .medium))
                                    .foregroundStyle(Color(hex: "#7DD3FC")).padding(.horizontal, 6).padding(.vertical, 1)
                                    .background(Capsule().fill(Color(hex: "#7DD3FC").opacity(0.14)))
                            }
                        }
                        .lineLimit(1)
                    }
                }
            } else {
                Text(ticker.text).font(.system(size: 11.5, weight: .medium)).foregroundStyle(Ink.text).lineLimit(1).truncationMode(.tail)
            }
        }
        .frame(height: IslandLayout.tickerHeight * CGFloat(max(1, ticker.lanes.count)) - 4)
        .padding(.horizontal, 16)
        .id(ticker.text + (ticker.done ? "✓" : ""))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(ticker.done ? "\(ticker.text), done" : ticker.text)
    }
}
