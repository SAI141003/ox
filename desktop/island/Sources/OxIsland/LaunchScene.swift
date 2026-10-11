import AppKit
import SwiftUI

// The launch: an ox charges in from the left, hits a pane of glass at centre
// stage, the glass shatters, and the ox stands where it was with the wordmark
// beside it. One brand moment (~1.7 s), drawn procedurally, never blocks input,
// and collapses to a static frame under Reduce Motion.

struct LaunchScene {
    static let duration: Double = 1.75
    static let impactAt: Double = 0.70

    struct Shard {
        var points: [CGPoint]   // triangle in local coords
        var origin: CGPoint
        var velocity: CGVector
        var spin: Double
        var delay: Double
    }

    let shards: [Shard]
    let cracks: [[CGPoint]]

    /// Deterministic (seeded) so every launch, and every rendered review frame, matches.
    init(size: CGSize, seed: UInt64 = 0x0A_BAD_0C5) {
        var rng = SplitMix(seed: seed)
        let c = CGPoint(x: size.width * 0.5, y: size.height * 0.55)
        var shards: [Shard] = []
        for i in 0..<34 {
            let a = Double(i) / 34 * 2 * .pi + rng.next(-0.12, 0.12)
            let r = rng.next(4, 26)
            let o = CGPoint(x: c.x + cos(a) * r, y: c.y + sin(a) * r * 0.8)
            let s = rng.next(4, 13)
            let tri = (0..<3).map { k -> CGPoint in
                let t = a + Double(k) * 2.1 + rng.next(-0.5, 0.5)
                return CGPoint(x: cos(t) * s * rng.next(0.6, 1.2), y: sin(t) * s * rng.next(0.6, 1.2))
            }
            // Blown away from the hit, mostly forward (the ox's direction of travel).
            let speed = rng.next(140, 420)
            let v = CGVector(dx: cos(a) * speed + 120, dy: sin(a) * speed * 0.7 - rng.next(40, 160))
            shards.append(Shard(points: tri, origin: o, velocity: v, spin: rng.next(-9, 9), delay: rng.next(0, 0.05)))
        }
        self.shards = shards
        var cracks: [[CGPoint]] = []
        for i in 0..<9 {
            var p = c
            var a = Double(i) / 9 * 2 * .pi + rng.next(-0.2, 0.2)
            var line = [p]
            for _ in 0..<5 {
                a += rng.next(-0.45, 0.45)
                let step = rng.next(8, 22)
                p = CGPoint(x: p.x + cos(a) * step, y: p.y + sin(a) * step * 0.75)
                line.append(p)
            }
            cracks.append(line)
        }
        self.cracks = cracks
    }

    // Easing
    static func easeInCubic(_ x: Double) -> Double { x * x * x }
    static func easeOutExpo(_ x: Double) -> Double { x >= 1 ? 1 : 1 - pow(2, -10 * x) }
    static func clamp(_ x: Double) -> Double { min(1, max(0, x)) }

