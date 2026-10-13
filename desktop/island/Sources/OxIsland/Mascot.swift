import AppKit
import SwiftUI

/// Where the cursor is, in the island panel's top-down coordinates. Only the
/// mascot observes this, so 60 Hz pointer updates never re-render the island.
final class Pointer: ObservableObject {
    static let shared = Pointer()
    @Published var local: CGPoint = .zero
    /// The last click on the island (panel coordinates) and when it happened.
    /// Not published: the ox reads it on its own frame clock.
    var lastClick: (point: CGPoint, at: Double)?
    /// When the cursor last moved: the ox follows a moving cursor, and goes back
    /// to its own life (grazing, the barn) once the cursor rests.
    var movedAt: Double = 0
}

// Ox: OX Island's own character, drawn entirely in code. A toffee ox with
// wide ivory horns, a heavy brow, a forehead curl and a brass nose ring. Its
// eyes and head follow the cursor; every mood is a pose, not just a face.
struct OxMascot: View {
    var mood: Mood
    var size: CGFloat = 58
    /// The ox's centre in panel coordinates, so it can look at the pointer.
    var anchor: CGPoint? = nil
    @ObservedObject private var pointer = Pointer.shared

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60.0)) { context in
            Canvas { ctx, canvas in
                OxPainter(mood: mood, t: context.date.timeIntervalSinceReferenceDate, look: lookVector)
                    .paint(&ctx, size: canvas)
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel(Text(OxPainter.describe(mood)))
    }

    /// -1...1 in each axis: which way the ox should look.
    private var lookVector: CGVector {
        guard let a = anchor else { return .zero }
        let dx = pointer.local.x - a.x, dy = pointer.local.y - a.y
        let d = max(60, hypot(dx, dy))
        return CGVector(dx: max(-1, min(1, dx / d)), dy: max(-1, min(1, dy / d)))
    }
}

struct OxPainter {
    let mood: Mood
    let t: Double
    let look: CGVector

    // Palette
    static let hide = Color(red: 0.914, green: 0.651, blue: 0.420)       // #E9A66B toffee
    static let hideShade = Color(red: 0.741, green: 0.443, blue: 0.231)  // #BD713B
    static let hideLight = Color(red: 0.980, green: 0.808, blue: 0.616)  // #FACE9D
    static let muzzle = Color(red: 1.0, green: 0.910, blue: 0.812)       // #FFE8CF
    static let muzzleShade = Color(red: 0.937, green: 0.784, blue: 0.651)
    static let horn = Color(red: 1.0, green: 0.965, blue: 0.902)         // #FFF6E6
    static let hornShade = Color(red: 0.851, green: 0.776, blue: 0.659)
    static let earInner = Color(red: 0.965, green: 0.588, blue: 0.541)
    static let ink = Color(red: 0.102, green: 0.082, blue: 0.071)        // #1A1512
    static let brass = Color(red: 0.949, green: 0.757, blue: 0.306)      // #F2C14E
    static let blush = Color(red: 1.0, green: 0.541, blue: 0.478)

    static func describe(_ mood: Mood) -> String {
        switch mood {
        case .sleeping: return "Ox is asleep: no ox runs"
        case .idle: return "Ox is waiting for you"
        case .thinking: return "Ox is thinking"
        case .working(let tool): return "Ox is running \(tool)"
        case .needsYou: return "Ox needs your approval"
        case .done: return "Ox finished"
        case .error: return "Ox hit an error"
        }
    }

