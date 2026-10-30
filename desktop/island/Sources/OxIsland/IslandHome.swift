import SwiftUI

// The open island, laid out the way Coucou's notch is (its code is MIT; its
// protected name, mascot, icon and sounds are not used): a 34 pt header of tabs and
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
                tab("house.fill", on: bridge.tray == nil && bridge.card == nil, label: "Home") { bridge.tray = nil; bridge.card = nil }
                tab("bubble.left.fill", on: bridge.tray == .chat, label: "Chat with \(OxName.current)") { bridge.card = nil; bridge.tray = bridge.tray == .chat ? nil : .chat }
                tab("plus", on: [.shelf, .focus, .clips, .mail, .recap, .office, .controls].contains(bridge.tray), label: "Shelf, focus, clips, mail, recap, office and Island controls") { bridge.card = nil; bridge.tray = [.shelf, .focus, .clips, .mail, .recap, .office, .controls].contains(bridge.tray) ? nil : .shelf }
            }
            .padding(.leading, 14)
            if GlowTilesHome.on { HeaderClock().padding(.leading, 8) }
            Spacer(minLength: notchWidth + 8)
            HStack(spacing: 8) {
                VoiceStatusChip(bridge: bridge)
                if let g = bridge.gauges.max(by: { $0.percent < $1.percent }) { PlanPill(gauge: g, all: bridge.gauges) }
                HStack(spacing: 14) {
                    HeaderIcon(name: bridge.buddy.isListeningOrStarting ? "stop.circle.fill" : "mic.fill", active: bridge.buddyActive, help: bridge.buddy.isListeningOrStarting ? "Stop listening" : "Talk to \(OxName.current) (hold ⌃⌥Space)") { MainActor.assumeIsolated { bridge.buddy.toggle() } }
                    HeaderIcon(name: bridge.pinnedOpen ? "pin.fill" : "pin", active: bridge.pinnedOpen, help: bridge.pinnedOpen ? "Unpin" : "Keep open") { bridge.pinnedOpen.toggle() }
                    if bridge.pendingSession == nil {
                        HeaderIcon(name: "xmark", active: false, help: "Close") {
                            if let alert = bridge.meshAlerts.first { bridge.dismissMesh(alert) }
                            bridge.pinnedOpen = false; bridge.tray = nil; bridge.card = nil; bridge.glowId = nil; bridge.hovering = false
                        }
                    }
                }
            }
            .padding(.trailing, 16)
        }
        .frame(maxHeight: .infinity)
    }

    private func tab(_ icon: String, on: Bool, label: String = "", action: @escaping () -> Void) -> some View {
        TabCapsule(icon: icon, on: on, label: label, action: action)
    }
}

struct TabCapsule: View {
    let icon: String
    let on: Bool
    /// What it does, for VoiceOver and for ox's own clicks (an icon name like "Comment Left" says nothing).
    var label: String = ""
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
        .accessibilityLabel(label.isEmpty ? icon : label)
        .help(label)
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
        .accessibilityLabel(help.components(separatedBy: " (").first ?? help)
    }
}

/// "Claude 22%": the most-used plan, coloured by how close it is to its limit.
/// A usage ring (Claudex): how much of a plan window is used, coloured by how close the limit is.
struct UsageRing: View {
    let percent: Double
    var size: CGFloat = 10
    var line: CGFloat = 2
    static func tint(_ p: Double) -> Color { p >= 80 ? Color(hex: "#F4505E") : p >= 50 ? Color(hex: "#F5A524") : Color(hex: "#34D399") }
    var body: some View {
        ZStack {
            Circle().stroke(Color.white.opacity(0.12), lineWidth: line)
            Circle().trim(from: 0, to: max(0.02, min(1, percent / 100))).stroke(Self.tint(percent), style: StrokeStyle(lineWidth: line, lineCap: .round)).rotationEffect(.degrees(-90))
        }
        .frame(width: size, height: size)
    }
}

