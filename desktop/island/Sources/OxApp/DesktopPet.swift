import AppKit
import Combine
import SwiftUI
import WebKit

/// A small, separate desktop companion. The main Ox window may close while this
/// accessory panel keeps the app alive; it is not the Island and never edits
/// the Island's character or animation state.
@MainActor
final class DesktopPetController: NSObject, ObservableObject {
    @Published private(set) var petID: String
    @Published private(set) var petName: String
    @Published private(set) var petEmoji: String
    @Published private(set) var petColor: String
    @Published private(set) var petExpression: String
    @Published private(set) var petSVG: String?
    @Published private(set) var petExpressionSVGs: [String: String]
    @Published private(set) var petSize: CGFloat
    @Published private(set) var isWorking = false

    private let defaults = UserDefaults.standard
    private var panel: NSPanel?
    var onOpenChat: (() -> Void)?
    var onTalk: (() -> Void)?
    var onSettings: (() -> Void)?
    var onHide: (() -> Void)?

    override init() {
        petID = UserDefaults.standard.string(forKey: "ox.desktopPet.id") ?? "codex"
        petName = UserDefaults.standard.string(forKey: "ox.desktopPet.name") ?? "Codex"
        petEmoji = UserDefaults.standard.string(forKey: "ox.desktopPet.emoji") ?? "🤖"
        petColor = UserDefaults.standard.string(forKey: "ox.desktopPet.color") ?? "#7397ff"
        petExpression = UserDefaults.standard.string(forKey: "ox.desktopPet.expression") ?? "neutral"
        petSVG = UserDefaults.standard.string(forKey: "ox.desktopPet.svg")
        petExpressionSVGs = UserDefaults.standard.dictionary(forKey: "ox.desktopPet.expressionSVGs") as? [String: String] ?? [:]
        let savedSize = UserDefaults.standard.double(forKey: "ox.desktopPet.size")
        petSize = savedSize > 0 ? CGFloat(savedSize) : 132
        super.init()
        buildPanel()
        if defaults.object(forKey: "ox.desktopPet.visible") as? Bool ?? true { panel?.orderFrontRegardless() }
    }

    func update(_ message: [String: Any]) {
        if let busy = message["busy"] as? Bool { isWorking = busy }
        guard message["id"] != nil || message["visible"] != nil || message["size"] != nil else { return }
        petID = message["id"] as? String ?? petID
        petName = message["name"] as? String ?? petName
        petEmoji = message["emoji"] as? String ?? petEmoji
        petColor = message["color"] as? String ?? petColor
        petExpression = message["expression"] as? String ?? petExpression
        if message.keys.contains("svg") { petSVG = message["svg"] as? String }
        if let variants = message["expressionSvgs"] as? [String: String] { petExpressionSVGs = variants }
        petSize = min(144, max(32, CGFloat(message["size"] as? Double ?? Double(petSize))))
        let savedVisibility = defaults.object(forKey: "ox.desktopPet.visible") as? Bool ?? true
        let visible = (message["visible"] as? Bool ?? savedVisibility) && petID != "none"

        defaults.set(petID, forKey: "ox.desktopPet.id")
        defaults.set(petName, forKey: "ox.desktopPet.name")
        defaults.set(petEmoji, forKey: "ox.desktopPet.emoji")
        defaults.set(petColor, forKey: "ox.desktopPet.color")
        defaults.set(petExpression, forKey: "ox.desktopPet.expression")
        defaults.set(petSVG, forKey: "ox.desktopPet.svg")
        defaults.set(petExpressionSVGs, forKey: "ox.desktopPet.expressionSVGs")
        defaults.set(Double(petSize), forKey: "ox.desktopPet.size")
        defaults.set(visible, forKey: "ox.desktopPet.visible")

        if visible {
            resizePanel()
            panel?.orderFrontRegardless()
        } else {
            panel?.orderOut(nil)
        }
    }

    func svg(for expression: String) -> String? {
        let svg = petExpressionSVGs[expression] ?? petSVG
        guard let svg, svg.contains("<svg") else { return nil }
        return svg
    }

    private func buildPanel() {
        let content = DesktopPetView(controller: self)
        let hosting = NSHostingView(rootView: content)
        hosting.wantsLayer = true
        hosting.layer?.backgroundColor = NSColor.clear.cgColor

        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 164, height: 184),
                            styleMask: [.borderless, .nonactivatingPanel],
                            backing: .buffered, defer: false)
        panel.contentView = hosting
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        self.panel = panel
        resizePanel()
    }

    private func resizePanel() {
        guard let panel else { return }
        let size = max(32, min(144, petSize))
        let frame = NSRect(x: 0, y: 0, width: size + 20, height: size + 48)
        panel.setFrame(frame, display: true)
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
        panel.setFrameOrigin(NSPoint(x: screen.maxX - frame.width - 24, y: screen.minY + 24))
    }

    func wander() {
        guard let panel, panel.isVisible, NSEvent.pressedMouseButtons == 0 else { return }
        let screen = (panel.screen ?? NSScreen.main)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
        let frame = panel.frame
        let x = CGFloat.random(in: (screen.minX + 20)...max(screen.minX + 21, screen.maxX - frame.width - 20))
        let y = CGFloat.random(in: (screen.minY + 20)...max(screen.minY + 21, screen.maxY - frame.height - 20))
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 2.8
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            panel.animator().setFrameOrigin(NSPoint(x: x, y: y))
        }
    }
}