    func paint(_ ctx: inout GraphicsContext, size: CGSize) {
        let s = min(size.width, size.height)
        // 6% margin all round so horn tips and hops never touch the frame edge.
        let u = s / 100 * 0.88
        ctx.translateBy(x: (size.width - 100 * u) / 2, y: (size.height - 100 * u) / 2 + 2 * u)

        // ---- pose: bob, hop, squash, tilt -------------------------------
        var bob = 0.0, tilt = 0.0, squash = 1.0, earFlap = 0.0
        switch mood {
        case .sleeping:
            bob = sin(t * 1.3) * 1.2
            squash = 1 + sin(t * 1.3) * 0.015
        case .idle:
            bob = sin(t * 1.8) * 0.8
            tilt = look.dx * 6
        case .thinking:
            bob = sin(t * 2.2) * 1.2
            tilt = sin(t * 0.9) * 5
        case .working:
            let b = abs(sin(t * 7))
            bob = -b * 3
            squash = 1 - (1 - b) * 0.04
            earFlap = sin(t * 14) * 8
        case .needsYou:
            // A hop every 1.4 s: anticipation squash, airtime, landing squash.
            let p = (t.truncatingRemainder(dividingBy: 1.4)) / 1.4
            if p < 0.12 { squash = 1 - p / 0.12 * 0.08 }
            else if p < 0.42 { bob = -sin((p - 0.12) / 0.30 * .pi) * 9; squash = 1.04 }
            else if p < 0.52 { squash = 1 - (1 - (p - 0.42) / 0.10) * 0.06 }
            earFlap = 14
        case .done:
            let p = (t.truncatingRemainder(dividingBy: 2.4)) / 2.4
            bob = p < 0.25 ? -sin(p / 0.25 * .pi) * 5 : 0
            tilt = sin(t * 2) * 3
        case .error:
            tilt = -8 + sin(t * 3) * 2
            squash = 0.97
        }

        ctx.translateBy(x: 50 * u, y: (56 + bob) * u)
        ctx.rotate(by: .degrees(tilt))
        ctx.scaleBy(x: 1 / squash, y: squash)
        ctx.translateBy(x: -50 * u, y: -56 * u)

        // Head turns slightly toward the pointer (parallax on the face).
        let lx = look.dx * 3.0, ly = look.dy * 2.0

        drawShadow(&ctx, u)
        drawHorns(&ctx, u, lx: lx * 0.4)
        drawEars(&ctx, u, flap: earFlap)
        drawHead(&ctx, u)
        drawTuft(&ctx, u, lx: lx)
        drawMuzzle(&ctx, u, lx: lx, ly: ly)
        drawEyes(&ctx, u, lx: lx, ly: ly)
        drawCheeks(&ctx, u, lx: lx)
        drawBadge(&ctx, u)
    }

    private func pt(_ x: Double, _ y: Double, _ u: CGFloat) -> CGPoint { CGPoint(x: x * u, y: y * u) }
    private func rect(_ x: Double, _ y: Double, _ w: Double, _ h: Double, _ u: CGFloat) -> CGRect {
        CGRect(x: x * u, y: y * u, width: w * u, height: h * u)
    }

    private func drawShadow(_ ctx: inout GraphicsContext, _ u: CGFloat) {
        // Soft contact glow under the chin keeps the ox seated on black.
        ctx.fill(Path(ellipseIn: rect(26, 86, 48, 8, u)),
                 with: .radialGradient(Gradient(colors: [Self.hide.opacity(0.22), .clear]),
                                       center: pt(50, 90, u), startRadius: 0, endRadius: 26 * u))
    }

    private func drawHorns(_ ctx: inout GraphicsContext, _ u: CGFloat, lx: Double) {
        // An ox's horns: thick at the poll, sweeping out sideways, tips turning up.
        for side in [-1.0, 1.0] {
            var p = Path()
            let root = 50 + side * 18 + lx
            p.move(to: pt(root - side * 4, 36, u))                                   // lower root
            p.addCurve(to: pt(50 + side * 47 + lx, 9, u),                           // out and up to the tip
                       control1: pt(50 + side * 38 + lx, 38, u), control2: pt(50 + side * 48 + lx, 24, u))
            p.addCurve(to: pt(root + side * 2, 26, u),                              // back along the top edge
                       control1: pt(50 + side * 42 + lx, 20, u), control2: pt(50 + side * 34 + lx, 27, u))
            p.closeSubpath()
            ctx.fill(p, with: .linearGradient(Gradient(colors: [Self.hornShade, Self.horn]),
                                              startPoint: pt(root, 32, u), endPoint: pt(50 + side * 47 + lx, 9, u)))
        }
    }