struct PlanPill: View {
    let gauge: OxBridge.PlanGauge
    var all: [OxBridge.PlanGauge] = []
    @State private var hover = false
    @State private var showAll = false
    var body: some View {
        let c = UsageRing.tint(gauge.percent)
        HStack(spacing: 4) {
            UsageRing(percent: gauge.percent)
            Text("\(gauge.label) \(Int(gauge.percent.rounded()))%").font(.system(size: 10, weight: .semibold))
                .foregroundStyle(hover ? c : HomeInk.dim).lineLimit(1).fixedSize()
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(Capsule().fill(hover ? c.opacity(0.18) : HomeInk.pill))
        .overlay(Capsule().stroke(c.opacity(hover ? 0.55 : 0.14), lineWidth: 1))
        .onHover { h in withAnimation(.spring(response: 0.2, dampingFraction: 0.7)) { hover = h } }
        .onTapGesture { showAll.toggle() }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(gauge.label) plan, \(Int(gauge.percent.rounded())) percent used")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { showAll.toggle() }
        .help("\(gauge.label): \(Int(gauge.percent.rounded()))% of the \(gauge.window) limit\(gauge.resetsAt.map { ", resets " + $0.formatted(date: .omitted, time: .shortened) } ?? ""). Click for every plan.")
        .popover(isPresented: $showAll, arrowEdge: .bottom) {
            // Every plan window: a ring, the share used and the time to its reset.
            VStack(alignment: .leading, spacing: 8) {
                ForEach(all) { g in
                    HStack(spacing: 8) {
                        UsageRing(percent: g.percent, size: 22, line: 3.5)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("\(g.label) · \(g.window)").font(.system(size: 11.5, weight: .semibold))
                            Text("\(Int(g.percent.rounded()))% used\(g.resetsAt.map { " · resets in " + Self.left($0) } ?? "")").font(.system(size: 10.5)).foregroundStyle(.secondary)
                        }
                    }
                }
                if all.isEmpty { Text(T("No plan usage yet")).font(.system(size: 11)) }
            }
            .padding(12).frame(minWidth: 210)
        }
    }
    static func left(_ d: Date) -> String {
        let s = max(0, Int(d.timeIntervalSinceNow))
        return s >= 86400 ? "\(s / 86400)d \((s % 86400) / 3600)h" : s >= 3600 ? "\(s / 3600)h \((s % 3600) / 60)m" : "\(s / 60)m"
    }
}

// MARK: - the character, with its glow

