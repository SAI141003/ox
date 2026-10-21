import AppKit
import SwiftUI

// The living ox: Blender-rendered motion cycles (desktop/island/art/bull_render.py
// -> Resources/ox/<cycle>/<cycle>_NNNN.png and Resources/farmer/<cycle>/...)
// played at 24 fps. Work moods pick the cycle directly; with nothing to do the
// bull lives on its pasture (art/CHARACTERS.md): it grazes, wanders, looks
// around, gets the zoomies, and now and then a farmer walks by and waves.

enum OxCycle: String, CaseIterable {
    case walk, graze, alert, idle, look, gallop, kick, doze, happy, think, worried, dizzy

    /// The cycle a work mood demands, or nil when the pasture decides
    /// (art/ox_cute_render.py renders each with its face: focused while it
    /// works, eyes up while it thinks, a hop when it needs you, closed smiling
    /// eyes when it is done, x-eyes when something failed).
    static func forMood(_ m: Mood) -> OxCycle? {
        switch m {
        case .working: return OxFrames.has(.gallop) ? .gallop : .walk
        case .thinking: return OxFrames.has(.think) ? .think : .walk
        case .needsYou: return .alert
        case .error: return OxFrames.has(.dizzy) ? .dizzy : .alert
        case .done: return OxFrames.has(.happy) ? .happy : .graze
        case .idle, .sleeping: return nil
        }
    }
}

enum Frames {
    /// Decoded once per folder; empty when that render is not bundled.
    private static var cache: [String: [NSImage]] = [:]
    private static var single: [String: NSImage] = [:]

    /// One bundled PNG ("barn/open"), decoded once.
    static func loadOne(_ name: String) -> NSImage? {
        if let i = single[name] { return i }
        guard let url = Bundle.module.url(forResource: name, withExtension: "png", subdirectory: "Resources"),
              let img = NSImage(contentsOf: url) else { return nil }
        single[name] = img
        return img
    }

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
    /// Whether this bundle has that cycle's own frames (older bundles fall back).
    static func has(_ c: OxCycle) -> Bool { !Frames.load("ox/\(c.rawValue)").isEmpty }
}

/// The pasture routine: a small state machine advanced by the frame clock.
/// Positions are in points along the lane (0 = left edge of the bull's box).
/// One pasture is shared by the notch and the expanded island, so a bull you
/// poke in the notch is the same bull you then see react up close.
final class Pasture {
    static let shared = Pasture()

    enum Act { case graze, wander, look, stand, zoomies, kick, doze, goHome }

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
    static var dozeAfter: Double = 90

    /// Dev aid (--render-story): run the pasture on a simulated clock.
    func resetClock(_ t: Double) { lastTouch = t; last = nil; nextVisit = t + 10_000 }

    var dozing: Bool { act == .doze }

    // The barn exists only around sleep (art/CHARACTERS.md storyboard): it rises
    // when the bull heads home, its door closes and the lantern glows while it
    // sleeps, and when the bull leaves (poke or a run) the door opens, the bull
    // comes out and the barn sinks away.
    private(set) var barnShownAt: Double?
    private(set) var barnLeaveAt: Double?
    private(set) var dozeStart: Double = 0

    /// What to draw for the barn now: scale (0...1, springing up or sinking),
    /// which render ("open", "closed", "closed_lit"), and a dust puff (0...1).
    func barnState(now t: Double) -> (scale: CGFloat, image: String, dust: Double)? {
        if let leave = barnLeaveAt {
            let e = t - leave
            if e < 1.3 { return (1, "open", 0) }
            if e < 1.8 { return (CGFloat(1 - (e - 1.3) / 0.5), "open", (e - 1.3) / 0.5) }
            return nil
        }
        guard let shown = barnShownAt else { return nil }
        let e = t - shown
        // Springs up out of the ground with a little overshoot.
        let p = min(1, e / 0.5)
        let scale = CGFloat(p >= 1 ? 1 : 1 + 0.12 * sin(p * .pi) - pow(1 - p, 3))
        let image = act == .doze ? (t - dozeStart < 3.5 ? "closed_lit" : "closed") : "open"
        return (max(0, scale), image, e < 0.7 ? e / 0.7 : 0)
    }

    private func leaveHome(_ t: Double) {
        if barnShownAt != nil, barnLeaveAt == nil { barnLeaveAt = t }
    }
    /// Asleep in its home (the barn; the notch in the compact view): not drawn.
    var home: Bool { act == .doze }

    // 360° turns: the way the bull is DRAWN facing lags `right` while it turns
    // through the 16 turntable views (art/bull_render.py turn).
    private(set) var facingRight = true
    private var turnStart: Double?
    private var turnToRight = true
    static let turnSeconds = 0.55
    /// Facing you (turntable view 5 of 16) until this time: hover and the farmer.
    private(set) var faceCameraUntil: Double = 0

