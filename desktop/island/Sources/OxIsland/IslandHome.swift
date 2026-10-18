import SwiftUI

// The open island, laid out the way Coucou's notch is (its code is MIT; its
// name, Mochi, icon and sounds are not used): a 34 pt header of tabs and
// icons, then a 98 pt row of cards: the left card shows the focused session
// with the character drawn over its left edge and the steps it is taking;
// the right card holds the other sessions as pills, two by two. Approvals,
// questions, finishes and errors take the left card with their own wash.

enum HomeInk {
    static let card = Color(hex: "#141518")
    static let text = Color(hex: "#F5F6F8")
    static let muted = Color(hex: "#8E939C")
    static let dim = Color(hex: "#6B7079")
    static let faint = Color(hex: "#5F646D")
    static let pill = Color(hex: "#0E0F11")
    static let tabOn = Color(hex: "#1D1F23")
    static func glow(_ m: Mood) -> Color {
        switch m {
        case .working: return Color(hex: "#3B9EFF")
        case .thinking: return Color(hex: "#A78BFA")
        case .needsYou: return Color(hex: "#F5A524")
        case .error: return Color(hex: "#F4505E")
        case .done: return Color(hex: "#34D399")
        default: return .white
        }
    }
}

/// Card with a colour wash rising from below (amber asks, green finished, red failed…).
struct HomeCard<Content: View>: View {
    var wash: Color? = nil
    @ViewBuilder var content: () -> Content
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 20).fill(HomeInk.card)
                .overlay(
                    RadialGradient(gradient: Gradient(stops: [.init(color: wash ?? .clear, location: 0), .init(color: .clear, location: 0.7)]),
                                   center: UnitPoint(x: 0.5, y: 1.3), startRadius: 0, endRadius: 280)
                        .clipShape(RoundedRectangle(cornerRadius: 20))
                )
                .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.white.opacity(0.035), lineWidth: 1))
            content()
        }
    }
}

// MARK: - header

enum HomeTab: String { case home, chat, more }

struct HomeHeader: View {
    @ObservedObject var bridge: OxBridge
    let notchWidth: CGFloat

    var body: some View {
        HStack(spacing: 0) {
            HStack(spacing: 5) {
                tab("house.fill", on: bridge.tray == nil && bridge.card == nil) { bridge.tray = nil; bridge.card = nil }
                tab("bubble.left.fill", on: bridge.tray == .chat) { bridge.card = nil; bridge.tray = bridge.tray == .chat ? nil : .chat }
                tab("plus", on: [.shelf, .focus, .clips, .mail, .recap].contains(bridge.tray)) { bridge.card = nil; bridge.tray = [.shelf, .focus, .clips, .mail, .recap].contains(bridge.tray) ? nil : .shelf }
            }
            .padding(.leading, 14)
            Spacer(minLength: notchWidth + 8)
            HStack(spacing: 8) {
                VoiceStatusChip(bridge: bridge)
                if let g = bridge.gauges.max(by: { $0.percent < $1.percent }) { PlanPill(gauge: g) }
                HStack(spacing: 14) {
                    HeaderIcon(name: "mic.fill", active: bridge.buddyActive, help: "Talk to \(OxName.current) (hold ⌃⌥Space)") { MainActor.assumeIsolated { bridge.buddy.toggle() } }
                    HeaderIcon(name: bridge.pinnedOpen ? "pin.fill" : "pin", active: bridge.pinnedOpen, help: bridge.pinnedOpen ? "Unpin" : "Keep open") { bridge.pinnedOpen.toggle() }
                    if bridge.pendingSession == nil {
                        HeaderIcon(name: "xmark", active: false, help: "Close") { bridge.pinnedOpen = false; bridge.tray = nil; bridge.card = nil; bridge.hovering = false }
                    }
                }
            }
            .padding(.trailing, 16)
        }
        .frame(maxHeight: .infinity)
    }

    private func tab(_ icon: String, on: Bool, action: @escaping () -> Void) -> some View {
        TabCapsule(icon: icon, on: on, action: action)
    }
}