struct HomeCharacter: View {
    @ObservedObject var bridge: OxBridge
    let mood: Mood
    let size: CGFloat
    @State private var drag: CGSize = .zero
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
                     stressed: bridge.gauges.contains { $0.percent >= 80 }, onPoke: { bridge.showReaction() }, facesPointer: true)
                .frame(width: size * 4 / 3 + 4, height: size)
                .offset(drag)
                // Drag the ox onto any window: that window becomes context in the shelf.
                .gesture(DragGesture(minimumDistance: 12)
                    .onChanged { v in drag = v.translation }
                    .onEnded { _ in
                        let p = NSEvent.mouseLocation
                        withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) { drag = .zero }
                        WindowContext.drop(at: p, bridge: bridge)
                    })
                .help(T("Drag me onto a window to show it to me"))
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
                    .accessibilityLabel("Open this session")
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
            Text(T("All quiet")).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(HomeInk.muted)
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
                    if let m = s.wholeMatch(of: #/(.+) \+(\d+) −(\d+)/#) {
                        HStack(spacing: 4) {
                            Text(String(m.1)).font(.system(size: 11)).foregroundStyle(last ? HomeInk.text.opacity(0.92) : HomeInk.dim).lineLimit(1).truncationMode(.middle)
                            Text("+\(m.2)").font(.system(size: 10.5, weight: .semibold, design: .monospaced)).foregroundStyle(Color(hex: "#34D399"))
                            Text("−\(m.3)").font(.system(size: 10.5, weight: .semibold, design: .monospaced)).foregroundStyle(Color(hex: "#F4505E"))
                        }
                    } else {
                        Text(s).font(.system(size: 11, design: s.hasPrefix("$") ? .monospaced : .default))
                            .foregroundStyle(last ? HomeInk.text.opacity(0.92) : HomeInk.dim).lineLimit(1).truncationMode(.middle)
                    }
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
    /// Which four sessions show when there are more than four ("+2 more" pages on).
    @State private var page = 0
    var body: some View {
        let all = bridge.sessions.filter { $0.id != bridge.focused?.id }
        let start = all.count > 4 ? (page * 4) % all.count : 0
        let others = all.count > 4 ? Array(all[start...] + all[..<start]) : all
        let cols = [GridItem(.flexible(), spacing: 4), GridItem(.flexible(), spacing: 4)]
        VStack(spacing: 4) {
            Spacer(minLength: 0)
            if let run = bridge.browse {
                // The fast browser at work: a running clock, a tick per step, the final time.
                BrowseCard(run: run)
            } else if !others.isEmpty {
                LazyVGrid(columns: cols, spacing: 4) {
                    ForEach(others.prefix(4)) { s in
                        AgentPill(
                            session: s,
                            onTap: { withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) { bridge.focusId = s.id } },
                            onOpen: { bridge.openSessionInApp(s) }
                        )
                    }
                }
                if others.count > 4 {
                    Button { withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { page += 1 } } label: {
                        Text("+\(others.count - 4) more").font(.system(size: 9.5)).foregroundStyle(HomeInk.dim)
                            .padding(.horizontal, 6).padding(.vertical, 2).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).help("Show the other sessions").accessibilityLabel("Show \(others.count - 4) more sessions")
                }
            } else if !bridge.org.isEmpty {
                // Your company (ox org): each agent with its own character.
                LazyVGrid(columns: cols, spacing: 4) {
                    ForEach(bridge.org.prefix(4)) { a in OrgPill(agent: a, levelledUp: bridge.levelUps[a.id].map { Date().timeIntervalSince($0) < 60 } ?? false) { bridge.orgCard = bridge.orgCard == a.id ? nil : a.id } }
                }
            } else if bridge.player.track != nil || bridge.day.weather != nil || bridge.day.event != nil || bridge.day.prs != nil || bridge.day.vercel != nil || bridge.day.cal != nil || (bridge.day.n8n?.failed ?? 0) > 0 || !bridge.meshMachines.isEmpty {
                if let t = bridge.player.track { NowPlayingPill(player: bridge.player).help("\(t.title) · \(t.artist)") }
                if !bridge.meshMachines.isEmpty { MachineStrip(machines: bridge.meshMachines) }
                DayStrip(day: bridge.day)
            } else if !bridge.connected.isEmpty {
                LazyVGrid(columns: cols, spacing: 4) {
                    ForEach(bridge.connected.prefix(4)) { t in ToolPill(tool: t) }
                }
            } else {
                Text(T("No other sessions")).font(.system(size: 10.5)).foregroundStyle(HomeInk.dim)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
    }
}