    func draw(_ g: inout GraphicsContext, size: CGSize, t: Double) {
        let c = CGPoint(x: size.width * 0.5, y: size.height * 0.55)
        let sinceImpact = t - Self.impactAt

        // Camera shake right after impact, decaying fast.
        if sinceImpact > 0 && sinceImpact < 0.35 {
            let k = (1 - sinceImpact / 0.35) * 3.2
            g.translateBy(x: sin(t * 90) * k, y: cos(t * 77) * k * 0.6)
        }

        // Stage
        g.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.black))

        // The glass pane, before it breaks: a faint sheet with a moving specular line.
        if sinceImpact < 0.04 {
            let pane = CGRect(x: c.x - 3, y: size.height * 0.12, width: 6, height: size.height * 0.8)
            g.fill(Path(pane), with: .linearGradient(Gradient(colors: [.white.opacity(0.03), .white.opacity(0.16), .white.opacity(0.03)]),
                                                     startPoint: CGPoint(x: pane.minX, y: pane.minY), endPoint: CGPoint(x: pane.maxX, y: pane.maxY)))
            let glint = Self.clamp(t / Self.impactAt)
            g.fill(Path(CGRect(x: pane.minX, y: pane.minY + pane.height * glint - 8, width: pane.width, height: 16)),
                   with: .color(.white.opacity(0.35 * (1 - glint))))
        }

        // Cracks flash across the pane at the moment of impact.
        if sinceImpact >= 0 && sinceImpact < 0.3 {
            let grow = Self.easeOutExpo(Self.clamp(sinceImpact / 0.12))
            let fade = 1 - Self.clamp((sinceImpact - 0.12) / 0.18)
            for line in cracks {
                var p = Path()
                let n = max(2, Int(Double(line.count) * grow))
                p.addLines(Array(line.prefix(n)))
                g.stroke(p, with: .color(.white.opacity(0.85 * fade)), lineWidth: 1.2)
            }
        }

        // Shards: ballistic, spinning, catching light, gone by ~1.35 s.
        if sinceImpact >= 0 {
            for s in shards {
                let lt = sinceImpact - s.delay
                guard lt > 0, lt < 0.65 else { continue }
                let pos = CGPoint(x: s.origin.x + s.velocity.dx * lt, y: s.origin.y + s.velocity.dy * lt + 0.5 * 520 * lt * lt)
                var sg = g
                sg.translateBy(x: pos.x, y: pos.y)
                sg.rotate(by: .radians(s.spin * lt))
                var p = Path()
                p.addLines(s.points)
                p.closeSubpath()
                let a = 1 - Self.clamp(lt / 0.65)
                sg.fill(p, with: .linearGradient(Gradient(colors: [.white.opacity(0.55 * a), Color(hex: "#9FD8FF").opacity(0.18 * a)]),
                                                 startPoint: .zero, endPoint: CGPoint(x: 10, y: 10)))
                sg.stroke(p, with: .color(.white.opacity(0.7 * a)), lineWidth: 0.6)
            }
        }

        // The ox: charge (ease-in, head down), recoil, then stand.
        let oxSize = size.height * 0.62
        var ox: CGFloat
        var tilt = 0.0
        if t < Self.impactAt {
            let k = Self.easeInCubic(Self.clamp((t - 0.15) / (Self.impactAt - 0.15)))
            ox = -oxSize + (c.x - oxSize * 0.5 + oxSize) * k
            tilt = 14 // horns lowered for the charge
        } else {
            // Recoil off the glass, then glide left so ox + wordmark end as one
            // centred lockup instead of the ox alone in the middle.
            let k = Self.easeOutExpo(Self.clamp(sinceImpact / 0.6))
            let fontSize: CGFloat = size.height * 0.36
            let groupWidth: CGFloat = oxSize + 14 + fontSize * 1.15
            let lockupX: CGFloat = c.x - groupWidth / 2
            let impactX: CGFloat = c.x - oxSize * 0.5 - 8 * CGFloat(1 - k)
            let settle = CGFloat(Self.easeOutExpo(Self.clamp((t - 0.95) / 0.6)))
            ox = impactX + (lockupX - impactX) * settle
            tilt = 14 * (1 - k)
        }
        // Dust behind a charging ox.
        if t > 0.2 && t < Self.impactAt + 0.2 {
            for i in 0..<8 {
                let back = CGFloat(i) * 9
                let x = ox - back + oxSize * 0.2
                let y = c.y + oxSize * 0.42 + sin(Double(i) + t * 30) * 2
                g.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 6, height: 4)), with: .color(Color(hex: "#BD713B").opacity(0.25 - Double(i) * 0.03)))
            }
        }
        var og = g
        og.translateBy(x: ox, y: c.y - oxSize * 0.5)
        og.translateBy(x: oxSize / 2, y: oxSize / 2)
        og.rotate(by: .degrees(tilt))
        og.translateBy(x: -oxSize / 2, y: -oxSize / 2)
        let mood: Mood = t < Self.impactAt ? .working("charge") : .idle
        OxPainter(mood: mood, t: t, look: CGVector(dx: t < Self.impactAt ? 1 : 0.2, dy: 0)).paint(&og, size: CGSize(width: oxSize, height: oxSize))

        // Impact flash.
        if sinceImpact >= 0 && sinceImpact < 0.09 {
            g.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.white.opacity(0.55 * (1 - sinceImpact / 0.09))))
        }

        // Wordmark resolves beside the standing ox.
        let wk = Self.easeOutExpo(Self.clamp((t - 1.0) / 0.6))
        if wk > 0 {
            let text = Text("ox").font(.system(size: size.height * 0.36, weight: .heavy, design: .rounded)).foregroundColor(Color(hex: "#F5F6F8").opacity(wk))
            let wordX: CGFloat = ox + oxSize + 14 + 14 * CGFloat(1 - wk)
            g.draw(text, at: CGPoint(x: wordX, y: c.y + 2), anchor: .leading)
        }
    }
}

/// Tiny deterministic PRNG (SplitMix64).
struct SplitMix {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func nextU() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
    mutating func next(_ lo: Double, _ hi: Double) -> Double {
        lo + (hi - lo) * Double(nextU() >> 11) / Double(1 << 53)
    }
}

/// Plays the scene once, then calls `done`. Reduce Motion: a single still frame.
struct LaunchView: View {
    let size: CGSize
    let done: () -> Void
    @State private var start = Date()
    private let scene: LaunchScene

    init(size: CGSize, done: @escaping () -> Void) {
        self.size = size
        self.done = done
        self.scene = LaunchScene(size: size)
    }

    var body: some View {
        let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        TimelineView(.animation(minimumInterval: 1 / 60, paused: reduce)) { ctx in
            let t = reduce ? LaunchScene.duration : ctx.date.timeIntervalSince(start)
            Canvas { g, sz in scene.draw(&g, size: sz, t: min(t, LaunchScene.duration)) }
        }
        .frame(width: size.width, height: size.height)
        .onAppear {
            start = Date()
            DispatchQueue.main.asyncAfter(deadline: .now() + (reduce ? 0.9 : LaunchScene.duration + 0.25)) { done() }
        }
        .accessibilityLabel(Text("ox is starting"))
    }
}