    private func drawEars(_ ctx: inout GraphicsContext, _ u: CGFloat, flap: Double) {
        for side in [-1.0, 1.0] {
            var e = ctx
            e.translateBy(x: (50 + side * 30) * u, y: 44 * u)
            e.rotate(by: .degrees(side * (18 + flap * 0.6)))
            let outer = Path(ellipseIn: CGRect(x: (side < 0 ? -22 : 0) * u, y: -6.5 * u, width: 22 * u, height: 13 * u))
            e.fill(outer, with: .color(Self.hideShade))
            let inner = Path(ellipseIn: CGRect(x: (side < 0 ? -18 : 4) * u, y: -3.5 * u, width: 14 * u, height: 7 * u))
            e.fill(inner, with: .color(Self.earInner.opacity(0.9)))
        }
    }

    private func headPath(_ u: CGFloat) -> Path {
        // Flat, broad poll and a square jaw: an ox, not a ball.
        var p = Path()
        p.move(to: pt(50, 25, u))
        p.addCurve(to: pt(81, 46, u), control1: pt(72, 25, u), control2: pt(81, 31, u))
        p.addCurve(to: pt(70, 85, u), control1: pt(81, 64, u), control2: pt(79, 82, u))
        p.addLine(to: pt(30, 85, u))
        p.addCurve(to: pt(19, 46, u), control1: pt(21, 82, u), control2: pt(19, 64, u))
        p.addCurve(to: pt(50, 25, u), control1: pt(19, 31, u), control2: pt(28, 25, u))
        p.closeSubpath()
        return p
    }

    private func drawHead(_ ctx: inout GraphicsContext, _ u: CGFloat) {
        let head = headPath(u)
        ctx.fill(head, with: .linearGradient(Gradient(colors: [Self.hideLight, Self.hide, Self.hideShade]),
                                             startPoint: pt(38, 26, u), endPoint: pt(62, 86, u)))
        // Key light: soft specular on the upper-left brow.
        ctx.fill(head, with: .radialGradient(Gradient(colors: [Color.white.opacity(0.35), .clear]),
                                             center: pt(38, 36, u), startRadius: 0, endRadius: 22 * u))
    }

    private func drawTuft(_ ctx: inout GraphicsContext, _ u: CGFloat, lx: Double) {
        var p = Path()
        let x = 50 + lx
        p.move(to: pt(x - 7, 31, u))
        p.addQuadCurve(to: pt(x + 1, 22, u), control: pt(x - 7, 22, u))
        p.addQuadCurve(to: pt(x + 6, 31, u), control: pt(x + 8, 24, u))
        p.addQuadCurve(to: pt(x - 7, 31, u), control: pt(x, 35, u))
        ctx.fill(p, with: .color(Self.hideShade))
    }

    private func drawMuzzle(_ ctx: inout GraphicsContext, _ u: CGFloat, lx: Double, ly: Double) {
        let x = 50 + lx * 1.2, y = 70 + ly * 0.5
        let m = Path(ellipseIn: rect(x - 21, y - 12, 42, 25, u))
        ctx.fill(m, with: .linearGradient(Gradient(colors: [Self.muzzle, Self.muzzleShade]),
                                          startPoint: pt(x, y - 12, u), endPoint: pt(x, y + 13, u)))
        for side in [-1.0, 1.0] {
            ctx.fill(Path(ellipseIn: rect(x + side * 8 - 2.6, y - 2, 5.2, 6.2, u)), with: .color(Self.ink.opacity(0.75)))
        }
        // Nose ring swings like a pendulum, livelier while working.
        var swing = sin(t * 2.0) * 10
        if case .working = mood { swing = sin(t * 7) * 18 }
        var r = ctx
        r.translateBy(x: x * u, y: (y + 5) * u)
        r.rotate(by: .degrees(swing))
        var ring = Path()
        ring.addArc(center: CGPoint(x: 0, y: 4.5 * u), radius: 5 * u, startAngle: .degrees(-35), endAngle: .degrees(215), clockwise: false)
        r.stroke(ring, with: .color(Self.brass), style: StrokeStyle(lineWidth: 2.4 * u, lineCap: .round))
    }

