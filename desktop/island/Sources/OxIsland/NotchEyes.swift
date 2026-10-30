import AppKit
import SwiftUI

// The eyes that live beside the notch: two glowing mint pills that blink and
// watch the pointer. Poke them and they turn red; poke three times fast and
// they go dizzy. They dance while music plays, doze when you walk away, and
// light up with hearts when you come back. A run's state wins over play:
// amber while it needs you, a red x on an error, ^ ^ when it finishes.

enum EyeLook: Equatable { case open, angry, dizzy, sleep, love, happy, alert, error, scan }

enum EyeInk {
    static let mint = Color(hex: "#E0FBCF")
    static let glow = Color(hex: "#9BE870")
    static let red = Color(hex: "#FF4D5A")
    static let heart = Color(hex: "#FF4F8B")
    static let amber = Color(hex: "#F5B83D")
    static let music = Color(hex: "#E0475A")
}

/// What the eyes are doing, on their own clock (read by the view each frame).
final class EyeBrain {
    static let shared = EyeBrain()
    /// Shown in the notch at all ("island.eyes", on by default).
    static var enabled: Bool { UserDefaults.standard.object(forKey: "island.eyes") as? Bool ?? true }
    /// Seconds with no mouse or keyboard before the eyes doze.
    static var awayAfter: Double { UserDefaults.standard.object(forKey: "island.eyes.awayAfter") as? Double ?? 90 }

    private var pokes: [Double] = []
    private(set) var lastPoke: Double = 0
    /// Reactions play in order: the hearts on your return, then a happy face.
    private var queue: [(look: EyeLook, until: Double)] = []
    private var asleep = false
    private var idleAt: Double = 0
    private var idle: Double = 0

    func poke(now t: Double = Date().timeIntervalSinceReferenceDate) {
        lastPoke = t
        pokes = pokes.filter { t - $0 < 2.2 } + [t]
        asleep = false
        if pokes.count >= 3 {
            pokes = []
            queue = [(.dizzy, t + 2.2)]
        } else {
            queue = [(.angry, t + 1.3)]
        }
    }

    func look(now t: Double, mood: Mood) -> EyeLook {
        queue.removeAll { $0.until <= t }
        if let r = queue.first { return r.look }
        // Seconds since any input, read twice a second, not every frame.
        if t - idleAt > 0.5 {
            idleAt = t
            idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: UInt32.max)!)
        }
        switch mood {
        case .needsYou: asleep = false; return .alert
        case .error: return .error
        default: break
        }
        if idle > Self.awayAfter { asleep = true; return .sleep }
        if asleep {
            // You are back: hearts, then a smile.
            asleep = false
            queue = [(.love, t + 1.8), (.happy, t + 2.8)]
            return .love
        }
        switch mood {
        case .done: return .happy
        case .working, .thinking: return .scan
        default: return .open
        }
    }
}