private struct DesktopPetView: View {
    @ObservedObject var controller: DesktopPetController
    @State private var hovered = false
    private let stroll = Timer.publish(every: 18, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 1) {
            Button { controller.onOpenChat?() } label: {
                TimelineView(.animation(minimumInterval: 0.12, paused: false)) { timeline in
                    let time = timeline.date.timeIntervalSinceReferenceDate
                    let blink = sin(time * 0.72) > 0.992
                    let bob = sin(time * 2.2) * 2.4
                    let workingMood = Int(time / 2.8).isMultiple(of: 2) ? "thinking" : "focused"
                    let expression = controller.isWorking ? workingMood : controller.petExpression
                    let art = controller.svg(for: expression)
                    Group {
                        if let art {
                            // NSImage(data:) does not reliably decode SVG on macOS. A small,
                            // transparent WKWebView renders the exact same vetted SVG that the
                            // settings picker and browser companion use, rather than falling
                            // back to a generic emoji or an opaque tile.
                            SVGPetArtwork(svg: art)
                        } else {
                            Text(controller.petEmoji).font(.system(size: min(112, controller.petSize * 0.8)))
                        }
                    }
                    .overlay(alignment: .topTrailing) {
                        if art == nil {
                            Text(expressionMark(controller.petExpression))
                                .font(.system(size: max(10, controller.petSize * 0.16), weight: .bold))
                                .foregroundStyle(Color(red: 0.55, green: 0.72, blue: 1))
                                .frame(width: max(20, controller.petSize * 0.25), height: max(20, controller.petSize * 0.25))
                                .background(.black.opacity(0.82), in: Circle())
                                .overlay(Circle().stroke(.white.opacity(0.2), lineWidth: 1))
                                .offset(x: 2, y: -2)
                        }
                    }
                    .scaleEffect(x: sin(time * 0.16) > 0.96 ? -1 : 1, y: blink ? 0.82 : 1)
                    .offset(y: bob)
                    .overlay(alignment: .bottomTrailing) {
                        if controller.isWorking {
                            Image(systemName: "laptopcomputer")
                                .font(.system(size: max(12, controller.petSize * 0.2), weight: .semibold))
                                .foregroundStyle(Color(red: 0.55, green: 0.78, blue: 1))
                                .padding(4)
                                .background(.black.opacity(0.78), in: RoundedRectangle(cornerRadius: 5))
                                .offset(x: 4, y: 1)
                        }
                    }
                    .frame(width: controller.petSize, height: controller.petSize)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open Ox chat with \(controller.petName), \(controller.isWorking ? "working" : controller.petExpression)")
            .help("Open Ox chat")

            if hovered {
                HStack(spacing: 0) {
                    action("bubble.left", label: "Open Ox chat", help: "Open chat", perform: controller.onOpenChat)
                    Divider().frame(height: 20)
                    action("waveform", label: "Talk to Ox", help: "Start a voice conversation", perform: controller.onTalk)
                    Divider().frame(height: 20)
                    action("xmark", label: "Hide desktop pet", help: "Hide pet until Ox is opened again") {
                        controller.update(["visible": false, "id": controller.petID,
                                           "name": controller.petName, "emoji": controller.petEmoji,
                                           "color": controller.petColor, "size": Double(controller.petSize)])
                    }
                }
                .padding(.horizontal, 4)
                .background(.ultraThinMaterial, in: Capsule())
                .overlay(Capsule().stroke(Color.white.opacity(0.16), lineWidth: 1))
            }
        }
        .frame(width: controller.petSize + 20, height: controller.petSize + 48)
        .onHover { hovered = $0 }
        .onReceive(stroll) { _ in controller.wander() }
    }

    private func action(_ symbol: String, label: String, help: String, perform: (() -> Void)?) -> some View {
        Button { perform?() } label: {
            Image(systemName: symbol).font(.system(size: 15, weight: .medium))
                .frame(width: 36, height: 32).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .help(help)
    }

    private func expressionMark(_ expression: String) -> String {
        switch expression {
        case "happy": return "☺"
        case "thinking": return "…"
        case "focused": return "⌁"
        case "sleepy": return "ᴗ"
        case "surprised": return "!"
        case "curious": return "?"
        case "worried": return "﹏"
        case "proud": return "⌣"
        case "celebrating": return "✦"
        default: return "•"
        }
    }
}

/// Renders Ox's internally generated companion SVG without a background. This
/// is deliberately a view, not a remote URL: pets continue to work offline and
/// no user data or pet selection leaves the Mac.
private struct SVGPetArtwork: NSViewRepresentable {
    let svg: String

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.setValue(false, forKey: "drawsBackground")
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.lastSVG != svg else { return }
        context.coordinator.lastSVG = svg
        let document = """
        <!doctype html><html><head><meta charset=\"utf-8\"><style>
        html,body { margin:0; width:100%; height:100%; overflow:hidden; background:transparent; }
        body { display:grid; place-items:center; }
        svg { width:100%; height:100%; image-rendering:pixelated; }
        </style></head><body>\(svg)</body></html>
        """
        webView.loadHTMLString(document, baseURL: nil)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var lastSVG = ""
    }
}