    /// The turntable frame to show now, or nil when not turning or facing you.
    /// Index 0 faces right, 4 faces the camera, 8 faces left, 12 faces away.
    func turnIndex(now t: Double) -> Int? {
        if let s = turnStart {
            let p = min(1, (t - s) / Self.turnSeconds)
            // Right -> left turns through the camera (0...8); left -> right
            // continues round the back (8...16), so it is a full 360° loop.
            let from = turnToRight ? 8.0 : 0.0
            return Int((from + 8 * p).rounded()) % 16
        }
        if t < faceCameraUntil { return 4 }
        return nil
    }

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
    /// The cursor to follow (lane coordinates), and a click to walk to and press.
    private var followX: CGFloat?
    private var pressX: CGFloat?

    func follow(_ x: CGFloat?) { followX = x }
    func press(_ x: CGFloat) { pressX = x }

    init() { nextVisit = Date().timeIntervalSinceReferenceDate + Double.random(in: 40...80) }

    var cycle: OxCycle {
        if act == .goHome { return .walk }
        switch act {
        case .graze: return .graze
        case .wander, .goHome: return .walk
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
        if act == .doze || act == .goHome {
            leaveHome(t)
            // Woken up: it bursts out of the doorway (visible at once), kicks,
            // shouts, grumbles, then walks off into the pasture.
            act = .stand
            run([Beat(cycle: .kick, seconds: 1.0, bubble: ("MOO!!", .angry)),
                 Beat(cycle: .alert, seconds: 1.0, bubble: nil),
                 Beat(cycle: .idle, seconds: 1.6, bubble: ("zzz… rude", .sleepy))], t, then: .wander)
        } else if OxFrames.has(.doze), pokes.count < 3 {
            // A blink first (page-mascot): eyes shut for a moment, then the reaction.
            run([Beat(cycle: .doze, seconds: 0.18, bubble: nil),
                 Beat(cycle: .kick, seconds: 1.0, bubble: ("Moo?", .plain))], t, then: .look)
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
        if script.isEmpty, beatCycle == nil, act != .doze, act != .goHome, act != .zoomies {
            if act == .wander { act = .stand }
            act = .look
            until = t + 3
            faceCameraUntil = t + 1.6   // turns to look straight at you
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

    func step(now t: Double, lane: CGFloat, height: CGFloat, farmerWidth: CGFloat, allowVisitors: Bool, allowDoze: Bool = false, homeWidth: CGFloat = 0) {
        // Wandering stays clear of the home (the barn); going home walks to `lane`.
        let roam = max(0, lane - homeWidth)
        let dt = min(0.1, max(0, t - (last ?? t)))
        last = t
        if x < 0 { x = lane / 2 }
        x = min(max(0, x), lane)
        let pace = max(14, height * 0.75)
        if let b = bubble, t >= b.until { bubble = nil }
        if let leave = barnLeaveAt, t - leave > 1.8 { barnLeaveAt = nil; barnShownAt = nil }

        // A direction change plays the 360° turn; the bull holds still meanwhile.
        if let s = turnStart {
            if t - s >= Self.turnSeconds { turnStart = nil; facingRight = turnToRight } else { return }
        }
        if right != facingRight, act != .doze {
            turnStart = t
            turnToRight = right
            return
        }

        // On the island's floor: a click brings the bull at a gallop to press it,
        // and otherwise it walks along under the cursor.
        if beatCycle == nil, act != .doze, act != .goHome {
            if let px = pressX.map({ min(max(0, $0), lane) }) {
                lastTouch = t
                let d = px - x
                let sp = pace * 3.4
                right = d >= 0
                if abs(d) <= sp * dt {
                    x = px
                    pressX = nil
                    act = .stand
                    run([Beat(cycle: .kick, seconds: 0.7, bubble: ("click!", .plain))], t, then: .look)
                } else {
                    act = .zoomies
                    x += (d > 0 ? 1 : -1) * sp * dt
                }
                return
            }
            if let fx = followX.map({ min(max(0, $0), lane) }) {
                lastTouch = t
                let d = fx - x
                if abs(d) > 12 {
                    right = d >= 0
                    act = .wander
                    target = fx
                    x += (d > 0 ? 1 : -1) * min(abs(d), pace * 2.2 * dt)
                } else if act == .wander || act == .zoomies {
                    act = .look
                    until = t + 3
                    faceCameraUntil = t + 1.2
                }
                return
            }
        }

        // A reaction in progress holds the bull in place until its beats end.
        if beatCycle != nil {
            if t >= beatUntil { nextBeat(t) }
            if beatCycle == nil, let then = afterScript {
                afterScript = nil
                act = then
                switch then {
                case .zoomies:
                    if roam > 30 { target = x < roam / 2 ? roam : 0 } else { act = .stand; until = t + 2 }
                case .wander:
                    target = roam * CGFloat.random(in: 0.3...0.6)
                default:
                    until = t + Double.random(in: 2...4)
                }
            }
            return
        }

        // Nobody around and nothing running: walk home (the far end of the lane,
        // the barn or the notch) and sleep in there.
        if allowDoze, act != .doze, act != .goHome, visitor == nil, t - lastTouch > Self.dozeAfter {
            act = .goHome
            barnShownAt = t
            barnLeaveAt = nil
        }
        if act == .goHome {
            if !allowDoze { act = .stand; until = t + 2; lastTouch = t; leaveHome(t); return }
            let d = lane - x
            right = true
            if d <= pace * dt { x = lane; act = .doze; dozeStart = t } else { x += pace * 0.8 * dt }
            return
        }
        if act == .doze {
            // A run starting brings it out of the barn at a trot.
            // A run starting: the door opens, the bull trots out, the barn sinks.
            if !allowDoze { act = .wander; target = lane * 0.4; lastTouch = t; leaveHome(t) }
            return
        }

        switch act {
        case .wander, .zoomies:
            let speed = act == .zoomies ? pace * 3.2 : pace
            let d = target - x
            right = d >= 0
            if abs(d) <= speed * dt { x = target; pick(t, lane: roam) } else { x += (d > 0 ? 1 : -1) * speed * dt }
        default:
            if t >= until && visitor == nil { pick(t, lane: roam) }
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
                    faceCameraUntil = 0
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
    /// The compact notch needs a silhouette that reads in a few pixels. The
    /// original vector ox keeps its facial states crisp there; the detailed
    /// 3D pasture still appears in the opened island.
    var vectorStyle = false
    /// Use the whole width: walk the lane while working, live on the pasture otherwise.
    var roam = false
    /// Past 80 % of a plan window: worried instead of on alert, when rendered.
    var stressed = false
    /// Called when the bull is poked (the notch uses it to open the island).
    var onPoke: (() -> Void)? = nil
    /// Draw the barn at the right end (the expanded island). Without it, the
    /// far end of the lane is home: in the notch, the camera housing.
    var barn = false
    /// Walk under the cursor and answer clicks: the island's floor. `origin` is
    /// this view's left edge in panel coordinates.
    var follow = false
    var origin: CGFloat = 0
    /// Turn to face the cursor while it moves over the island (Coucou's character
    /// follows the cursor), in every mood: the opened island's ox, standing in place.
    var facesPointer = false
    @State private var start = Date()
    @State private var seenClick: Double = 0
    private var pasture: Pasture { .shared }

    var body: some View {
        if vectorStyle {
            OxMascot(mood: mood, size: height)
                .frame(width: height, height: height)
                .contentShape(Rectangle())
                .onTapGesture { onPoke?() }
        } else if OxFrames.available {
            GeometryReader { geo in
                // 12 frames a second (the session sprites' beat, so one layout pass serves
                // both) while something happens; 10 (6 on battery) while ox only grazes or sleeps.
                TimelineView(.animation(minimumInterval: Energy.interval(12, active: ![Mood.idle, .sleeping].contains(mood)))) { ctx in
                    scene(t: ctx.date.timeIntervalSince(start), now: ctx.date.timeIntervalSinceReferenceDate, size: geo.size, left: geo.frame(in: .global).minX)
                }
            }
            .frame(height: height)
            .accessibilityLabel(Text(OxPainter.describe(mood)))
        } else {
            OxSprite(mood: mood, size: height)
        }
    }

    /// Feed the cursor and any new click to the pasture (floor mode only).
    private func trackPointer(now: Double, width: CGFloat, size: CGSize) -> Bool {
        guard follow else { return false }
        let p = Pointer.shared
        let inside = p.local.y >= 0 && p.local.y <= IslandLayout.panel.height && p.local.x >= origin - width && p.local.x <= origin + size.width + width
        let moving = now - p.movedAt < 2.5
        pasture.follow(inside && moving ? p.local.x - origin - width / 2 : nil)
        if let c = p.lastClick, c.at > seenClick, now - c.at < 1 {
            DispatchQueue.main.async { seenClick = c.at }
            pasture.press(c.point.x - origin - width / 2)
        }
        return true
    }

    @ViewBuilder
    private func scene(t: Double, now: Double, size: CGSize, left: CGFloat = 0) -> some View {
        let width = height * 4 / 3
        let lane = max(0, size.width - width)
        let farmerH = height * 0.62
        let farmerW = farmerH * 18 / 26
        let barnW = barn ? height * 1.15 : 0
        let _ = trackPointer(now: now, width: width, size: size)
        // Following the cursor wins over a run's forced walk: you are right there.
        let forced = follow ? nil : (stressed && mood == .needsYou && OxFrames.has(.worried) ? .worried : OxCycle.forMood(mood))
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
                pasture.step(now: now, lane: lane, height: height, farmerWidth: farmerW, allowVisitors: true,
                             allowDoze: mood == .sleeping, homeWidth: barnW * 0.9)
                return (pasture.cycle, pasture.x, pasture.facingRight)
            }
            return (.graze, lane / 2, true)
        }()
        // Turning (or facing you) plays the 360° turntable instead of the cycle.
        let turn = forced == nil && roam ? pasture.turnIndex(now: now) : nil
        let turnFrames = Frames.load("ox/turn")
        let frames = turn != nil && turnFrames.count == 16 ? turnFrames : OxFrames.frames(cycle)
        let idx = frames.isEmpty ? 0 : (turn != nil && turnFrames.count == 16 ? turn! : Int(t * 24) % frames.count)
        // Facing the cursor: which side of the ox it is on, while it is moving over the island.
        let p = Pointer.shared
        let faceRight: Bool? = facesPointer && now - p.movedAt < 4 && p.local.y <= IslandLayout.panel.height
            ? p.local.x > left + x + width / 2 : nil
        let flip = turn == nil && !(faceRight ?? right)
        let hidden = forced == nil && roam && pasture.home

        ZStack(alignment: .bottomLeading) {
            if cycle == .graze { Grass(width: width * 0.5, height: height * 0.16, t: t).offset(x: x + (right ? width * 0.55 : width * -0.05), y: 0) }
            Ellipse()
                .fill(RadialGradient(colors: [.black.opacity(0.45), .clear], center: .center, startRadius: 0, endRadius: width * 0.4))
                .frame(width: width * 0.8, height: height * 0.12)
                .offset(x: x + width * 0.1, y: -height * 0.02)
            if !frames.isEmpty, !hidden {
                Image(nsImage: frames[idx])
                    .resizable()
                    .interpolation(.high)
                    .frame(width: width, height: height)
                    .scaleEffect(x: flip ? -1 : 1, y: 1)
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
            if barn, roam, let b = pasture.barnState(now: now) {
                // Only around sleep: rises, the bull walks in (drawn on top of
                // it), the door closes; a poke or a run opens it and it sinks.
                BarnSprite(image: b.image, scale: b.scale, dust: b.dust)
                    .frame(width: barnW, height: barnW * 0.9)
                    .offset(x: size.width - barnW, y: height * 0.04)
                    .onTapGesture {
                        if hidden { pasture.poke(now: Date().timeIntervalSinceReferenceDate, mood: mood) }
                    }
                    .help(hidden ? "the bull is asleep in its barn (poke to wake it)" : "the barn")
            }
            if hidden {
                // Asleep at home: "z" drifting from the hay loft, or from the notch's edge.
                Snore(t: t, size: height * 0.22)
                    .offset(x: barn ? size.width - barnW * 0.45 : max(0, size.width - width - 4), y: -height * (barn ? 0.72 : 0.4))
            } else if cycle == .doze {
                Snore(t: t, size: height * 0.22).offset(x: x + width * (right ? 0.78 : 0.06), y: -height * 0.62)
            }
            if let b = pasture.bubble, now < b.until {
                SpeechBubble(bubble: b, size: max(8.5, height * 0.15))
                    .fixedSize()
                    .offset(x: min(x + width * (right ? 0.5 : 0.1), max(0, size.width - height * 1.35)), y: -height * 0.8)
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

/// The barn, rendered in Blender like the bull (art/barn_render.py): open,
/// closed, or closed with the lantern lit. Grows from the ground and sinks
/// back into it, with a dust puff at its feet.
struct BarnSprite: View {
    let image: String
    let scale: CGFloat
    let dust: Double

    var body: some View {
        ZStack(alignment: .bottom) {
            if let img = Frames.loadOne("barn/\(image)") {
                Image(nsImage: img).resizable().interpolation(.high)
                    .scaleEffect(x: 1, y: max(0.001, scale), anchor: .bottom)
                    .opacity(Double(min(1, scale * 3)))
            }
            if dust > 0 && dust < 1 {
                // A dust puff where it meets the ground.
                ForEach(0..<5, id: \.self) { i in
                    Circle().fill(Color(hex: "#B8A58A").opacity(0.55 * (1 - dust)))
                        .frame(width: 10 + 18 * dust, height: 10 + 18 * dust)
                        .offset(x: CGFloat(i - 2) * (8 + 14 * dust), y: -4 - 4 * dust)
                }
            }
        }
        .allowsHitTesting(scale > 0.5)
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
