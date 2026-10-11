import SwiftUI

struct IslandView: View {
    @ObservedObject var bridge: OxBridge
    let metrics: NotchMetrics
    @State private var hoverWork: DispatchWorkItem?

    var body: some View {
        let expanded = bridge.expanded
        VStack(spacing: 0) {
            collapsedBar
            if expanded {
                expandedBody
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(
            UnevenRoundedRectangle(bottomLeadingRadius: expanded ? 26 : 12, bottomTrailingRadius: expanded ? 26 : 12)
                .fill(Color.black)
        )
        .animation(.spring(response: 0.3, dampingFraction: 0.86), value: expanded)
        .onHover { inside in
            // Debounced collapse so the shrink cannot re-trigger hover and flicker.
            hoverWork?.cancel()
            if inside {
                bridge.hovering = true
            } else {
                let work = DispatchWorkItem { bridge.hovering = false }
                hoverWork = work
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: work)
            }
        }
        .onTapGesture { bridge.pinnedOpen.toggle() }
    }

    // Left wing: the ox. Notch gap in the middle. Right wing: status.
    private var collapsedBar: some View {
        HStack(spacing: 0) {
            HStack {
                OxMascot(mood: bridge.headlineMood, size: metrics.height - 6)
                Spacer(minLength: 0)
            }
            .padding(.leading, 12)
            .frame(width: IslandPanel.wing + (bridge.expanded ? 40 : 0))
            Spacer(minLength: metrics.width)
            HStack {
                Spacer(minLength: 0)
                statusChip
            }
            .padding(.trailing, 12)
            .frame(width: IslandPanel.wing + (bridge.expanded ? 40 : 0))
        }
        .frame(height: metrics.height)
    }

    @ViewBuilder private var statusChip: some View {
        switch bridge.headlineMood {
        case .sleeping:
            Text("ox").font(.system(size: 11, weight: .semibold, design: .rounded)).foregroundStyle(.white.opacity(0.35))
        case .needsYou:
            Image(systemName: "hand.raised.fill").foregroundStyle(.yellow).symbolEffect(.pulse)
        case .error:
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
        case .done:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .working, .thinking:
            HStack(spacing: 4) {
                ProgressView().controlSize(.mini).tint(.white)
                if bridge.sessions.count > 1 {
                    Text("\(bridge.sessions.count)").font(.system(size: 11, weight: .bold, design: .rounded)).foregroundStyle(.white)
                }
            }
        case .idle:
            Circle().fill(Color.green.opacity(0.8)).frame(width: 7, height: 7)
        }
    }

    private var expandedBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let s = bridge.pendingSession, let p = s.pending {
                ApprovalCard(session: s, pending: p, bridge: bridge)
            }
            if bridge.sessions.isEmpty {
                HStack(spacing: 10) {
                    OxMascot(mood: .sleeping, size: 34)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("No ox runs").font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                        Text("Start one with  ox  — it shows up here automatically.")
                            .font(.system(size: 11)).foregroundStyle(.white.opacity(0.55))
                    }
                }
            } else {
                ForEach(bridge.sessions) { s in SessionRow(session: s) }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 14)
    }
}

struct SessionRow: View {
    let session: AgentSession

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            OxMascot(mood: session.mood, size: 30)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(session.project).font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                    if !session.model.isEmpty {
                        Text(session.model).font(.system(size: 10, weight: .medium, design: .monospaced))
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Capsule().fill(Color.white.opacity(0.12)))
                            .foregroundStyle(.white.opacity(0.7))
                    }
                    Spacer(minLength: 0)
                    if session.tokensIn + session.tokensOut > 0 {
                        Text(tokenText).font(.system(size: 10, design: .monospaced)).foregroundStyle(.white.opacity(0.45))
                    }
                }
                Text(session.activity)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(activityColor)
                    .lineLimit(1).truncationMode(.middle)
            }
        }
        .frame(height: 48)
    }

    private var tokenText: String {
        let total = session.tokensIn + session.tokensOut
        let t = total >= 1000 ? String(format: "%.1fk tok", Double(total) / 1000) : "\(total) tok"
        return session.costUsd > 0 ? "\(t) · $\(String(format: "%.3f", session.costUsd))" : t
    }

    private var activityColor: Color {
        switch session.mood {
        case .error: return .red.opacity(0.9)
        case .needsYou: return .yellow
        case .done: return .green.opacity(0.85)
        default: return .white.opacity(0.6)
        }
    }
}

struct ApprovalCard: View {
    let session: AgentSession
    let pending: PendingApproval
    @ObservedObject var bridge: OxBridge

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "hand.raised.fill").foregroundStyle(.yellow)
                Text("\(session.project) wants to run \(pending.tool)")
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                Spacer()
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    let left = max(0, Int(pending.deadline.timeIntervalSince(ctx.date)))
                    Text("\(left)s").font(.system(size: 10, design: .monospaced)).foregroundStyle(.white.opacity(0.4))
                }
            }
            if !pending.preview.isEmpty {
                Text(pending.preview)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.8))
                    .lineLimit(3)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.08)))
            }
            HStack(spacing: 8) {
                Button { bridge.answer(session, allow: false) } label: {
                    Text("Deny").frame(maxWidth: .infinity)
                }
                .buttonStyle(IslandButton(fill: .white.opacity(0.12)))
                .keyboardShortcut(.cancelAction)
                Button { bridge.deferToTerminal(session) } label: {
                    Text("Terminal").frame(maxWidth: .infinity)
                }
                .buttonStyle(IslandButton(fill: .white.opacity(0.06)))
                Button { bridge.answer(session, allow: true) } label: {
                    Text("Allow").frame(maxWidth: .infinity)
                }
                .buttonStyle(IslandButton(fill: Color(red: 0.93, green: 0.62, blue: 0.33)))
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.06)))
    }
}

struct IslandButton: ButtonStyle {
    let fill: Color
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 9).fill(fill.opacity(configuration.isPressed ? 0.7 : 1)))
    }
}
