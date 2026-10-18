import SwiftUI
import AppKit

/// Coucou's pill: while you dictate, a small see-through pill at the bottom
/// (or a side) of the screen shows bars that move with your voice and the
/// words as they come; hover it for Done and Cancel. Position:
///   defaults write dev.ox.island dictation.pill bottom|left|right|off
@MainActor
final class DictationPillController {
    private var panel: NSPanel?
    private weak var dictation: Dictation?
    private var watcher: Any?

    static var position: String { UserDefaults.standard.string(forKey: "dictation.pill") ?? "bottom" }

    func attach(_ d: Dictation) {
        dictation = d
        watcher = d.$phase.sink { [weak self] p in
            MainActor.assumeIsolated { p == .listening ? self?.show() : self?.hide() }
        }
    }

    private func show() {
        guard Self.position != "off", let d = dictation, let screen = NSScreen.main else { return }
        if panel == nil {
            let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 300, height: 46), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            p.isFloatingPanel = true
            p.level = .statusBar
            p.backgroundColor = .clear
            p.isOpaque = false
            p.hasShadow = true
            p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
            p.contentView = NSHostingView(rootView: DictationPillView(dictation: d))
            panel = p
        }
        let f = screen.visibleFrame
        let w: CGFloat = 300, h: CGFloat = 46
        let origin: NSPoint = switch Self.position {
        case "left": NSPoint(x: f.minX + 18, y: f.midY - h / 2)
        case "right": NSPoint(x: f.maxX - w - 18, y: f.midY - h / 2)
        default: NSPoint(x: f.midX - w / 2, y: f.minY + 22)
        }
        panel?.setFrame(NSRect(origin: origin, size: NSSize(width: w, height: h)), display: true)
        panel?.alphaValue = 0
        panel?.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { $0.duration = 0.18; panel?.animator().alphaValue = 1 }
    }

    private func hide() {
        guard let p = panel, p.isVisible else { return }
        NSAnimationContext.runAnimationGroup({ $0.duration = 0.2; p.animator().alphaValue = 0 }, completionHandler: { p.orderOut(nil) })
    }
}

struct DictationPillView: View {
    @ObservedObject var dictation: Dictation
    @State private var hover = false
    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30)) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            HStack(spacing: 10) {
                HStack(spacing: 2.5) {
                    ForEach(0..<9, id: \.self) { i in
                        let wave = 0.5 + 0.5 * sin(t * 10 + Double(i) * 0.8)
                        Capsule().fill(Color(hex: "#7DD3FC"))
                            .frame(width: 3, height: 4 + 20 * CGFloat(dictation.level * (0.5 + 0.5 * wave)))
                    }
                }
                .frame(width: 44)
                Text(dictation.heard.isEmpty ? "Listening…" : String(dictation.heard.suffix(60)))
                    .font(.system(size: 12, weight: .medium)).foregroundStyle(.white.opacity(dictation.heard.isEmpty ? 0.55 : 0.92))
                    .lineLimit(1).truncationMode(.head)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if hover {
                    Button { dictation.stop() } label: { Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)) }
                        .buttonStyle(.plain).foregroundStyle(Color(hex: "#34D399")).help(T("Done: paste it"))
                    Button { dictation.cancel() } label: { Image(systemName: "xmark").font(.system(size: 11, weight: .bold)) }
                        .buttonStyle(.plain).foregroundStyle(.white.opacity(0.7)).help(T("Cancel (Esc)"))
                }
            }
            .padding(.horizontal, 14)
            .frame(width: 300, height: 46)
            .background(.ultraThinMaterial, in: Capsule())
            .overlay(Capsule().stroke(Color.white.opacity(0.12), lineWidth: 1))
            .environment(\.colorScheme, .dark)
            .onHover { h in withAnimation(.easeOut(duration: 0.15)) { hover = h } }
        }
    }
}
