import AppKit
import Combine
import SwiftUI

/// Notch geometry for the screen the island lives on. Macs without a notch get
/// a pill of the same shape sitting at the top centre of the menu bar.
struct NotchMetrics {
    let screen: NSScreen
    let hasNotch: Bool
    let height: CGFloat
    let width: CGFloat

    static func current() -> NotchMetrics {
        let screen = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) ?? NSScreen.main ?? NSScreen.screens[0]
        let top = screen.safeAreaInsets.top
        if top > 0, let l = screen.auxiliaryTopLeftArea, let r = screen.auxiliaryTopRightArea {
            return NotchMetrics(screen: screen, hasNotch: true, height: top, width: screen.frame.width - l.width - r.width)
        }
        let bar = screen.frame.maxY - screen.visibleFrame.maxY
        return NotchMetrics(screen: screen, hasNotch: false, height: max(bar, 24), width: 120)
    }
}

/// Borderless, non-activating panel hugging the notch. It never steals focus
/// from the terminal, floats above the menu bar, and follows every Space.
final class IslandPanel: NSPanel {
    private let bridge: OxBridge
    private var cancellables = Set<AnyCancellable>()
    private var collapseWork: DispatchWorkItem?

    static let wing: CGFloat = 64          // collapsed width added each side of the notch
    static let expandedWidth: CGFloat = 470

    init(bridge: OxBridge) {
        self.bridge = bridge
        super.init(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isFloatingPanel = true
        level = .statusBar
        backgroundColor = .clear
        isOpaque = false
        hasShadow = false
        isMovable = false
        hidesOnDeactivate = false
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]

        let host = NSHostingView(rootView: IslandView(bridge: bridge, metrics: NotchMetrics.current()))
        host.wantsLayer = true
        host.layer?.backgroundColor = .clear
        contentView = host

        // Resize whenever what the island shows changes.
        bridge.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in DispatchQueue.main.async { self?.reposition(animated: true) } }
            .store(in: &cancellables)
        reposition(animated: false)
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    func targetSize() -> CGSize {
        let m = NotchMetrics.current()
        guard bridge.expanded else {
            return CGSize(width: m.width + Self.wing * 2, height: m.height)
        }
        let rows = max(bridge.sessions.count, 1)
        var h = m.height + 18 + CGFloat(rows) * 58
        if bridge.pendingSession != nil { h += 128 }
        return CGSize(width: max(Self.expandedWidth, m.width + Self.wing * 2), height: min(h + 14, 520))
    }

    func reposition(animated: Bool) {
        let m = NotchMetrics.current()
        let size = targetSize()
        let frame = NSRect(x: m.screen.frame.midX - size.width / 2,
                           y: m.screen.frame.maxY - size.height,
                           width: size.width, height: size.height)
        guard frame != self.frame else { return }
        if animated {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.22
                ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                animator().setFrame(frame, display: true)
            }
        } else {
            setFrame(frame, display: true)
        }
    }
}