/// The fast browser's run (ox browse, the agent's web_task), live. In the island's own design:
/// white figures on the dark card, the state colour (working blue, needs-you amber, done, error) only as an accent.
struct BrowseCard: View {
    let run: OxBridge.BrowseRun
    private var mood: Mood {
        switch run.status {
        case "running": return .working("browser")
        case "done": return .done
        case "blocked": return .needsYou
        default: return .error(run.reason ?? "")
        }
    }
    var body: some View {
        let accent = HomeInk.glow(mood)
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                TimelineView(.animation(minimumInterval: 0.05, paused: !run.running)) { ctx in
                    let secs = run.running ? ctx.date.timeIntervalSince(run.startedAt) : Double(run.elapsedMs) / 1000
                    Text(String(format: "%.2f", max(0, secs)))
                        .font(.system(size: 20, weight: .semibold, design: .rounded)).monospacedDigit()
                        .foregroundStyle(HomeInk.text)
                }
                Text("s").font(.system(size: 11, weight: .medium)).foregroundStyle(HomeInk.dim)
                Spacer(minLength: 4)
                VStack(alignment: .trailing, spacing: 2) {
                    HStack(spacing: 5) {
                        Circle().fill(accent).frame(width: 6, height: 6)
                            .shadow(color: accent.opacity(run.running ? 0.8 : 0), radius: 3)
                        Text(label).font(.system(size: 10, weight: .semibold)).foregroundStyle(accent)
                    }
                    Text(run.host.isEmpty ? (run.title.isEmpty ? T("Browser") : run.title) : run.host)
                        .font(.system(size: 9.5)).foregroundStyle(HomeInk.dim).lineLimit(1)
                }
            }
            // The latest steps that fit, earlier ones counted.
            let shown = Array(run.steps.suffix(3))
            HStack(spacing: 4) {
                if run.steps.count > shown.count {
                    Text("+\(run.steps.count - shown.count)").font(.system(size: 9.5, weight: .medium)).foregroundStyle(HomeInk.dim)
                }
                ForEach(Array(shown.enumerated()), id: \.offset) { _, s in
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark").font(.system(size: 8, weight: .bold)).foregroundStyle(HomeInk.muted)
                        Text(s).font(.system(size: 10, weight: .medium)).foregroundStyle(HomeInk.text).lineLimit(1)
                    }
                    .padding(.horizontal, 8).frame(height: 20)
                    .background(Capsule().fill(HomeInk.tabOn))
                    .transition(.scale(scale: 0.7).combined(with: .opacity))
                }
            }
            .animation(.spring(response: 0.3, dampingFraction: 0.8), value: run.steps.count)
            if let r = run.reason, run.status != "done", run.status != "running" {
                Text(r).font(.system(size: 9.5)).foregroundStyle(HomeInk.muted).lineLimit(1)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 12).fill(HomeInk.pill))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(accent.opacity(run.running ? 0.28 : 0.12), lineWidth: 1))
        .help(run.goal)
    }
    private var label: String {
        switch run.status {
        case "running": return T("Browsing")
        case "done": return T("Done")
        case "blocked": return T("Needs you")
        default: return T("Stopped")
        }
    }
}