struct TabCapsule: View {
    let icon: String
    let on: Bool
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: { withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) { action() } }) {
            Image(systemName: icon).font(.system(size: 13))
                .foregroundStyle(on ? HomeInk.text : (hover ? Color(hex: "#B0B5BE") : HomeInk.muted))
                .frame(width: 30, height: 22)
                .background(on ? HomeInk.tabOn : hover ? Color.white.opacity(0.07) : .clear)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

struct HeaderIcon: View {
    let name: String
    let active: Bool
    let help: String
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            Image(systemName: name).font(.system(size: 13))
                .foregroundStyle(active || hover ? HomeInk.text : HomeInk.muted)
        }
        .buttonStyle(.plain).onHover { hover = $0 }.help(help)
    }
}

/// "Claude 22%": the most-used plan, coloured by how close it is to its limit.
struct PlanPill: View {
    let gauge: OxBridge.PlanGauge
    @State private var hover = false
    var body: some View {
        let c = gauge.percent >= 80 ? Color(hex: "#F4505E") : gauge.percent >= 50 ? Color(hex: "#F5A524") : Color(hex: "#34D399")
        HStack(spacing: 4) {
            Circle().fill(c).frame(width: 6, height: 6)
            Text("\(gauge.label) \(Int(gauge.percent.rounded()))%").font(.system(size: 10, weight: .semibold))
                .foregroundStyle(hover ? c : HomeInk.dim).lineLimit(1).fixedSize()
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(Capsule().fill(hover ? c.opacity(0.18) : HomeInk.pill))
        .overlay(Capsule().stroke(c.opacity(hover ? 0.55 : 0.14), lineWidth: 1))
        .onHover { h in withAnimation(.spring(response: 0.2, dampingFraction: 0.7)) { hover = h } }
        .help("\(gauge.label): \(Int(gauge.percent.rounded()))% of the \(gauge.window) limit\(gauge.resetsAt.map { ", resets " + $0.formatted(date: .omitted, time: .shortened) } ?? "")")
    }
}

// MARK: - the character, with its glow

struct HomeCharacter: View {
    @ObservedObject var bridge: OxBridge
    let mood: Mood
    let size: CGFloat
    var body: some View {
        ZStack {
            Circle()
                .fill(RadialGradient(gradient: Gradient(stops: [.init(color: HomeInk.glow(mood), location: 0), .init(color: .clear, location: 0.62)]),
                                     center: .center, startRadius: 0, endRadius: size * 1.1))
                .frame(width: size * 2.2, height: size * 2.2)
                .blur(radius: 6)
                .opacity([Mood.idle, .sleeping].contains(mood) ? 0.15 : 0.65)
                .animation(.easeInOut(duration: 0.4), value: mood)
            OxWalker(mood: mood, height: size, roam: false,
                     stressed: bridge.gauges.contains { $0.percent >= 80 }, onPoke: { bridge.showReaction() })
                .frame(width: size * 4 / 3 + 4, height: size)
        }
        .frame(width: size * 1.5, height: size * 1.2)
    }
}

// MARK: - home: the focused session and the others

struct OverviewHome: View {
    @ObservedObject var bridge: OxBridge
    let mood: Mood