struct NotchEyes: View {
    let mood: Mood
    /// Music is playing: the eyes bob to it.
    var dancing = false
    var height: CGFloat = 32

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            let look = EyeBrain.shared.look(now: t, mood: mood)
            Canvas { g, size in
                Self.draw(&g, size: size, look: look, t: t, dancing: dancing && look == .open, gaze: gaze(size))
            }
        }
        .frame(height: height)
        .contentShape(Rectangle())
        .onTapGesture { EyeBrain.shared.poke() }
        .accessibilityLabel("Eyes")
        .accessibilityHint("Poke them")
    }

    /// Where the pointer is, as a small offset for the pupils (panel coordinates).
    private func gaze(_ size: CGSize) -> CGPoint {
        let p = Pointer.shared.local
        let dx = p.x - IslandLayout.panel.width / 2, dy = p.y - 16
        let d = max(1, hypot(dx, dy))
        return CGPoint(x: dx / d * min(2.2, d / 40), y: dy / d * min(1.4, d / 40))
    }

    static func draw(_ g: inout GraphicsContext, size: CGSize, look: EyeLook, t: Double, dancing: Bool, gaze: CGPoint) {
        let u = min(size.height, size.width / 1.6)
        let cy = size.height / 2
        let gap = u * 0.30
        let w = u * 0.17, h = u * 0.34
        let colour: Color = {
            switch look {
            case .angry, .error: return EyeInk.red
            case .love: return EyeInk.heart
            case .alert: return EyeInk.amber
            default: return EyeInk.mint
            }
        }()
        // Angry eyes shake; dancing ones bob in turn; busy ones scan side to side.
        let shake = look == .angry ? CGFloat(sin(t * 60)) * 0.8 : 0
        let scan = look == .scan ? CGFloat(sin(t * 2.4)) * u * 0.07 : 0
        let blink = [EyeLook.open, .scan].contains(look) && t.truncatingRemainder(dividingBy: 3.7) < 0.12
        let beat = t * .pi * 2 * 1.1
        for (i, side) in [-1.0, 1.0].enumerated() {
            let bob = dancing ? CGFloat(sin(beat + Double(i) * .pi)) * u * 0.07 : 0
            let c = CGPoint(x: size.width / 2 + CGFloat(side) * gap + shake + scan + (look == .open ? gaze.x : 0),
                            y: cy + bob + (look == .open ? gaze.y : 0))
            var shape = Path()
            var stroke = false
            switch look {
            case .open, .angry, .scan, .alert:
                let hh = blink ? h * 0.12 : (look == .alert ? h * (1.05 + 0.08 * CGFloat(sin(t * 6))) : h)
                let ww = look == .alert ? w * 1.15 : w
                shape = Path(roundedRect: CGRect(x: c.x - ww / 2, y: c.y - hh / 2, width: ww, height: hh), cornerRadius: ww / 2)
            case .sleep:
                // Closed: a soft ︶, breathing.
                shape.move(to: CGPoint(x: c.x - w * 0.95, y: c.y - h * 0.05))
                shape.addQuadCurve(to: CGPoint(x: c.x + w * 0.95, y: c.y - h * 0.05), control: CGPoint(x: c.x, y: c.y + h * 0.32))
                stroke = true
            case .happy:
                shape.move(to: CGPoint(x: c.x - w * 0.95, y: c.y + h * 0.12))
                shape.addQuadCurve(to: CGPoint(x: c.x + w * 0.95, y: c.y + h * 0.12), control: CGPoint(x: c.x, y: c.y - h * 0.42))
                stroke = true
            case .error:
                let e = w * 0.8
                shape.move(to: CGPoint(x: c.x - e, y: c.y - e)); shape.addLine(to: CGPoint(x: c.x + e, y: c.y + e))
                shape.move(to: CGPoint(x: c.x + e, y: c.y - e)); shape.addLine(to: CGPoint(x: c.x - e, y: c.y + e))
                stroke = true
            case .dizzy:
                // A spiral, turning.
                let turns = 2.2, steps = 40
                let spin = t * 7 * side
                for k in 0...steps {
                    let f = Double(k) / Double(steps)
                    let a = spin + f * turns * 2 * .pi
                    let r = CGFloat(f) * w * 1.25
                    let p = CGPoint(x: c.x + CGFloat(Foundation.cos(a)) * r, y: c.y + CGFloat(Foundation.sin(a)) * r)
                    if k == 0 { shape.move(to: p) } else { shape.addLine(to: p) }
                }
                stroke = true
            case .love:
                let s = w * (1.25 + 0.12 * CGFloat(sin(t * 9)))
                shape.move(to: CGPoint(x: c.x, y: c.y + s * 0.9))
                shape.addCurve(to: CGPoint(x: c.x - s, y: c.y - s * 0.2), control1: CGPoint(x: c.x - s * 0.5, y: c.y + s * 0.5), control2: CGPoint(x: c.x - s, y: c.y + s * 0.2))
                shape.addArc(center: CGPoint(x: c.x - s * 0.5, y: c.y - s * 0.25), radius: s * 0.5, startAngle: .degrees(180), endAngle: .degrees(0), clockwise: false)
                shape.addArc(center: CGPoint(x: c.x + s * 0.5, y: c.y - s * 0.25), radius: s * 0.5, startAngle: .degrees(180), endAngle: .degrees(0), clockwise: false)
                shape.addCurve(to: CGPoint(x: c.x, y: c.y + s * 0.9), control1: CGPoint(x: c.x + s, y: c.y + s * 0.2), control2: CGPoint(x: c.x + s * 0.5, y: c.y + s * 0.5))
                shape.closeSubpath()
            }
            let alpha = look == .sleep ? 0.55 + 0.25 * sin(t * 1.6) : 1
            let style = StrokeStyle(lineWidth: max(1.4, w * 0.42), lineCap: .round, lineJoin: .round)
            // The glow under the eye, then the eye.
            g.drawLayer { l in
                l.addFilter(.blur(radius: u * 0.12))
                if stroke { l.stroke(shape, with: .color((look == .love ? EyeInk.heart : colour == EyeInk.mint ? EyeInk.glow : colour).opacity(0.75 * alpha)), style: style) }
                else { l.fill(shape, with: .color((colour == EyeInk.mint ? EyeInk.glow : colour).opacity(0.75 * alpha))) }
            }
            if stroke { g.stroke(shape, with: .color(colour.opacity(alpha)), style: style) }
            else { g.fill(shape, with: .color(colour.opacity(alpha))) }
        }
    }
}

/// Red level bars beside the notch while music plays.
struct MusicBars: View {
    var playing = true
    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 20, paused: !playing)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            Canvas { g, size in
                let n = 6
                let bw = size.width / CGFloat(n * 2 - 1)
                for i in 0..<n {
                    let v = playing ? 0.35 + 0.65 * abs(sin(t * (3.1 + Double(i) * 0.7) + Double(i) * 1.3)) : 0.25
                    let bh = max(2, size.height * CGFloat(v))
                    let r = CGRect(x: CGFloat(i) * bw * 2, y: (size.height - bh) / 2, width: bw, height: bh)
                    g.fill(Path(roundedRect: r, cornerRadius: bw / 2), with: .color(EyeInk.music))
                }
            }
        }
        .accessibilityHidden(true)
    }
}

/// The album cover, small, for the notch wing (a red tile when there is none).
struct MiniArt: View {
    @ObservedObject var player: NowPlaying
    var size: CGFloat = 16
    var body: some View {
        Group {
            if let art = player.artwork {
                Image(nsImage: art).resizable().aspectRatio(contentMode: .fill)
            } else {
                ZStack {
                    LinearGradient(colors: [Color(hex: "#C8323F"), Color(hex: "#76202C")], startPoint: .topLeading, endPoint: .bottomTrailing)
                    Circle().fill(Color.white.opacity(0.75)).frame(width: size * 0.32).offset(x: size * 0.16, y: -size * 0.12)
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.26, style: .continuous))
    }
}
