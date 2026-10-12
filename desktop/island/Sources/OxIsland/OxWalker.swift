import AppKit
import SwiftUI

// The living ox: Blender-rendered motion cycles (desktop/island/art/bull_render.py
// -> Resources/ox/<cycle>/<cycle>_NNNN.png and Resources/farmer/<cycle>/...)
// played at 24 fps. Work moods pick the cycle directly; with nothing to do the
// bull lives on its pasture (art/CHARACTERS.md): it grazes, wanders, looks
// around, gets the zoomies, and now and then a farmer walks by and waves.

enum OxCycle: String, CaseIterable {
    case walk, graze, alert, idle, look, gallop, kick, doze

    /// The cycle a work mood demands, or nil when the pasture decides.
    static func forMood(_ m: Mood) -> OxCycle? {
        switch m {
        case .working, .thinking: return .walk
        case .needsYou, .error: return .alert
        case .done: return .graze
        case .idle, .sleeping: return nil
        }
    }
}

enum Frames {
    /// Decoded once per folder; empty when that render is not bundled.
    private static var cache: [String: [NSImage]] = [:]

    static func load(_ sub: String) -> [NSImage] {
        if let f = cache[sub] { return f }
        var out: [NSImage] = []
        if let dir = Bundle.module.url(forResource: sub, withExtension: nil, subdirectory: "Resources") {
            let files = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).filter { $0.hasSuffix(".png") }.sorted()
            out = files.compactMap { NSImage(contentsOf: dir.appendingPathComponent($0)) }
        }
        cache[sub] = out
        return out
    }
}

enum OxFrames {
    static func frames(_ c: OxCycle) -> [NSImage] {
        let f = Frames.load("ox/\(c.rawValue)")
        // Older bundles lack the pasture cycles: fall back to what exists.
        if f.isEmpty, c != .walk, c != .graze { return Frames.load(c == .gallop ? "ox/walk" : c == .doze ? "ox/idle" : "ox/graze") }
        return f
    }
    static var available: Bool { !frames(.walk).isEmpty }
}

/// The pasture routine: a small state machine advanced by the frame clock.
/// Positions are in points along the lane (0 = left edge of the bull's box).
/// One pasture is shared by the notch and the expanded island, so a bull you
/// poke in the notch is the same bull you then see react up close.
final class Pasture {
    static let shared = Pasture()

    enum Act { case graze, wander, look, stand, zoomies, kick, doze }

    /// A speech bubble over the bull (art/CHARACTERS.md, "Touch reactions").
    struct Bubble { enum Tone { case plain, angry, sleepy, busy }; let text: String; let tone: Tone; let until: Double }

    /// One beat of a reaction: show `cycle` for `seconds`, optionally with a bubble.
    private struct Beat { let cycle: OxCycle; let seconds: Double; let bubble: (String, Bubble.Tone)? }

    private(set) var bubble: Bubble?
    private var script: [Beat] = []
    private var beatUntil: Double = 0
    private var beatCycle: OxCycle?
    private var afterScript: Act?
    private var pokes: [Double] = []
    private var lastTouch = Date().timeIntervalSinceReferenceDate
    /// No runs and nobody around for this long: the bull lies down for a doze.
    static let dozeAfter: Double = 90

    var dozing: Bool { act == .doze }

    struct Visitor {
        enum Step { case walkIn, wave, walkOut }
        var step: Step
        var x: CGFloat
        var right: Bool
        var until: Double
    }

    private(set) var act: Act = .graze
    private(set) var x: CGFloat = -1
    private(set) var right = true
    private(set) var visitor: Visitor?
    private var target: CGFloat = 0
    private var until: Double = 0
    private var last: Double?
    private var nextVisit: Double

    init() { nextVisit = Date().timeIntervalSinceReferenceDate + Double.random(in: 40...80) }

    var cycle: OxCycle {
        if let beatCycle { return beatCycle }
        switch act {
        case .graze: return .graze
        case .wander: return .walk
        case .look: return .look
        case .stand: return .idle
        case .zoomies: return .gallop
        case .kick: return .kick
        case .doze: return .doze
        }
    }

    // MARK: touch reactions

