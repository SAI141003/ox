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

    /// Which display: the notched one (default), or the one your pointer is on
    /// with several displays:  defaults write dev.ox.island island.screen active
    static var followsPointer: Bool { UserDefaults.standard.string(forKey: "island.screen") == "active" && NSScreen.screens.count > 1 }
    static func pointerScreen() -> NSScreen? { let p = NSEvent.mouseLocation; return NSScreen.screens.first { $0.frame.contains(p) } }

    static func current() -> NotchMetrics {
        let screen = (followsPointer ? pointerScreen() : nil) ?? NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) ?? NSScreen.main ?? NSScreen.screens[0]
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
    static let panel = CGSize(width: 720, height: 540)
    static let wing: CGFloat = 46
    static let ear: CGFloat = 12
    /// Standard, or Compact ("make the island smaller"): no walking-ox floor and a narrower card.
    static var compact: Bool { UserDefaults.standard.string(forKey: "island.size") == "compact" }
    /// The floor the (full-size) ox walks on, under the card (none when compact).
    /// Sessions are listed: the island stays slim like Coucou's and Claudex's
    /// (small characters in the rows, no walking-ox floor under them).
    static var busy = false
    /// The ox lives at the card's left, so
    /// there is no separate floor under it: the island stays slim in every state.
    static var floorHeight: CGFloat { 0 }
    /// Coucou's proportions: 640 wide, 160 tall (8 top, 34 header, 98 cards, 10 bottom, 10 spare).
    static var expanded: CGSize { CGSize(width: compact ? 560 : 640, height: 160) }
    /// The session card, the chat or the + tools under the cards.
    static let panelExtra: CGFloat = 176
    /// The office tab (a 4:3 room) is taller than the other tabs.
    static let officeTall: CGFloat = 340
    static var officeOpen = false
    /// Seconds the island stays open after the pointer leaves (0 = until you close it).
    static var autoClose: TimeInterval { UserDefaults.standard.object(forKey: "island.autoClose") as? Double ?? 6 }
    /// With nothing running the card is one line, so the island is shorter.
    static let idleCardTrim: CGFloat = 26
    /// Extra height under the card: the agent office, or the run's OX Canvas.
    static let officeHeight: CGFloat = 132

    enum Phase { case launch, hidden, compact, expanded }
    static let launchSize = CGSize(width: 520, height: 150)

    static func phase(_ bridge: OxBridge) -> Phase {
        if bridge.launching { return .launch }
        if bridge.expanded { return .expanded }
        // The ox always lives in the wings: asleep when nothing runs (OX_ISLAND_HIDE_IDLE=1 hides it).
        if bridge.sessions.isEmpty && ProcessInfo.processInfo.environment["OX_ISLAND_HIDE_IDLE"] == "1" { return .hidden }
        return .compact
    }

    /// width, height, bottom corner radius, top radius (<0 = concave ears)
    /// A session card is a little taller than the office (it has a message box).
    static var cardOpen = false
    /// A narrated step under the closed notch (Vovy's "Checking your project setup"): one line taller.
    static var tickerOn = false
    static let tickerHeight: CGFloat = 26
    /// A race shows one row per lane (lumiomac's two timelines).
    static var tickerRows = 1
    static var trayOpen = false
    static func shape(_ phase: Phase, _ m: NotchMetrics, office: Bool = false, idle: Bool = false) -> (w: CGFloat, h: CGFloat, corner: CGFloat, top: CGFloat) {
        switch phase {
        case .launch: return (launchSize.width, launchSize.height, 30, -ear)
        case .hidden: return (m.width, m.height, 10, 0)
        case .compact: return tickerOn ? (max(m.width + 2 * wing + 2 * ear, tickerRows > 1 ? 470 : 380), m.height + tickerHeight * CGFloat(tickerRows) + (tickerRows > 1 ? 4 : 0), 16, -ear) : (m.width + 2 * wing + 2 * ear, m.height, 12, -ear)
        case .expanded: return (expanded.width, expanded.height + (office ? (officeOpen && trayOpen ? officeTall + 36 : cardOpen || trayOpen ? panelExtra : officeHeight) + 8 : 0), 22, -ear)
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
    private var awaySince: Date?
    private var cancellables = Set<AnyCancellable>()
    private var clickMonitor: Any?
    /// The notch geometry, refreshed when displays change (not 60 times a second).
    private var metrics = NotchMetrics.current()
    /// A presentation/video gets the screen unless Ox is actually waiting for
    /// the person. `fullScreenAuxiliary` is kept so an approval can still be
    /// shown above a full-screen app.
    private var hiddenForFullscreen = false

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

        let host = FirstClickHostingView(rootView: IslandRoot(bridge: bridge))
        host.wantsLayer = true
        host.layer?.backgroundColor = .clear
        contentView = host
        reposition(animated: false)
        setPoll(1.0 / 10)
        // Every click on the island, so the ox can trot over and "press" it too.
        clickMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] ev in
            if let self, ev.window === self {
                let p = ev.locationInWindow
                Pointer.shared.lastClick = (CGPoint(x: p.x, y: self.frame.height - p.y), Date().timeIntervalSinceReferenceDate)
            }
            return ev
        }
        bridge.cardChanged = { [weak self] open in
            DispatchQueue.main.async { if open { self?.makeKeyAndOrderFront(nil) } else if self?.isKeyWindow == true, self?.bridge.tray != .chat { self?.resignKey() } }
        }
        bridge.trayChanged = { [weak self] tab in
            DispatchQueue.main.async {
                if tab == .chat { self?.makeKeyAndOrderFront(nil) } else if self?.isKeyWindow == true { self?.resignKey() }
            }
        }
    }

    // Only while the chat is open: the island never takes keystrokes from the
    // app you are typing in unless you opened its text box.
    override var canBecomeKey: Bool { bridge.tray == .chat || bridge.card != nil }
    override var canBecomeMain: Bool { false }

    func reposition(animated: Bool) {
        metrics = NotchMetrics.current()
        let m = metrics
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
        updateFullscreenVisibility()
        if hiddenForFullscreen { return }
        // Several displays, following the pointer: move when it crosses to another screen.
        if NotchMetrics.followsPointer, let sc = NotchMetrics.pointerScreen(), sc.frame != metrics.screenFrame, !bridge.expanded { reposition(animated: false) }
        let mouse = NSEvent.mouseLocation
        let f = frame
        let local = CGPoint(x: mouse.x - f.minX, y: f.maxY - mouse.y) // top-down
        let m = metrics
        let s = IslandLayout.shape(IslandLayout.phase(bridge), m, office: bridge.hasExtraPanel, idle: bridge.idleIsland)
        let island = CGRect(x: (f.width - s.w) / 2, y: 0, width: s.w, height: s.h)
        let inside = island.insetBy(dx: -6, dy: -4).contains(local)

        if ignoresMouseEvents == inside { ignoresMouseEvents = !inside }

        // Opened by a click (or a tool), it closes on its own once the pointer
        // has been away a few seconds, unless an answer is coming or ox waits on you.
        if inside { awaySince = nil }
        else if bridge.pinnedOpen || bridge.tray != nil || bridge.card != nil {
            if awaySince == nil { awaySince = Date() }
            let wait = IslandLayout.autoClose
            if wait > 0, let since = awaySince, Date().timeIntervalSince(since) > wait,
               !bridge.chat.busy, bridge.pendingSession == nil, !bridge.buddyActive, !(bridge.card?.busy ?? false),
               // Typing in the island (a message to a session, the chat): it stays until you close it.
               !isKeyWindow {
                bridge.pinnedOpen = false
                bridge.tray = nil
                bridge.card = nil
                awaySince = nil
            }
        }

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
        if abs(p.local.x - local.x) > 0.5 || abs(p.local.y - local.y) > 0.5 { p.local = local; p.movedAt = Date().timeIntervalSinceReferenceDate }

        let near = island.insetBy(dx: -260, dy: -200).contains(local)
        setPoll(near || bridge.expanded ? 1.0 / 60 : 1.0 / 10)
    }

    /// Hide only for another app's *real* full-screen window, not a merely
    /// maximised window. A pending approval (or a session in needs-you state)
    /// always wins: the island returns so the person can respond.
    private func updateFullscreenVisibility() {
        let configured = UserDefaults.standard.object(forKey: "island.hideFullscreen") as? Bool
        let hideEnabled = configured ?? true
        let needsPerson = bridge.pendingSession != nil || bridge.sessions.contains { $0.mood == .needsYou }
        let shouldHide = hideEnabled && !needsPerson && frontmostWindowCoversIslandScreen()
        guard shouldHide != hiddenForFullscreen else { return }
        hiddenForFullscreen = shouldHide
        if shouldHide {
            ignoresMouseEvents = true
            orderOut(nil)
        } else {
            orderFrontRegardless()
        }
    }

    private func frontmostWindowCoversIslandScreen() -> Bool {
        guard let app = NSWorkspace.shared.frontmostApplication,
              app.processIdentifier != ProcessInfo.processInfo.processIdentifier,
              let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return false }
        let screen = metrics.screenFrame
        // Core Graphics reports window bounds in top-left screen coordinates;
        // width/height are coordinate-system independent. A normal maximised
        // window leaves the menu bar, while full screen covers virtually all of
        // this display's height.
        return windows.contains { window in
            guard (window[kCGWindowOwnerPID as String] as? pid_t) == app.processIdentifier,
                  (window[kCGWindowLayer as String] as? Int ?? -1) == 0,
                  let bounds = window[kCGWindowBounds as String] as? [String: CGFloat],
                  (window[kCGWindowIsOnscreen as String] as? Bool ?? false) else { return false }
            let width = bounds["Width"] ?? 0, height = bounds["Height"] ?? 0
            return width >= screen.width * 0.98 && height >= screen.height * 0.98
        }
    }
}


/// The island never takes focus from the app you are in, so the first click on
/// it must act (Allow, a session, a tray tool), not just bring the panel forward.
final class FirstClickHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
