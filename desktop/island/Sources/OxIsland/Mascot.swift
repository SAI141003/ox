import SwiftUI

// The ox: an original character drawn entirely in code (no image assets).
// Every mood is a different face, so the notch says what the agent is doing
// at a glance: asleep, thinking (eyes drift), working (head bobs), needs you
// (eyes wide, ear wiggle), done (happy arcs), error (x eyes).
struct OxMascot: View {
    var mood: Mood
    var size: CGFloat = 24

    private static let hide = Color(red: 0.93, green: 0.62, blue: 0.33)
    private static let hideDark = Color(red: 0.78, green: 0.47, blue: 0.24)
    private static let muzzle = Color(red: 0.99, green: 0.86, blue: 0.70)
    private static let horn = Color(red: 0.98, green: 0.95, blue: 0.88)
    private static let ring = Color(red: 1.0, green: 0.80, blue: 0.25)

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60.0)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            Canvas { ctx, canvas in
                draw(ctx: &ctx, in: canvas, t: t)
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel(Text(accessibilityText))
    }

    private var accessibilityText: String {
        switch mood {
        case .sleeping: return "ox is asleep"
        case .idle: return "ox is waiting"
        case .thinking: return "ox is thinking"
        case .working(let tool): return "ox is running \(tool)"
        case .needsYou: return "ox needs your approval"
        case .done: return "ox is done"
        case .error: return "ox hit an error"
        }
    }

    private func draw(ctx: inout GraphicsContext, in canvas: CGSize, t: Double) {
        let s = min(canvas.width, canvas.height)
        let u = s / 100 // design on a 100-unit grid

        // Motion per mood.
        var bob: CGFloat = 0
        var earWiggle: CGFloat = 0
        switch mood {
        case .working: bob = CGFloat(sin(t * 9)) * 2.2 * u
        case .thinking: bob = CGFloat(sin(t * 2.4)) * 1.2 * u
        case .needsYou: earWiggle = CGFloat(sin(t * 14)) * 6
        case .sleeping: bob = CGFloat(sin(t * 1.1)) * 1.5 * u
        default: break
        }
        ctx.translateBy(x: 0, y: bob)

        // Horns: two swept crescents.
        for side in [-1.0, 1.0] {
            var horn = Path()
            let bx = 50 + side * 22, by = 34.0
            horn.move(to: pt(bx - side * 4, by, u))
            horn.addQuadCurve(to: pt(50 + side * 46, 8, u), control: pt(50 + side * 44, 34, u))
            horn.addQuadCurve(to: pt(bx + side * 6, by + 6, u), control: pt(50 + side * 34, 30, u))
            horn.closeSubpath()
            ctx.fill(horn, with: .color(Self.horn))
        }

        // Ears (wiggle when it needs you).
        for side in [-1.0, 1.0] {
            var ear = ctx
            ear.translateBy(x: (50 + side * 33) * u, y: 44 * u)
            ear.rotate(by: .degrees(side * (25 + Double(earWiggle))))
            ear.fill(Path(ellipseIn: CGRect(x: -11 * u, y: -6 * u, width: 22 * u, height: 12 * u)), with: .color(Self.hideDark))
        }

        // Head.
        let head = Path(roundedRect: CGRect(x: 24 * u, y: 28 * u, width: 52 * u, height: 58 * u), cornerRadius: 22 * u)
        ctx.fill(head, with: .color(Self.hide))

        // Muzzle + nostrils + nose ring.
        let muzzleRect = CGRect(x: 28 * u, y: 62 * u, width: 44 * u, height: 26 * u)
        ctx.fill(Path(ellipseIn: muzzleRect), with: .color(Self.muzzle))
        for side in [-1.0, 1.0] {
            ctx.fill(Path(ellipseIn: CGRect(x: (50 + side * 9 - 3) * u, y: 70 * u, width: 6 * u, height: 7 * u)), with: .color(Self.hideDark))
        }
        var ring = Path()
        ring.addArc(center: pt(50, 80, u), radius: 7 * u, startAngle: .degrees(20), endAngle: .degrees(160), clockwise: false)
        ctx.stroke(ring, with: .color(Self.ring), lineWidth: 2.6 * u)

        drawEyes(ctx: &ctx, u: u, t: t)

        // Mood marks above the head.
        switch mood {
        case .needsYou:
            let pulse = 0.6 + 0.4 * abs(sin(t * 5))
            ctx.fill(Path(roundedRect: CGRect(x: 47 * u, y: -2 * u, width: 6 * u, height: 14 * u), cornerRadius: 3 * u),
                     with: .color(.yellow.opacity(pulse)))
            ctx.fill(Path(ellipseIn: CGRect(x: 47 * u, y: 14 * u, width: 6 * u, height: 6 * u)), with: .color(.yellow.opacity(pulse)))
        case .sleeping:
            let drift = CGFloat((t * 0.6).truncatingRemainder(dividingBy: 1))
            ctx.draw(Text("z").font(.system(size: 16 * u, weight: .bold)).foregroundColor(.white.opacity(Double(1 - drift))),
                     at: pt(80, 18 - Double(drift) * 14, u))
        default:
            break
        }
    }

    private func drawEyes(ctx: inout GraphicsContext, u: CGFloat, t: Double) {
        let eyeY = 50.0
        for side in [-1.0, 1.0] {
            let cx = 50 + side * 12
            switch mood {
            case .sleeping:
                var p = Path()
                p.move(to: pt(cx - 5, eyeY, u)); p.addLine(to: pt(cx + 5, eyeY, u))
                ctx.stroke(p, with: .color(.black.opacity(0.8)), lineWidth: 2.4 * u)
            case .done:
                var p = Path()
                p.addArc(center: pt(cx, eyeY + 2, u), radius: 5 * u, startAngle: .degrees(200), endAngle: .degrees(340), clockwise: false)
                ctx.stroke(p, with: .color(.black.opacity(0.85)), lineWidth: 2.6 * u)
            case .error:
                var p = Path()
                p.move(to: pt(cx - 4, eyeY - 4, u)); p.addLine(to: pt(cx + 4, eyeY + 4, u))
                p.move(to: pt(cx + 4, eyeY - 4, u)); p.addLine(to: pt(cx - 4, eyeY + 4, u))
                ctx.stroke(p, with: .color(.black.opacity(0.85)), lineWidth: 2.6 * u)
            default:
                let wide = mood == .needsYou
                let r = wide ? 7.5 : 6.0
                // Blink every ~4s for ~120ms.
                let phase = (t + side * 0.02).truncatingRemainder(dividingBy: 4.0)
                let open: CGFloat = phase < 0.12 ? 0.15 : 1
                let eye = CGRect(x: (cx - r) * u, y: (eyeY - r * Double(open)) * u, width: 2 * r * u, height: 2 * r * Double(open) * u)
                ctx.fill(Path(ellipseIn: eye), with: .color(.white))
                // Pupils drift while thinking, track side to side while working.
                var dx = 0.0
                if case .thinking = mood { dx = sin(t * 1.7) * 2.2 }
                if case .working = mood { dx = sin(t * 4) * 2.6 }
                let pr = wide ? 3.6 : 3.0
                if open > 0.5 {
                    ctx.fill(Path(ellipseIn: CGRect(x: (cx + dx - pr) * u, y: (eyeY - pr + 0.5) * u, width: 2 * pr * u, height: 2 * pr * u)),
                             with: .color(.black))
                }
            }
        }
    }

    private func pt(_ x: Double, _ y: Double, _ u: CGFloat) -> CGPoint {
        CGPoint(x: CGFloat(x) * u, y: CGFloat(y) * u)
    }
}