    /// A click on the bull. `working` is the run's mood when one forces a cycle.
    func poke(now t: Double, mood: Mood) {
        lastTouch = t
        pokes = pokes.filter { t - $0 < 2 } + [t]
        switch mood {
        case .working, .thinking:
            say("busy!", .busy, t, 1.6)
            return
        case .needsYou:
            say("↓ needs you", .busy, t, 2.0)
            return
        case .error:
            say("ouch…", .plain, t, 1.6)
            return
        default:
            break
        }
        if act == .doze {
            // Woken up: a jolt, a kick, a shout, then a grumble back to grazing.
            run([Beat(cycle: .kick, seconds: 1.0, bubble: ("MOO!!", .angry)),
                 Beat(cycle: .alert, seconds: 1.0, bubble: nil),
                 Beat(cycle: .idle, seconds: 1.6, bubble: ("zzz… rude", .sleepy))], t, then: .graze)
        } else if pokes.count >= 3 {
            pokes = []
            run([Beat(cycle: .alert, seconds: 1.0, bubble: ("MOO! 💢", .angry)),
                 Beat(cycle: .alert, seconds: 0.8, bubble: nil)], t, then: .zoomies)
        } else {
            run([Beat(cycle: .kick, seconds: 1.0, bubble: ("Moo?", .plain))], t, then: .look)
        }
    }

    /// The cursor over the bull: it lifts its head and looks round at you.
    func hover(_ on: Bool, now t: Double) {
        guard on else { return }
        lastTouch = t
        if script.isEmpty, beatCycle == nil, act == .graze || act == .stand {
            act = .look
            until = t + 3
        }
    }

    private func say(_ text: String, _ tone: Bubble.Tone, _ t: Double, _ seconds: Double) {
        bubble = Bubble(text: text, tone: tone, until: t + seconds)
    }

    private func run(_ beats: [Beat], _ t: Double, then: Act) {
        script = beats
        afterScript = then
        nextBeat(t)
    }

    private func nextBeat(_ t: Double) {
        guard !script.isEmpty else { beatCycle = nil; return }
        let b = script.removeFirst()
        beatCycle = b.cycle
        beatUntil = t + b.seconds
        if let (text, tone) = b.bubble { say(text, tone, t, b.seconds + 0.4) }
    }

    func step(now t: Double, lane: CGFloat, height: CGFloat, farmerWidth: CGFloat, allowVisitors: Bool, allowDoze: Bool = false) {
        let dt = min(0.1, max(0, t - (last ?? t)))
        last = t
        if x < 0 { x = lane / 2 }
        x = min(max(0, x), lane)
        let pace = max(14, height * 0.75)
        if let b = bubble, t >= b.until { bubble = nil }

        // A reaction in progress holds the bull in place until its beats end.
        if beatCycle != nil {
            if t >= beatUntil { nextBeat(t) }
            if beatCycle == nil, let then = afterScript {
                afterScript = nil
                act = then
                switch then {
                case .zoomies:
                    if lane > 30 { target = x < lane / 2 ? lane : 0 } else { act = .stand; until = t + 2 }
                default:
                    until = t + Double.random(in: 2...4)
                }
            }
            return
        }

        // Nobody around and nothing running: lie down for a doze.
        if allowDoze, act != .doze, visitor == nil, t - lastTouch > Self.dozeAfter {
            act = .doze
            return
        }
        if act == .doze {
            if !allowDoze { act = .stand; until = t + 2; lastTouch = t }
            return
        }

        switch act {
        case .wander, .zoomies:
            let speed = act == .zoomies ? pace * 3.2 : pace
            let d = target - x
            right = d >= 0
            if abs(d) <= speed * dt { x = target; pick(t, lane: lane) } else { x += (d > 0 ? 1 : -1) * speed * dt }
        default:
            if t >= until && visitor == nil { pick(t, lane: lane) }
        }

        // The farmer: in from the far side, a wave, then off the other edge.
        if visitor == nil, allowVisitors, t >= nextVisit, act != .zoomies, lane > farmerWidth * 2 {
            let fromLeft = x > lane / 2
            visitor = Visitor(step: .walkIn, x: fromLeft ? -farmerWidth : lane + height * 1.4, right: fromLeft, until: 0)
        }
        if var v = visitor {
            let speed = max(12, height * 0.55)
            switch v.step {
            case .walkIn:
                let stop = v.right ? x - farmerWidth * 1.1 : x + height * 1.45
                if (v.right && v.x >= stop) || (!v.right && v.x <= stop) {
                    v.step = .wave
                    v.until = t + 2.8
                    act = .look            // the bull turns to look at them
                    right = !v.right
                    until = t + 3.4
                } else {
                    v.x += (v.right ? 1 : -1) * speed * dt
                }
            case .wave:
                if t >= v.until { v.step = .walkOut }
            case .walkOut:
                v.x += (v.right ? 1 : -1) * speed * dt
                if v.x < -farmerWidth * 1.5 || v.x > lane + height * 2 {
                    visitor = nil
                    nextVisit = t + Double.random(in: 90...150)
                    return
                }
            }
            visitor = v
        }
    }