    var body: some View {
        HStack(spacing: 10) {
            ZStack(alignment: .topLeading) {
                HomeCard(wash: wash) { EmptyView() }
                if bridge.focused == nil || HerdScene.demo {
                    // Nothing running: the herd is out on the pasture.
                    HerdScene(bridge: bridge).clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                } else {
                    HomeCharacter(bridge: bridge, mood: mood, size: 54)
                        .position(x: 52, y: 49)
                }
                focusBody
                    .padding(.leading, bridge.focused == nil || HerdScene.demo ? 12 : 104).padding(.trailing, 30).padding(.top, bridge.focused == nil || HerdScene.demo ? 8 : 10)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                if let f = bridge.focused, OxBridge.externalId(f.id) != nil || f.closedAt == nil {
                    Button { bridge.openCard(f) } label: {
                        Image(systemName: "arrow.up.right").font(.system(size: 8, weight: .medium)).foregroundStyle(HomeInk.faint)
                            .frame(width: 16, height: 16).background(Color.white.opacity(0.07)).clipShape(Circle())
                    }
                    .buttonStyle(.plain).help("Open this session: read it, message it, open it in Terminal")
                    .padding(.top, 8).padding(.trailing, 10)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
            .frame(width: 322)
            HomeCard { RightCard(bridge: bridge) }
        }
    }

    private var wash: Color? {
        switch bridge.focused?.mood {
        case .error: return Color(hex: "#F4505E").opacity(0.55)
        case .done: return Color(hex: "#34D399").opacity(0.35)
        default: return nil
        }
    }

    @ViewBuilder private var focusBody: some View {
        if let f = bridge.focused, !HerdScene.demo {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Circle().fill(Color(hex: f.color)).frame(width: 7, height: 7)
                    Text(f.project).font(.system(size: 12, weight: .semibold)).foregroundStyle(HomeInk.text).lineLimit(1).layoutPriority(1)
                    Text(f.tool).font(.system(size: 11)).foregroundStyle(HomeInk.muted).lineLimit(1)
                    Spacer(minLength: 2)
                }
                StepTicker(session: f)
            }
        } else {
            Text("All quiet").font(.system(size: 10.5, weight: .semibold)).foregroundStyle(HomeInk.muted)
                .help("Nothing running. Type or talk to \(OxName.current), or start an agent anywhere: it shows up here.")
        }
    }
}

/// The steps a session is taking, newest at the bottom, the latest bright.
struct StepTicker: View {
    let session: AgentSession
    var body: some View {
        let steps = session.steps.isEmpty ? [session.activity] : Array(session.steps.suffix(3))
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(steps.enumerated()), id: \.offset) { i, s in
                let last = i == steps.count - 1
                HStack(spacing: 5) {
                    Image(systemName: icon(for: s)).font(.system(size: 9)).foregroundStyle(last ? Color(hex: session.color) : HomeInk.faint).frame(width: 11)
                    Text(s).font(.system(size: 11, design: s.hasPrefix("$") ? .monospaced : .default))
                        .foregroundStyle(last ? HomeInk.text.opacity(0.92) : HomeInk.dim).lineLimit(1).truncationMode(.middle)
                }
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.8), value: session.steps)
    }
    private func icon(for s: String) -> String {
        if s.hasPrefix("$") { return "terminal" }
        if s.hasPrefix("editing") || s.hasPrefix("writing") { return "pencil" }
        if s.hasPrefix("reading") { return "doc.text" }
        if s.hasPrefix("searching") { return "magnifyingglass" }
        if s.hasPrefix("browsing") { return "globe" }
        if s.contains("idle") { return "moon.zzz" }
        if s.hasPrefix("done") { return "checkmark" }
        return "circle.fill"
    }
}