/// Your day at a glance (the Dock-widget idea, Coucou's GitHub pills): weather, next event, pull requests.
struct DayStrip: View {
    let day: OxBridge.DayInfo
    var body: some View {
        HStack(spacing: 4) {
            if let w = day.weather {
                pill(icon: icon(w.text), text: "\(w.tempC)°  \(w.text)", tint: Color(hex: "#FBBF24")).help(w.place.map { "Weather in \($0)" } ?? "Weather")
            }
            if let e = day.event {
                pill(icon: "calendar", text: "\(e.title) · \(e.at.formatted(date: .omitted, time: .shortened))", tint: Color(hex: "#F87171")).help("Next in Calendar")
            }
            if let p = day.prs, p.open > 0 {
                Button { if let u = URL(string: "https://github.com/pulls") { NSWorkspace.shared.open(u) } } label: {
                    pill(icon: "arrow.triangle.pull", text: "\(p.open) PR\(p.open == 1 ? "" : "s")\(p.failing > 0 ? " · \(p.failing) failing" : "")", tint: p.failing > 0 ? Color(hex: "#F4505E") : Color(hex: "#34D399"))
                }.buttonStyle(.plain).help("Your open pull requests and their CI (opens GitHub)")
            }
            if let c = day.cal {
                Button { if let u = URL(string: "https://app.cal.com/bookings/upcoming") { NSWorkspace.shared.open(u) } } label: {
                    pill(icon: "calendar.badge.clock", text: "\(c.with.map { "\(c.title) · \($0)" } ?? c.title) · \(c.at.formatted(date: .omitted, time: .shortened))", tint: Color(hex: "#A78BFA"))
                }.buttonStyle(.plain).help("Your next Cal.com booking (opens Cal.com)")
            }
            if let n = day.n8n, n.failed > 0 {
                Button { if let u = URL(string: "\(n.url)/home/executions") { NSWorkspace.shared.open(u) } } label: {
                    pill(icon: "exclamationmark.arrow.triangle.2.circlepath", text: "n8n · \(n.failed) failed", tint: Color(hex: "#F4505E"))
                }.buttonStyle(.plain).help("Failed today: \(n.workflows.joined(separator: ", ")) (opens n8n)")
            }
            if let v = day.vercel {
                Button { if let u = URL(string: v.url ?? "https://vercel.com/dashboard") { NSWorkspace.shared.open(u) } } label: {
                    pill(icon: "triangle.fill", text: "\(v.name) \(v.state.lowercased())", tint: v.state == "ERROR" ? Color(hex: "#F4505E") : v.state == "READY" ? Color(hex: "#34D399") : Color(hex: "#FBBF24"))
                }.buttonStyle(.plain).help("Your newest Vercel deployment (opens it)")
            }
        }
    }
    private func icon(_ t: String) -> String {
        let l = t.lowercased()
        return l.contains("rain") || l.contains("drizzle") ? "cloud.rain.fill" : l.contains("snow") ? "cloud.snow.fill" : l.contains("thunder") ? "cloud.bolt.fill" : l.contains("cloud") || l.contains("overcast") ? "cloud.fill" : l.contains("fog") || l.contains("mist") ? "cloud.fog.fill" : "sun.max.fill"
    }
    private func pill(icon: String, text: String, tint: Color) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon).font(.system(size: 10, weight: .semibold)).foregroundStyle(tint)
            Text(text).font(.system(size: 10.5, weight: .medium)).foregroundStyle(HomeInk.text).lineLimit(1).truncationMode(.tail)
        }
        .padding(.horizontal, 9).frame(height: 26)
        .background(Capsule().fill(HomeInk.pill))
    }
}

/// Your other machines (ox mesh): up or not, and how busy.
struct MachineStrip: View {
    let machines: [OxBridge.MeshMachine]
    var body: some View {
        HStack(spacing: 4) {
            ForEach(machines.prefix(3)) { m in
                HStack(spacing: 5) {
                    Image(systemName: "laptopcomputer").font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(m.up ? Color(hex: "#34D399") : HomeInk.faint)
                    Text(m.name).font(.system(size: 10.5, weight: .medium)).foregroundStyle(HomeInk.text).lineLimit(1)
                    if let l = m.load { UsageRing(percent: min(100, l * 100), size: 9, line: 1.8) }
                }
                .padding(.horizontal, 9).frame(height: 26)
                .background(Capsule().fill(HomeInk.pill))
                .help(m.up ? "\(m.name): CPU \(Int((m.load ?? 0) * 100))%, memory \(Int((m.mem ?? 0) * 100))%" : "\(m.name) is not answering")
            }
        }
    }
}