    private func pick(_ t: Double, lane: CGFloat) {
        let r = Double.random(in: 0..<1)
        switch r {
        case ..<0.35: act = .graze; until = t + Double.random(in: 6...10)
        case ..<0.60:
            // No room to walk (the compact notch): look around in place instead.
            guard lane >= 8 else { act = .look; until = t + Double.random(in: 4...6); return }
            act = .wander
            target = CGFloat.random(in: 0...lane)
            if abs(target - x) < lane * 0.15 { target = x < lane / 2 ? lane * 0.85 : lane * 0.15 }
        case ..<0.75: act = .look; until = t + Double.random(in: 4...6)
        case ..<0.90: act = .stand; until = t + Double.random(in: 3...5)
        case ..<0.96:
            act = lane > 30 ? .zoomies : .stand
            target = x < lane / 2 ? lane : 0
            until = t + 4
        default: act = .kick; until = t + 1.0
        }
    }
}

struct OxWalker: View {
    var mood: Mood
    /// Height of the ox in points; the frames are 4:3.
    var height: CGFloat
    /// Use the whole width: walk the lane while working, live on the pasture otherwise.
    var roam = false
    /// Called when the bull is poked (the notch uses it to open the island).
    var onPoke: (() -> Void)? = nil
    @State private var start = Date()
    private var pasture: Pasture { .shared }

    var body: some View {
        if OxFrames.available {
            GeometryReader { geo in
                TimelineView(.animation(minimumInterval: 1.0 / 24.0)) { ctx in
                    scene(t: ctx.date.timeIntervalSince(start), now: ctx.date.timeIntervalSinceReferenceDate, size: geo.size)
                }
            }
            .frame(height: height)
            .accessibilityLabel(Text(OxPainter.describe(mood)))
        } else {
            OxSprite(mood: mood, size: height)
        }
    }

    @ViewBuilder
    private func scene(t: Double, now: Double, size: CGSize) -> some View {
        let width = height * 4 / 3
        let lane = max(0, size.width - width)
        let farmerH = height * 0.62
        let farmerW = farmerH * 18 / 26
        let forced = OxCycle.forMood(mood)
        let (cycle, x, right): (OxCycle, CGFloat, Bool) = {
            if let forced {
                // Work: walk the lane ping-pong; other moods stand where the pasture left it.
                let walking = roam && forced == .walk && lane > 4
                guard walking else { return (forced, roam ? pasture.currentX(lane) : lane / 2, true) }
                let speed = max(18, height * 0.9)
                let period = Double(lane / speed)
                let leg = t.truncatingRemainder(dividingBy: 2 * period)
                let goingRight = leg < period
                return (.walk, CGFloat(goingRight ? leg / period : 2 - leg / period) * lane, goingRight)
            }
            if roam {
                pasture.step(now: now, lane: lane, height: height, farmerWidth: farmerW, allowVisitors: true, allowDoze: mood == .sleeping)
                return (pasture.cycle, pasture.x, pasture.right)
            }
            return (.graze, lane / 2, true)
        }()
        let frames = OxFrames.frames(cycle)
        let idx = frames.isEmpty ? 0 : Int(t * 24) % frames.count

        ZStack(alignment: .bottomLeading) {
            if cycle == .graze { Grass(width: width * 0.5, height: height * 0.16, t: t).offset(x: x + (right ? width * 0.55 : width * -0.05), y: 0) }
            Ellipse()
                .fill(RadialGradient(colors: [.black.opacity(0.45), .clear], center: .center, startRadius: 0, endRadius: width * 0.4))
                .frame(width: width * 0.8, height: height * 0.12)
                .offset(x: x + width * 0.1, y: -height * 0.02)
            if !frames.isEmpty {
                Image(nsImage: frames[idx])
                    .resizable()
                    .interpolation(.high)
                    .frame(width: width, height: height)
                    .scaleEffect(x: right ? 1 : -1, y: 1)
                    // A soft warm rim so the graphite hide reads on the black notch.
                    .shadow(color: Color(hex: "#E9C27B").opacity(0.35), radius: 1.2)
                    .shadow(color: .white.opacity(0.18), radius: 3)
                    // Poke it, hover it: art/CHARACTERS.md "Touch reactions".
                    .contentShape(Rectangle())
                    .onTapGesture {
                        pasture.poke(now: Date().timeIntervalSinceReferenceDate, mood: mood)
                        onPoke?()
                    }
                    .onHover { pasture.hover($0, now: Date().timeIntervalSinceReferenceDate) }
                    .offset(x: x)
            }
            if cycle == .doze { Snore(t: t, size: height * 0.22).offset(x: x + width * (right ? 0.78 : 0.06), y: -height * 0.62) }
            if let b = pasture.bubble, now < b.until {
                SpeechBubble(bubble: b, size: max(8.5, height * 0.15))
                    .fixedSize()
                    .offset(x: x + width * (right ? 0.5 : 0.1), y: -height * 0.8)
                    .transition(.scale.combined(with: .opacity))
            }
            if forced == nil, roam, let v = pasture.visitor {
                Farmer(step: v.step, right: v.right, t: t, height: farmerH)
                    .offset(x: v.x)
            }
        }
        .frame(width: size.width, height: size.height, alignment: .bottomLeading)
    }
}