/// The right card: the other sessions as pills, two by two (Coucou's agent
/// pills); with none, the AI tools on this Mac, or what is playing.
struct RightCard: View {
    @ObservedObject var bridge: OxBridge
    var body: some View {
        let others = bridge.sessions.filter { $0.id != bridge.focused?.id }
        let cols = [GridItem(.flexible(), spacing: 4), GridItem(.flexible(), spacing: 4)]
        VStack(spacing: 4) {
            Spacer(minLength: 0)
            if !others.isEmpty {
                LazyVGrid(columns: cols, spacing: 4) {
                    ForEach(others.prefix(4)) { s in AgentPill(session: s) { withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) { bridge.focusId = s.id } } }
                }
                if others.count > 4 { Text("+\(others.count - 4) more").font(.system(size: 9.5)).foregroundStyle(HomeInk.dim) }
            } else if !bridge.org.isEmpty {
                // Your company (ox org): each agent with its own character.
                LazyVGrid(columns: cols, spacing: 4) {
                    ForEach(bridge.org.prefix(4)) { a in OrgPill(agent: a) { bridge.orgCard = bridge.orgCard == a.id ? nil : a.id } }
                }
            } else if let t = bridge.player.track {
                NowPlayingPill(player: bridge.player).help("\(t.title) · \(t.artist)")
            } else if !bridge.connected.isEmpty {
                LazyVGrid(columns: cols, spacing: 4) {
                    ForEach(bridge.connected.prefix(4)) { t in ToolPill(tool: t) }
                }
            } else {
                Text("No other sessions").font(.system(size: 10.5)).foregroundStyle(HomeInk.dim)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
    }
}

struct AgentPill: View {
    let session: AgentSession
    let onTap: () -> Void
    @State private var hover = false
    var body: some View {
        let c = Color(hex: session.color)
        Button(action: onTap) {
            ZStack(alignment: .topTrailing) {
                ZStack {
                    Capsule().fill(hover ? c.opacity(0.18) : HomeInk.pill)
                    Capsule().stroke(c.opacity(hover ? 0.55 : 0.14), lineWidth: 1)
                    HStack(spacing: 0) {
                        SessionCharacter(session: session, height: 20).padding(.leading, 8)
                        Spacer()
                    }
                    Text(session.project).font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(hover ? c : HomeInk.dim).lineLimit(1).truncationMode(.tail)
                        .padding(.leading, 38).padding(.trailing, 8)
                }
                .frame(height: 28)
                .shadow(color: c.opacity(hover ? 0.35 : 0), radius: 10, y: 2)
                if let badge { Circle().fill(badge).frame(width: 8, height: 8).overlay(Circle().stroke(Color.black, lineWidth: 1.5)).offset(x: 2, y: -2) }
            }
        }
        .buttonStyle(.plain)
        .scaleEffect(hover ? 1.04 : 1)
        .onHover { h in withAnimation(.spring(response: 0.2, dampingFraction: 0.7)) { hover = h } }
        .help("\(session.project) · \(session.tool) · \(session.activity)")
    }
    private var badge: Color? {
        switch session.mood {
        case .needsYou: return Color(hex: "#F5A524")
        case .error: return Color(hex: "#F4505E")
        case .done: return Color(hex: "#34D399")
        case .working: return Color(hex: "#3B9EFF")
        default: return nil
        }
    }
}

struct ToolPill: View {
    let tool: OxBridge.ConnectedTool
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(tool.ready ? HomeInk.text.opacity(0.8) : Color(hex: "#F5A524")).frame(width: 5, height: 5)
            Text(tool.name).font(.system(size: 10, weight: .semibold)).foregroundStyle(HomeInk.dim).lineLimit(1)
        }
        .frame(maxWidth: .infinity).frame(height: 28)
        .background(Capsule().fill(HomeInk.pill)).overlay(Capsule().stroke(Color.white.opacity(0.06), lineWidth: 1))
        .help(tool.ready ? "\(tool.name) · \(tool.via)" : "\(tool.name) needs you: \(tool.fix ?? "sign in")")
    }
}

// MARK: - an approval: amber, the command, Deny / Always / Allow

struct ApprovalHome: View {
    @ObservedObject var bridge: OxBridge
    let session: AgentSession
    let pending: PendingApproval
    @State private var shownAt = Date()