    private func drawEyes(_ ctx: inout GraphicsContext, _ u: CGFloat, lx: Double, ly: Double) {
        let ey = 50 + ly
        for side in [-1.0, 1.0] {
            let cx = 50 + side * 13 + lx
            var p = Path()
            switch mood {
            case .sleeping:
                p.addArc(center: pt(cx, ey - 1, u), radius: 5 * u, startAngle: .degrees(20), endAngle: .degrees(160), clockwise: false)
                ctx.stroke(p, with: .color(Self.ink), style: StrokeStyle(lineWidth: 2.4 * u, lineCap: .round))
            case .done:
                p.addArc(center: pt(cx, ey + 3, u), radius: 5.5 * u, startAngle: .degrees(200), endAngle: .degrees(340), clockwise: false)
                ctx.stroke(p, with: .color(Self.ink), style: StrokeStyle(lineWidth: 2.8 * u, lineCap: .round))
            case .error:
                // Dizzy swirl.
                let spin = t * 6 * side
                for k in 0..<14 {
                    let a = Double(k) / 14 * 2.6 * .pi + spin
                    let rr = 0.6 + Double(k) * 0.38
                    let q = pt(cx + cos(a) * rr, ey + sin(a) * rr, u)
                    if k == 0 { p.move(to: q) } else { p.addLine(to: q) }
                }
                ctx.stroke(p, with: .color(Self.ink), style: StrokeStyle(lineWidth: 1.8 * u, lineCap: .round))
            default:
                let big = mood == .needsYou
                let r = big ? 6.6 : 5.4
                // Blink: every ~3.7 s, 130 ms, both eyes together.
                let phase = t.truncatingRemainder(dividingBy: 3.7)
                let open = phase < 0.13 ? max(0.12, abs(phase / 0.065 - 1)) : 1.0
                var gx = look.dx * 2.2, gy = look.dy * 1.8
                if case .thinking = mood { gx = -1.6 + sin(t * 1.4) * 0.8; gy = -1.8 }
                let eye = rect(cx - r + gx * 0.4, ey - r * open + gy * 0.4, 2 * r, 2 * r * open, u)
                ctx.fill(Path(ellipseIn: eye), with: .color(Self.ink))
                if open > 0.6 {
                    // Catchlights: one large, one small. This is what makes it alive.
                    ctx.fill(Path(ellipseIn: rect(cx + gx - r * 0.5, ey + gy - r * 0.62, r * 0.62, r * 0.62, u)), with: .color(.white))
                    ctx.fill(Path(ellipseIn: rect(cx + gx + r * 0.22, ey + gy + r * 0.18, r * 0.26, r * 0.26, u)), with: .color(.white.opacity(0.85)))
                }
            }
        }
    }

    private func drawCheeks(_ ctx: inout GraphicsContext, _ u: CGFloat, lx: Double) {
        let strength: Double = mood == .done ? 0.35 : 0.12
        for side in [-1.0, 1.0] {
            let c = pt(50 + side * 22 + lx, 60, u)
            ctx.fill(Path(ellipseIn: CGRect(x: c.x - 6 * u, y: c.y - 3.5 * u, width: 12 * u, height: 7 * u)),
                     with: .radialGradient(Gradient(colors: [Self.blush.opacity(strength), .clear]), center: c, startRadius: 0, endRadius: 6 * u))
        }
    }

    private func drawBadge(_ ctx: inout GraphicsContext, _ u: CGFloat) {
        switch mood {
        case .sleeping:
            let p = (t * 0.5).truncatingRemainder(dividingBy: 1)
            let text = Text("z").font(.system(size: 13 * u, weight: .heavy, design: .rounded))
                .foregroundColor(.white.opacity(0.75 * (1 - p)))
            ctx.draw(text, at: pt(84 + p * 6, 26 - p * 16, u))
        case .needsYou:
            let pulse = 0.75 + 0.25 * sin(t * 6)
            ctx.fill(Path(ellipseIn: rect(76, 14, 18, 18, u)), with: .color(Color(red: 0.961, green: 0.647, blue: 0.141).opacity(pulse)))
            ctx.draw(Text("!").font(.system(size: 12 * u, weight: .black, design: .rounded)).foregroundColor(.black), at: pt(85, 23, u))
        default:
            break
        }
    }
}