extension Pasture {
    func currentX(_ lane: CGFloat) -> CGFloat { x < 0 ? lane / 2 : min(x, lane) }
}

/// The visiting farmer, from the pixel cast: walks in side-on, then turns to
/// face you and waves.
struct Farmer: View {
    let step: Pasture.Visitor.Step
    let right: Bool
    let t: Double
    let height: CGFloat

    var body: some View {
        let pose = step == .wave
            ? PixelPose(dir: .front, pose: "wave", frame: Int(t * 5) % 2, mouth: "smile")
            : PixelPose(dir: .side, pose: "walk", frame: Int(t * 8) % 4)
        ZStack(alignment: .bottom) {
            Ellipse().fill(RadialGradient(colors: [.black.opacity(0.4), .clear], center: .center, startRadius: 0, endRadius: height * 0.25))
                .frame(width: height * 0.5, height: height * 0.07)
            PixelPersonView(person: "farmer", pose: pose, flip: step != .wave && !right, height: height)
        }
    }
}

/// A small speech bubble: plain, angry (red), sleepy (dim) or busy (amber).
struct SpeechBubble: View {
    let bubble: Pasture.Bubble
    let size: CGFloat

    var body: some View {
        let (bg, fg): (Color, Color) = {
            switch bubble.tone {
            case .plain: return (.white, .black)
            case .angry: return (Ink.red, .white)
            case .sleepy: return (Color.white.opacity(0.8), Color.black.opacity(0.7))
            case .busy: return (Ink.amber, .black)
            }
        }()
        Text(bubble.text)
            .font(.system(size: size, weight: .heavy, design: .rounded))
            .foregroundStyle(fg)
            .padding(.horizontal, size * 0.55).padding(.vertical, size * 0.25)
            .background(Capsule().fill(bg))
            .rotationEffect(.degrees(bubble.tone == .angry ? -4 : 0))
            .accessibilityLabel("The bull says \(bubble.text)")
    }
}

/// "z z z" drifting up while the bull dozes.
struct Snore: View {
    let t: Double
    let size: CGFloat

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            ForEach(0..<3, id: \.self) { i in
                let phase = (t * 0.45 + Double(i) / 3).truncatingRemainder(dividingBy: 1)
                Text("z")
                    .font(.system(size: size * (0.6 + 0.4 * phase), weight: .heavy, design: .rounded))
                    .foregroundStyle(Color.white.opacity(0.9 * (1 - phase)))
                    .offset(x: size * 0.6 * phase, y: -size * 2.2 * phase)
            }
        }
        .frame(width: size * 2, height: size * 2.4, alignment: .bottomLeading)
        .allowsHitTesting(false)
    }
}

/// A few blades of grass that sway; drawn where the bull grazes.
struct Grass: View {
    let width: CGFloat
    let height: CGFloat
    let t: Double

    var body: some View {
        Canvas { ctx, size in
            let blades = 9
            for i in 0..<blades {
                let fx = (CGFloat(i) + 0.5) / CGFloat(blades)
                let h = size.height * (0.55 + 0.45 * CGFloat((i * 7919) % 5) / 4)
                let sway = CGFloat(sin(t * 1.8 + Double(i) * 0.9)) * size.width * 0.03
                var p = Path()
                let base = CGPoint(x: fx * size.width, y: size.height)
                p.move(to: CGPoint(x: base.x - 1.4, y: base.y))
                p.addQuadCurve(to: CGPoint(x: base.x + sway, y: size.height - h), control: CGPoint(x: base.x - 1, y: size.height - h * 0.5))
                p.addQuadCurve(to: CGPoint(x: base.x + 1.4, y: base.y), control: CGPoint(x: base.x + 1, y: size.height - h * 0.5))
                let g = i % 3 == 0 ? Color(hex: "#7FB069") : i % 3 == 1 ? Color(hex: "#5E8C4A") : Color(hex: "#9CC57A")
                ctx.fill(p, with: .color(g.opacity(0.9)))
            }
        }
        .frame(width: width, height: height)
    }
}
