import SwiftUI
import WidgetKit
import ActivityKit
import AppIntents

// The lock screen and Dynamic Island face of OX: what waits on your Mac, with
// Deny and Allow right there (Coucou's lock-screen approvals).

@main
struct OxWidgets: WidgetBundle {
    var body: some Widget { OxApprovalLiveActivity() }
}

private let oxBlue = Color(red: 0.49, green: 0.83, blue: 0.99)

struct OxApprovalLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: OxApprovalAttributes.self) { ctx in
            LockScreenView(state: ctx.state, mac: ctx.attributes.mac)
                .activityBackgroundTint(Color.black.opacity(0.85))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { ctx in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label(ctx.state.approval?.project ?? "OX", systemImage: "hand.raised.fill").font(.caption.weight(.semibold)).foregroundStyle(oxBlue)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if ctx.state.waiting > 1 { Text("+\(ctx.state.waiting - 1)").font(.caption).foregroundStyle(.secondary) }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if let a = ctx.state.approval { ApprovalRow(approval: a) } else { Text(ctx.state.note).font(.caption) }
                }
            } compactLeading: {
                Image(systemName: "hand.raised.fill").foregroundStyle(oxBlue)
            } compactTrailing: {
                Text(ctx.state.approval?.tool ?? "ox").font(.caption2.weight(.semibold))
            } minimal: {
                Image(systemName: "hand.raised.fill").foregroundStyle(oxBlue)
            }
        }
    }
}

struct LockScreenView: View {
    let state: OxApprovalAttributes.ContentState
    let mac: String
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Circle().fill(Color.orange).frame(width: 7, height: 7)
                Text(state.approval.map { "\($0.project) wants to run \($0.tool)" } ?? state.note).font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                Spacer()
                Text(state.waiting > 1 ? "\(state.waiting) waiting · \(mac)" : mac).font(.caption2).foregroundStyle(.white.opacity(0.6))
            }
            if let a = state.approval { ApprovalRow(approval: a) }
        }
        .padding(14)
    }
}

struct ApprovalRow: View {
    let approval: Approval
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(approval.preview.isEmpty ? approval.tool : approval.preview)
                .font(.system(.caption, design: .monospaced)).foregroundStyle(.white).lineLimit(2)
                .padding(.horizontal, 8).padding(.vertical, 5)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.1)))
            HStack(spacing: 8) {
                Button(intent: DenyIntent(socket: approval.socket, approvalId: approval.id)) { Text("Deny").frame(maxWidth: .infinity) }
                    .tint(.gray)
                Button(intent: AllowIntent(socket: approval.socket, approvalId: approval.id)) { Label("Allow", systemImage: "faceid").frame(maxWidth: .infinity) }
                    .tint(oxBlue)
            }
            .buttonStyle(.borderedProminent)
            .font(.caption.weight(.semibold))
        }
    }
}