    var body: some View {
        HStack(spacing: 10) {
            ZStack(alignment: .topLeading) {
                HomeCard(wash: pending.question != nil ? Color(hex: "#22D3EE").opacity(0.38) : Color(hex: "#F5A524").opacity(0.42)) { EmptyView() }
                HomeCharacter(bridge: bridge, mood: .needsYou, size: 52).position(x: 50, y: 49)
                if let q = pending.question {
                    // Coucou's question card: the agent asks, you pick, it carries on.
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 6) {
                            Circle().fill(Color(hex: session.color)).frame(width: 7, height: 7)
                            Text(session.project).font(.system(size: 12, weight: .semibold)).foregroundStyle(HomeInk.text).lineLimit(1)
                            Text("\(session.tool) is asking you").font(.system(size: 11)).foregroundStyle(HomeInk.muted).lineLimit(1)
                        }
                        Text(q).font(.system(size: 12, weight: .medium)).foregroundStyle(HomeInk.text).lineLimit(2)
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                ForEach(pending.options, id: \.self) { o in
                                    HomeButton(title: o, style: .plain) { guard Date().timeIntervalSince(shownAt) > 0.6 else { return }; bridge.answerQuestion(session, o) }
                                }
                                Button("Answer in terminal") { bridge.deferToTerminal(session) }.buttonStyle(.plain).font(.system(size: 10.5)).foregroundStyle(HomeInk.dim)
                            }
                        }
                    }
                    .padding(.leading, 100).padding(.trailing, 12).padding(.top, 9)
                } else {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        Circle().fill(Color(hex: session.color)).frame(width: 7, height: 7)
                        Text(session.project).font(.system(size: 12, weight: .semibold)).foregroundStyle(HomeInk.text).lineLimit(1)
                        Text("\(session.tool) wants to run \(pending.tool)").font(.system(size: 11)).foregroundStyle(HomeInk.muted).lineLimit(1)
                    }
                    Text(pending.preview.isEmpty ? pending.tool : pending.preview)
                        .font(.system(size: 11, design: .monospaced)).foregroundStyle(HomeInk.text)
                        .lineLimit(2).truncationMode(.middle).help(pending.preview)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.07)))
                    HStack(spacing: 6) {
                        HomeButton(title: "Deny", style: .plain) { decide(.deny) }
                        HomeButton(title: "Always allow", style: .plain) { decide(.always) }
                        HomeButton(title: "Allow", style: .primary) { decide(.allow) }
                    }
                }
                .padding(.leading, 100).padding(.trailing, 12).padding(.top, 9)
                }
            }
            .frame(maxWidth: .infinity)
        }
        .onChange(of: pending.id) { shownAt = Date() }
    }

    private func decide(_ d: OxBridge.Decision) {
        guard Date().timeIntervalSince(shownAt) > 0.6 else { return } // a click aimed elsewhere
        bridge.answer(session, d)
    }
}

struct HomeButton: View {
    enum Style { case primary, plain }
    let title: String
    let style: Style
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            Text(title).font(.system(size: 11.5, weight: .semibold)).lineLimit(1).truncationMode(.middle)
                .padding(.horizontal, 12).padding(.vertical, 5)
                .foregroundStyle(style == .primary ? Color.black : HomeInk.text)
                .background(Capsule().fill(style == .primary ? HomeInk.text : Color.white.opacity(hover ? 0.14 : 0.08)))
                .scaleEffect(hover ? 1.03 : 1)
        }
        .buttonStyle(.plain)
        .onHover { h in withAnimation(.spring(response: 0.2, dampingFraction: 0.7)) { hover = h } }
    }
}


// MARK: - the company of agents (ox org, after Paperclip)

struct OrgPill: View {
    let agent: OxBridge.OrgAgent
    let onTap: () -> Void
    @State private var hover = false
    var body: some View {
        let c = Color(hex: agent.status == "paused" ? "#F5A524" : agent.status == "proposed" ? "#22D3EE" : "#7C5CFF")
        Button(action: onTap) {
            ZStack {
                Capsule().fill(hover ? c.opacity(0.18) : HomeInk.pill)
                Capsule().stroke(c.opacity(hover ? 0.55 : 0.14), lineWidth: 1)
                HStack(spacing: 0) {
                    PixelPersonView(person: OxBridge.character(for: "org:" + agent.id), pose: PixelPose(pose: agent.status == "active" ? "stand" : "think"), height: 20).padding(.leading, 8)
                    Spacer()
                }
                Text(agent.name).font(.system(size: 10, weight: .semibold)).foregroundStyle(hover ? c : HomeInk.dim).lineLimit(1).padding(.leading, 30).padding(.trailing, 8)
            }
            .frame(height: 28)
        }
        .buttonStyle(.plain)
        .onHover { h in withAnimation(.spring(response: 0.2, dampingFraction: 0.7)) { hover = h } }
        .help("\(agent.name) — \(agent.title) · \(agent.runtime) · \(agent.status)\(agent.budget.map { String(format: " · $%.2f of $%.0f this month", agent.spent, $0) } ?? "")")
    }
}