struct AgentPill: View {
    let session: AgentSession
    let onTap: () -> Void
    /// A second click leaves the compact Island and returns to the app that
    /// owns this session. A single click remains a safe way to inspect/chat.
    let onOpen: () -> Void
    @State private var hover = false
    var body: some View {
        let c = Color(hex: session.color)
        Button(action: onTap) {
            ZStack(alignment: .topTrailing) {
                ZStack {
                    Capsule().fill(hover ? c.opacity(0.18) : HomeInk.pill)
                    Capsule().stroke(c.opacity(hover ? 0.55 : 0.14), lineWidth: 1)
                    HStack(spacing: 6) {
                        SessionCharacter(session: session, height: 24).frame(width: 32, height: 24).padding(.leading, 6)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(label).font(.system(size: 10.5, weight: .semibold))
                                .foregroundStyle(hover ? c : HomeInk.text).lineLimit(1).truncationMode(.tail)
                            Text(session.tokensIn + session.tokensOut > 0 ? "\(session.tool) · \(OxBridge.tokenText(session.tokensIn + session.tokensOut))" : session.tool)
                                .font(.system(size: 8.5).monospacedDigit()).foregroundStyle(HomeInk.faint).lineLimit(1)
                        }
                        Spacer(minLength: 4)
                    }
                }
                .frame(height: 28)
                .shadow(color: c.opacity(hover ? 0.35 : 0), radius: 10, y: 2)
                if let badge { Circle().fill(badge).frame(width: 8, height: 8).overlay(Circle().stroke(Color.black, lineWidth: 1.5)).offset(x: 2, y: -2) }
            }
        }
        .buttonStyle(.plain)
        .simultaneousGesture(TapGesture(count: 2).onEnded(onOpen))
        .scaleEffect(hover ? 1.04 : 1)
        .onHover { h in withAnimation(.spring(response: 0.2, dampingFraction: 0.7)) { hover = h } }
        .help("\(session.project) · \(session.tool) · \(session.activity)\(session.tokensIn + session.tokensOut > 0 ? " · last message \(session.tokensIn) tokens in, \(session.tokensOut) out" : "")")
    }
    /// The project, unless it is a temp folder's meaningless name ("T", "tmp").
    private var label: String {
        let p = session.project
        return ["t", "tmp", "private", "var", "folders", ""].contains(p.lowercased()) ? "scratch" : p
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
    @State private var typed = ""

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
                            Text("\(session.tool) \(T("is asking you"))").font(.system(size: 11)).foregroundStyle(HomeInk.muted).lineLimit(1)
                        }
                        Text(q).font(.system(size: 12, weight: .medium)).foregroundStyle(HomeInk.text).lineLimit(2)
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                ForEach(pending.options, id: \.self) { o in
                                    HomeButton(title: o, style: .plain) { guard Date().timeIntervalSince(shownAt) > 0.6 else { return }; bridge.answerQuestion(session, o) }
                                }
                                Button(T("Answer in terminal")) { bridge.deferToTerminal(session) }.buttonStyle(.plain).font(.system(size: 10.5)).foregroundStyle(HomeInk.dim)
                            }
                        }
                        // Or say it in your own words (Pushary's "type your answer").
                        HStack(spacing: 6) {
                            TextField(T("Type your answer"), text: $typed)
                                .textFieldStyle(.plain).font(.system(size: 11)).foregroundStyle(HomeInk.text)
                                .padding(.horizontal, 8).padding(.vertical, 3)
                                .background(RoundedRectangle(cornerRadius: 7).fill(Color.white.opacity(0.07)))
                                .onSubmit { let t = typed.trimmingCharacters(in: .whitespaces); if !t.isEmpty { bridge.answerQuestion(session, t) } }
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
                    if let why = pending.riskWhy {
                        // What it would do, in plain words: "This touches production".
                        HStack(spacing: 5) {
                            Image(systemName: pending.riskLevel == "danger" ? "exclamationmark.triangle.fill" : "info.circle")
                                .font(.system(size: 10, weight: .semibold))
                            Text(why).font(.system(size: 10.5, weight: .medium)).lineLimit(1)
                        }
                        .foregroundStyle(pending.riskLevel == "danger" ? Color(hex: "#F4505E") : Color(hex: "#F5A524"))
                    }
                    HStack(spacing: 6) {
                        HomeButton(title: T("Deny"), style: .plain) { decide(.deny) }
                        HomeButton(title: T("Always allow"), style: .plain) { decide(.always) }
                        HomeButton(title: T("Allow"), style: .primary) { decide(.allow) }
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
            Text(title).font(.system(size: 11.5, weight: .semibold)).lineLimit(1).minimumScaleFactor(0.8).truncationMode(.middle)
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
    var levelledUp = false
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
                Text(agent.name).font(.system(size: 10, weight: .semibold)).foregroundStyle(hover ? c : HomeInk.dim).lineLimit(1).padding(.leading, 30).padding(.trailing, 30)
                HStack {
                    Spacer()
                    Text(levelledUp ? "Lv↑\(agent.level)" : "Lv \(agent.level)")
                        .font(.system(size: 8.5, weight: .bold, design: .rounded))
                        .foregroundStyle(levelledUp ? Color.black : HomeInk.faint)
                        .padding(.horizontal, 4).padding(.vertical, 1)
                        .background(Capsule().fill(levelledUp ? Color(hex: "#FBBF24") : Color.white.opacity(0.06)))
                        .padding(.trailing, 7)
                }
            }
            .frame(height: 28)
        }
        .buttonStyle(.plain)
        .onHover { h in withAnimation(.spring(response: 0.2, dampingFraction: 0.7)) { hover = h } }
        .help("\(agent.name) — \(agent.title) · Lv \(agent.level) (\(agent.xp)/\(agent.nextXp) XP) · \(agent.runtime) · \(agent.status)\(agent.budget.map { String(format: " · $%.2f of $%.0f this month", agent.spent, $0) } ?? "")")
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
                    HomeButton(title: T("Reject"), style: .plain) { bridge.org("reject", hire.id) }
                    HomeButton(title: T("Approve hire"), style: .primary) { bridge.org("approve", hire.id) }
                }
            }
            .padding(.leading, 100).padding(.trailing, 12).padding(.top, 12)
        }
    }
}

