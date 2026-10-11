import AppKit
import Combine
import SwiftUI

/// Notch geometry for the screen the island lives on. Macs without a notch get
/// the same island sitting at the top centre of the menu bar.
struct NotchMetrics: Equatable {
    let hasNotch: Bool
    let height: CGFloat
    let width: CGFloat
    let screenFrame: CGRect

    static func current() -> NotchMetrics {
        let screen = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) ?? NSScreen.main ?? NSScreen.screens[0]
        let top = screen.safeAreaInsets.top
        if top > 0, let l = screen.auxiliaryTopLeftArea, let r = screen.auxiliaryTopRightArea {
            return NotchMetrics(hasNotch: true, height: top, width: screen.frame.width - l.width - r.width, screenFrame: screen.frame)
        }
        let bar = screen.frame.maxY - screen.visibleFrame.maxY
        return NotchMetrics(hasNotch: false, height: max(bar, 24), width: 150, screenFrame: screen.frame)
    }
}

/// Every size the island can take, in one place, so the SwiftUI shape and the
/// AppKit hit-test always agree on where the island is.
enum IslandLayout {
    static let panel = CGSize(width: 720, height: 250)
    static let wing: CGFloat = 46
    static let ear: CGFloat = 12
    static let expanded = CGSize(width: 640, height: 168)

    enum Phase { case hidden, compact, expanded }

    static func phase(_ bridge: OxBridge) -> Phase {
        if bridge.expanded { return .expanded }
        return bridge.sessions.isEmpty ? .hidden : .compact
    }

    /// width, height, bottom corner radius, top radius (<0 = concave ears)
    static func shape(_ phase: Phase, _ m: NotchMetrics) -> (w: CGFloat, h: CGFloat, corner: CGFloat, top: CGFloat) {
        switch phase {
        case .hidden: return (m.width, m.height, 10, 0)
        case .compact: return (m.width + 2 * wing + 2 * ear, m.height, 12, -ear)
        case .expanded: return (expanded.width, expanded.height, 26, -ear)
        }
    }
}

/// A fixed, transparent, click-through panel over the notch. The island is
/// drawn inside it; the panel only accepts the mouse while the pointer is over
/// the island itself, so the menu bar and windows below stay fully usable.
final class IslandPanel: NSPanel {
    private let bridge: OxBridge
    private var poll: Timer?
    private var pollInterval: TimeInterval = 0
    private var leaveWork: DispatchWorkItem?
    private var cancellables = Set<AnyCancellable>()

    init(bridge: OxBridge) {
        self.bridge = bridge
        super.init(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isFloatingPanel = true
        level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 3)
        backgroundColor = .clear
        isOpaque = false
        hasShadow = false
        isMovable = false
        hidesOnDeactivate = false
        ignoresMouseEvents = true
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]

        let host = NSHostingView(rootView: IslandRoot(bridge: bridge))
        host.wantsLayer = true
        host.layer?.backgroundColor = .clear
        contentView = host
        reposition(animated: false)
        setPoll(1.0 / 10)
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    func reposition(animated: Bool) {
        let m = NotchMetrics.current()
        let f = NSRect(x: m.screenFrame.midX - IslandLayout.panel.width / 2,
                       y: m.screenFrame.maxY - IslandLayout.panel.height,
                       width: IslandLayout.panel.width, height: IslandLayout.panel.height)
        setFrame(f, display: true)
    }

    // MARK: pointer polling (hover, click-through, the calf's gaze)

    /// 60 Hz near the island, 10 Hz elsewhere: hover feels instant, idle stays cheap.
    private func setPoll(_ interval: TimeInterval) {
        guard interval != pollInterval else { return }
        pollInterval = interval
        poll?.invalidate()
        let t = Timer(timeInterval: interval, repeats: true) { [weak self] _ in self?.tick() }
        t.tolerance = interval * 0.2
        RunLoop.main.add(t, forMode: .common)
        poll = t
    }

    private func tick() {
        let mouse = NSEvent.mouseLocation
        let f = frame
        let local = CGPoint(x: mouse.x - f.minX, y: f.maxY - mouse.y) // top-down
        let m = NotchMetrics.current()
        let s = IslandLayout.shape(IslandLayout.phase(bridge), m)
        let island = CGRect(x: (f.width - s.w) / 2, y: 0, width: s.w, height: s.h)
        let inside = island.insetBy(dx: -6, dy: -4).contains(local)

        if ignoresMouseEvents == inside { ignoresMouseEvents = !inside }

        if inside {
            leaveWork?.cancel()
            leaveWork = nil
            if !bridge.hovering { bridge.hovering = true }
        } else if bridge.hovering, leaveWork == nil {
            // Debounced: the island shrinking under the pointer must not flicker.
            let work = DispatchWorkItem { [weak self] in
                self?.bridge.hovering = false
                self?.leaveWork = nil
            }
            leaveWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
        }

        let p = Pointer.shared
        if abs(p.local.x - local.x) > 0.5 || abs(p.local.y - local.y) > 0.5 { p.local = local }

        let near = island.insetBy(dx: -260, dy: -200).contains(local)
        setPoll(near || bridge.expanded ? 1.0 / 60 : 1.0 / 10)
    }
}
