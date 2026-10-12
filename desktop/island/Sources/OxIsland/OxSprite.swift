import AppKit
import SwiftUI

// The mascot as a rendered vinyl toy: the body is a Blender render
// (desktop/island/art/ox_model.py -> Resources/ox-body.png), the eyes are drawn
// live on top so they blink, follow the cursor and change with every mood.
// If the render is missing, the vector OxPainter is used instead.

enum OxArt {
    static let body: NSImage? = {
        guard let url = Bundle.module.url(forResource: "ox-body", withExtension: "png", subdirectory: "Resources") else { return nil }
        return NSImage(contentsOf: url)
    }()

    struct Anchors: Decodable {
        let left: [Double]
        let right: [Double]
        let radius: Double
    }

    static let anchors: Anchors = {
        if let url = Bundle.module.url(forResource: "ox-body", withExtension: "json", subdirectory: "Resources"),
           let data = try? Data(contentsOf: url),
           let a = try? JSONDecoder().decode(Anchors.self, from: data) {
            return a
        }
        return Anchors(left: [0.4, 0.47], right: [0.6, 0.47], radius: 0.04)
    }()
}

struct OxSprite: View {
    var mood: Mood
    var size: CGFloat = 58
    var anchor: CGPoint? = nil
    @ObservedObject private var pointer = Pointer.shared

    var body: some View {
        if let img = OxArt.body {
            TimelineView(.animation(minimumInterval: 1.0 / 60.0)) { ctx in
                let t = ctx.date.timeIntervalSinceReferenceDate
                let pose = Self.pose(mood, t: t)
                ZStack {
                    Image(nsImage: img)
                        .resizable()
                        .interpolation(.high)
                        .aspectRatio(contentMode: .fit)
                    Canvas { g, sz in eyes(&g, sz, t: t) }
                    badge(t: t)
                }
                .scaleEffect(x: 1 / pose.squash, y: pose.squash, anchor: .bottom)
                .rotationEffect(.degrees(pose.tilt), anchor: .bottom)
                .offset(y: pose.bob * size / 60)
            }
            .frame(width: size, height: size)
            .accessibilityLabel(Text(OxPainter.describe(mood)))
        } else {
            OxMascot(mood: mood, size: size, anchor: anchor)
        }
    }

    // MARK: motion (same choreography as the vector ox)

    struct Pose { var bob = 0.0, tilt = 0.0, squash = 1.0 }

    static func pose(_ mood: Mood, t: Double) -> Pose {
        var p = Pose()
        switch mood {
        case .sleeping:
            p.bob = sin(t * 1.3) * 0.8
            p.squash = 0.98 + sin(t * 1.3) * 0.015
        case .idle:
            p.bob = sin(t * 1.8) * 0.6
        case .thinking:
            p.tilt = sin(t * 0.9) * 4
        case .working:
            let b = abs(sin(t * 7))
            p.bob = -b * 2.2
            p.squash = 1 - (1 - b) * 0.04
        case .needsYou:
            let ph = t.truncatingRemainder(dividingBy: 1.4) / 1.4
            if ph < 0.12 { p.squash = 1 - ph / 0.12 * 0.1 }
            else if ph < 0.42 { p.bob = -sin((ph - 0.12) / 0.3 * .pi) * 7; p.squash = 1.05 }
            else if ph < 0.52 { p.squash = 1 - (1 - (ph - 0.42) / 0.1) * 0.07 }
        case .done:
            let ph = t.truncatingRemainder(dividingBy: 2.4) / 2.4
            p.bob = ph < 0.25 ? -sin(ph / 0.25 * .pi) * 4 : 0
            p.tilt = sin(t * 2) * 3
        case .error:
            p.tilt = -7 + sin(t * 3) * 2
            p.squash = 0.97
        }
        return p
    }

    private var look: CGVector {
        guard let a = anchor else { return .zero }
        let dx = pointer.local.x - a.x, dy = pointer.local.y - a.y
        let d = max(60, hypot(dx, dy))
        return CGVector(dx: max(-1, min(1, dx / d)), dy: max(-1, min(1, dy / d)))
    }

    // MARK: eyes - glossy black ovals with two catchlights

    private func eyes(_ g: inout GraphicsContext, _ sz: CGSize, t: Double) {
        let A = OxArt.anchors
        let r = CGFloat(A.radius) * sz.width
        let ink = Color(red: 0.10, green: 0.08, blue: 0.07)
        for p in [A.left, A.right] {
            let c = CGPoint(x: CGFloat(p[0]) * sz.width, y: CGFloat(p[1]) * sz.height)
            var path = Path()
            switch mood {
            case .sleeping:
                path.addArc(center: CGPoint(x: c.x, y: c.y - r * 0.2), radius: r * 0.9, startAngle: .degrees(20), endAngle: .degrees(160), clockwise: false)
                g.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: r * 0.42, lineCap: .round))
            case .done:
                path.addArc(center: CGPoint(x: c.x, y: c.y + r * 0.45), radius: r, startAngle: .degrees(200), endAngle: .degrees(340), clockwise: false)
                g.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: r * 0.45, lineCap: .round))
            case .error:
                let k = r * 0.75
                path.move(to: CGPoint(x: c.x - k, y: c.y - k)); path.addLine(to: CGPoint(x: c.x + k, y: c.y + k))
                path.move(to: CGPoint(x: c.x + k, y: c.y - k)); path.addLine(to: CGPoint(x: c.x - k, y: c.y + k))
                g.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: r * 0.4, lineCap: .round))
            default:
                let big: CGFloat = mood == .needsYou ? 1.18 : 1
                let ph = t.truncatingRemainder(dividingBy: 3.7)
                let open: CGFloat = ph < 0.13 ? max(0.1, CGFloat(abs(ph / 0.065 - 1))) : 1
                var gx = CGFloat(look.dx) * r * 0.35, gy = CGFloat(look.dy) * r * 0.25
                if case .thinking = mood { gx = -r * 0.3; gy = -r * 0.35 }
                let w = r * 1.5 * big, h = r * 2.1 * big * open
                let rect = CGRect(x: c.x - w / 2 + gx, y: c.y - h / 2 + gy, width: w, height: h)
                g.fill(Path(ellipseIn: rect), with: .color(ink))
                if open > 0.6 {
                    g.fill(Path(ellipseIn: CGRect(x: rect.minX + w * 0.18, y: rect.minY + h * 0.14, width: w * 0.42, height: w * 0.42)), with: .color(.white))
                    g.fill(Path(ellipseIn: CGRect(x: rect.minX + w * 0.58, y: rect.minY + h * 0.6, width: w * 0.18, height: w * 0.18)), with: .color(.white.opacity(0.85)))
                }
            }
        }
    }

    @ViewBuilder private func badge(t: Double) -> some View {
        switch mood {
        case .needsYou:
            ZStack {
                Circle().fill(Color(red: 0.961, green: 0.647, blue: 0.141))
                Text("!").font(.system(size: size * 0.16, weight: .black, design: .rounded)).foregroundStyle(.black)
            }
            .frame(width: size * 0.24, height: size * 0.24)
            .opacity(0.75 + 0.25 * sin(t * 6))
            .offset(x: size * 0.36, y: -size * 0.34)
        case .sleeping:
            let ph = (t * 0.5).truncatingRemainder(dividingBy: 1)
            Text("z").font(.system(size: size * 0.18, weight: .heavy, design: .rounded))
                .foregroundStyle(.white.opacity(0.75 * (1 - ph)))
                .offset(x: size * 0.36 + ph * 6, y: -size * 0.3 - ph * 12)
        default:
            EmptyView()
        }
    }
}