/// An agent proposed a hire: only you decide (Paperclip's governance).
struct HireHome: View {
    @ObservedObject var bridge: OxBridge
    let hire: OxBridge.OrgAgent
    var body: some View {
        ZStack(alignment: .topLeading) {
            HomeCard(wash: Color(hex: "#22D3EE").opacity(0.38)) { EmptyView() }
            HomeCharacter(bridge: bridge, mood: .needsYou, size: 52).position(x: 50, y: 49)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    PixelPersonView(person: OxBridge.character(for: "org:" + hire.id), pose: PixelPose(pose: "wave"), height: 18)
                    Text("\(hire.hiredBy) wants to hire \(hire.name)").font(.system(size: 12, weight: .semibold)).foregroundStyle(HomeInk.text).lineLimit(1)
                }
                Text("\(hire.title) · runs on \(hire.runtime)\(hire.budget.map { String(format: " · budget $%.0f a month", $0) } ?? "")")
                    .font(.system(size: 11)).foregroundStyle(HomeInk.muted).lineLimit(1)
                HStack(spacing: 6) {
                    HomeButton(title: "Reject", style: .plain) { bridge.org("reject", hire.id) }
                    HomeButton(title: "Approve hire", style: .primary) { bridge.org("approve", hire.id) }
                }
            }
            .padding(.leading, 100).padding(.trailing, 12).padding(.top, 12)
        }
    }
}

/// One of your machines needs a decision (ox mesh): what is wrong, and your options.
struct MeshAlertHome: View {
    @ObservedObject var bridge: OxBridge
    let alert: OxBridge.MeshAlert
    var body: some View {
        ZStack(alignment: .topLeading) {
            HomeCard(wash: Color(hex: alert.kind == "credits" ? "#F5A524" : "#F4505E").opacity(0.32)) { EmptyView() }
            HomeCharacter(bridge: bridge, mood: .needsYou, size: 52).position(x: 50, y: 49)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: alert.kind == "credits" ? "gauge.with.dots.needle.67percent" : "desktopcomputer.trianglebadge.exclamationmark")
                        .font(.system(size: 11, weight: .semibold)).foregroundStyle(Color(hex: "#F5A524"))
                    Text(alert.text).font(.system(size: 12, weight: .semibold)).foregroundStyle(HomeInk.text).lineLimit(2)
                }
                HStack(spacing: 6) {
                    ForEach(Array(alert.options.prefix(3).enumerated()), id: \.offset) { i, o in
                        HomeButton(title: o.label, style: i == 0 ? .primary : .plain) { bridge.meshChoose(alert, o) }
                            .help(o.model.map { "Next turns use \($0)" } ?? o.label)
                    }
                }
            }
            .padding(.leading, 100).padding(.trailing, 12).padding(.top, 12)
        }
    }
}

/// One of your agents: what it does next, its spend, Wake / Pause.
struct OrgAgentCard: View {
    @ObservedObject var bridge: OxBridge
    let agent: OxBridge.OrgAgent
    var body: some View {
        HomeCard {
            HStack(alignment: .top, spacing: 12) {
                PixelPersonView(person: OxBridge.character(for: "org:" + agent.id), pose: PixelPose(pose: agent.status == "active" ? "point" : "think"), height: 40)
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(agent.name) — \(agent.title)").font(.system(size: 12.5, weight: .semibold)).foregroundStyle(HomeInk.text)
                    Text("\(agent.runtime) · \(agent.status)\(agent.why.map { " (\($0))" } ?? "")\(agent.budget.map { String(format: " · $%.2f of $%.0f this month", agent.spent, $0) } ?? "")")
                        .font(.system(size: 11)).foregroundStyle(HomeInk.muted).lineLimit(1)
                    Text(agent.next.map { "Next: \($0)" } ?? "No task assigned. Give it one: ox task assign <id> \(agent.id)")
                        .font(.system(size: 11)).foregroundStyle(HomeInk.text.opacity(0.85)).lineLimit(2)
                    HStack(spacing: 6) {
                        if agent.status == "active" {
                            HomeButton(title: "Wake now", style: .primary) { bridge.org("beat", agent.id) }
                            HomeButton(title: "Pause", style: .plain) { bridge.org("pause", agent.id) }
                        } else if agent.status == "paused" {
                            HomeButton(title: "Resume", style: .primary) { bridge.org("resume", agent.id) }
                        }
                        HomeButton(title: "Close", style: .plain) { bridge.orgCard = nil }
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}