/// One of your machines needs a decision (ox mesh): what is wrong, and your options.
/// ox updates itself (Coucou's self-update): ask once, a new version, the steps, the result.
struct UpdateHome: View {
    @ObservedObject var bridge: OxBridge
    let card: OxBridge.UpdateCard
    var body: some View {
        let wash: Color = {
            switch card.kind {
            case .failed: return Color(hex: "#F4505E")
            case .done: return Color(hex: "#2FA36B")
            case .ask, .available, .working: return Color(hex: "#4D8DFF")
            }
        }()
        ZStack(alignment: .topLeading) {
            HomeCard(wash: wash.opacity(0.28)) { EmptyView() }
            HomeCharacter(bridge: bridge, mood: card.kind == .working ? .thinking : card.kind == .done ? .done : .idle, size: 52).position(x: 50, y: 49)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    if card.kind == .working { ProgressView().controlSize(.small).scaleEffect(0.7) }
                    Text(card.title).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(HomeInk.text).lineLimit(1)
                }
                Text(card.detail).font(.system(size: 10.5)).foregroundStyle(HomeInk.muted).lineLimit(2)
                HStack(spacing: 6) {
                    switch card.kind {
                    case .ask:
                        HomeButton(title: "Auto-update", style: .primary) { bridge.updateChoose("auto") }
                        HomeButton(title: "Tell me", style: .plain) { bridge.updateChoose("allow") }
                        HomeButton(title: "No", style: .plain) { bridge.updateChoose("deny") }
                    case .available:
                        HomeButton(title: "Update now", style: .primary) { bridge.updateChoose("apply") }
                        HomeButton(title: "What's new", style: .plain) { bridge.updateChoose("whatsnew") }
                        HomeButton(title: "Later", style: .plain) { bridge.updateChoose("later") }
                    case .working:
                        EmptyView()
                    case .done, .failed:
                        HomeButton(title: "OK", style: .plain) { bridge.updateChoose("ok") }
                    }
                }
            }
            .padding(.leading, 100).padding(.trailing, 12).padding(.top, 12)
        }
    }
}

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
                            HomeButton(title: T("Wake now"), style: .primary) { bridge.org("beat", agent.id) }
                            HomeButton(title: T("Pause"), style: .plain) { bridge.org("pause", agent.id) }
                        } else if agent.status == "paused" {
                            HomeButton(title: T("Resume"), style: .primary) { bridge.org("resume", agent.id) }
                        }
                        HomeButton(title: T("Close"), style: .plain) { bridge.orgCard = nil }
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}
