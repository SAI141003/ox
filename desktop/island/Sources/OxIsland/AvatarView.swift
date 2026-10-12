import SwiftUI

// The talking avatar for OX Buddy. The Ox is drawn as vectors; the people are
// the pixel cast (PixelPeople.swift). Either way it blinks, breathes, changes
// expression with the run's mood, moves its mouth through the visemes of each
// spoken word, and gestures with its hands while it talks.

enum Expression: Equatable { case neutral, happy, thinking, surprised, worried, listening }

struct AvatarLook {
    let skin: Color, skinShade: Color, hair: Color, shirt: Color, accent: Color
    let glasses: Bool

    /// The Ox's colours (the people take theirs from the pixel cast).
    static func of(_ k: AvatarKind) -> AvatarLook {
        AvatarLook(skin: Color(hex: "#3A3B42"), skinShade: Color(hex: "#24252A"), hair: Color(hex: "#E9C27B"),
                   shirt: Color(hex: "#4A4B53"), accent: Color(hex: "#E9A66B"), glasses: false)
    }
}

struct AvatarView: View {
    let kind: AvatarKind
    var expression: Expression = .neutral
    var mouth: Viseme = .rest
    var gesture: Gesture = .rest
    var level: Double = 0          // mic level while listening (the avatar leans in)
    var look: CGVector = .zero     // -1...1 gaze

    var body: some View {
        TimelineView(.animation) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            Canvas { ctx, size in
                if kind == .ox {
                    AvatarPainter(kind: kind, look: AvatarLook.of(kind), expression: expression, mouth: mouth,
                                  gesture: gesture, level: level, gaze: look, t: t).paint(&ctx, size)
                } else {
                    let pose = PixelBuddy.pose(expression: expression, mouth: mouth, gesture: gesture, t: t)
                    let px = floor(min(size.width / 18, size.height / 26))
                    let bob: CGFloat = pose.pose == "stand" && Int(t * 1.6) % 2 == 0 ? px : 0
                    let origin = CGPoint(x: (size.width - px * 18) / 2, y: size.height - px * 26 + bob)
                    PixelCast.draw(&ctx, kind.rawValue, pose, at: origin, px: px)
                }
            }
        }
        .animation(.spring(response: 0.18, dampingFraction: 0.7), value: mouth)
        .accessibilityLabel("\(kind.title), your OX Buddy")
    }
}

struct AvatarPainter {
    let kind: AvatarKind
    let look: AvatarLook
    let expression: Expression
    let mouth: Viseme
    let gesture: Gesture
    let level: Double
    let gaze: CGVector
    let t: Double

    func paint(_ ctx: inout GraphicsContext, _ size: CGSize) {
        let s = min(size.width, size.height) / 120 // design grid: 120 x 120
        let cx = size.width / 2
        let breathe = sin(t * 2.1) * 0.8 * s
        let lean = level * 3 * s
        let headC = CGPoint(x: cx + lean * 0.4, y: 50 * s + breathe * 0.4 - lean)

        torso(&ctx, cx: cx, s: s, breathe: breathe)
        hands(&ctx, cx: cx, s: s)
        oxHead(&ctx, c: headC, s: s)
    }

    // MARK: body

    private func torso(_ ctx: inout GraphicsContext, cx: CGFloat, s: CGFloat, breathe: CGFloat) {
        let top = 86 * s + breathe
        var body = Path()
        body.move(to: CGPoint(x: cx - 34 * s, y: 122 * s))
        body.addCurve(to: CGPoint(x: cx - 20 * s, y: top), control1: CGPoint(x: cx - 34 * s, y: top + 14 * s), control2: CGPoint(x: cx - 30 * s, y: top + 2 * s))
        body.addQuadCurve(to: CGPoint(x: cx + 20 * s, y: top), control: CGPoint(x: cx, y: top - 6 * s))
        body.addCurve(to: CGPoint(x: cx + 34 * s, y: 122 * s), control1: CGPoint(x: cx + 30 * s, y: top + 2 * s), control2: CGPoint(x: cx + 34 * s, y: top + 14 * s))
        body.closeSubpath()
        ctx.fill(body, with: .linearGradient(Gradient(colors: [look.shirt.opacity(0.95), look.shirt.opacity(0.7)]),
                                             startPoint: CGPoint(x: cx, y: top), endPoint: CGPoint(x: cx, y: 122 * s)))
        // Neck shadow / collar.
        let collar = Path(ellipseIn: CGRect(x: cx - 9 * s, y: top - 5 * s, width: 18 * s, height: 9 * s))
        ctx.fill(collar, with: .color(look.skinShade))
        // A soft rim light so the figure reads against the black island.
        ctx.stroke(body, with: .color(Color.white.opacity(0.10)), lineWidth: 1 * s)
        if kind == .ox {
            // Gold bell collar: the brand, and a reason for the bull to wear a shirt.
            var band = Path()
            band.move(to: CGPoint(x: cx - 14 * s, y: top + 1 * s))
            band.addQuadCurve(to: CGPoint(x: cx + 14 * s, y: top + 1 * s), control: CGPoint(x: cx, y: top + 8 * s))
            ctx.stroke(band, with: .color(look.hair), style: StrokeStyle(lineWidth: 2.4 * s, lineCap: .round))
            ctx.fill(Path(ellipseIn: CGRect(x: cx - 3.5 * s, y: top + 3 * s, width: 7 * s, height: 7 * s)), with: .color(look.hair))
        }
    }

    /// Hand position (centre) and tilt for each gesture, mirrored for the left hand.
    private func handPose(right: Bool) -> (CGPoint, Double, Bool) {
        let side: CGFloat = right ? 1 : -1
        let wob = sin(t * 9) * 2
        switch gesture {
        case .rest: return (CGPoint(x: 36 * side, y: 118), 0, false)
        case .beat(let n):
            // Alternate hands on the beat of the words, like someone explaining.
            let up = (n % 2 == 0) == right
            return (CGPoint(x: 30 * side, y: up ? 96 + wob : 108), Double(side) * (up ? -0.3 : -0.1), false)
        case .open: return (CGPoint(x: 38 * side, y: 96 + wob * 0.5), Double(side) * -0.5, false)
        case .point:
            return right ? (CGPoint(x: 44, y: 78 + wob * 0.4), -0.9, true) : (CGPoint(x: -34, y: 114), 0, false)
        case .wave:
            return right ? (CGPoint(x: 42, y: 64), sin(t * 10) * 0.45, false) : (CGPoint(x: -34, y: 114), 0, false)
        case .think:
            return right ? (CGPoint(x: 10, y: 80), -0.2, false) : (CGPoint(x: -34, y: 114), 0, false)
        }
    }

    private func hands(_ ctx: inout GraphicsContext, cx: CGFloat, s: CGFloat) {
        for right in [false, true] {
            let (p, tilt, pointing) = handPose(right: right)
            let c = CGPoint(x: cx + p.x * s, y: p.y * s)
            var hc = ctx
            hc.translateBy(x: c.x, y: c.y)
            hc.rotate(by: .radians(tilt))
            let fill: GraphicsContext.Shading = kind == .ox ? .color(Color(hex: "#5A5B63")) : .color(look.skin)
            // Palm.
            let palm = Path(roundedRect: CGRect(x: -7 * s, y: -6 * s, width: 14 * s, height: 13 * s), cornerRadius: 5 * s)
            hc.fill(palm, with: fill)
            hc.stroke(palm, with: .color(.black.opacity(0.25)), lineWidth: 0.8 * s)
            if pointing {
                let finger = Path(roundedRect: CGRect(x: -2 * s, y: -17 * s, width: 4.4 * s, height: 13 * s), cornerRadius: 2.2 * s)
                hc.fill(finger, with: fill)
            } else if kind != .ox {
                for i in 0..<4 {
                    let f = Path(roundedRect: CGRect(x: (-6.5 + Double(i) * 3.4) * s, y: -11 * s, width: 3 * s, height: 7 * s), cornerRadius: 1.5 * s)
                    hc.fill(f, with: fill)
                }
            }
            // Thumb.
            let thumb = Path(roundedRect: CGRect(x: (right ? -10 : 6) * s, y: -2 * s, width: 4 * s, height: 7 * s), cornerRadius: 2 * s)
            hc.fill(thumb, with: fill)
        }
    }

    // MARK: faces

    private func oxHead(_ ctx: inout GraphicsContext, c: CGPoint, s: CGFloat) {
        // Horns, gold, sweeping up and out.
        for sx in [-1.0, 1.0] {
            var horn = Path()
            horn.move(to: CGPoint(x: c.x + sx * 18 * s, y: c.y - 18 * s))
            horn.addCurve(to: CGPoint(x: c.x + sx * 40 * s, y: c.y - 36 * s),
                          control1: CGPoint(x: c.x + sx * 30 * s, y: c.y - 18 * s), control2: CGPoint(x: c.x + sx * 40 * s, y: c.y - 26 * s))
            horn.addCurve(to: CGPoint(x: c.x + sx * 14 * s, y: c.y - 24 * s),
                          control1: CGPoint(x: c.x + sx * 34 * s, y: c.y - 26 * s), control2: CGPoint(x: c.x + sx * 24 * s, y: c.y - 24 * s))
            horn.closeSubpath()
            ctx.fill(horn, with: .linearGradient(Gradient(colors: [Color(hex: "#F6DFA8"), look.hair, Color(hex: "#B98A45")]),
                                                 startPoint: CGPoint(x: c.x + sx * 14 * s, y: c.y - 20 * s), endPoint: CGPoint(x: c.x + sx * 40 * s, y: c.y - 36 * s)))
            // Ears, flicking now and then.
            let flick = sin(t * 3 + sx) > 0.97 ? 0.35 : 0.0
            var ec = ctx
            ec.translateBy(x: c.x + sx * 27 * s, y: c.y - 8 * s)
            ec.rotate(by: .radians(sx * (0.5 + flick)))
            ec.fill(Path(ellipseIn: CGRect(x: -9 * s, y: -4 * s, width: 18 * s, height: 8 * s)), with: .color(look.skinShade))
            ec.fill(Path(ellipseIn: CGRect(x: -6 * s, y: -2 * s, width: 12 * s, height: 4 * s)), with: .color(Color(hex: "#C98F78").opacity(0.7)))
        }
        // Skull.
        let head = Path(roundedRect: CGRect(x: c.x - 24 * s, y: c.y - 26 * s, width: 48 * s, height: 46 * s), cornerRadius: 20 * s)
        ctx.fill(head, with: .radialGradient(Gradient(colors: [Color(hex: "#55565E"), look.skin, look.skinShade]),
                                             center: CGPoint(x: c.x - 8 * s, y: c.y - 14 * s), startRadius: 2 * s, endRadius: 40 * s))
        // Gold forehead tuft.
        var tuft = Path()
        tuft.move(to: CGPoint(x: c.x - 8 * s, y: c.y - 24 * s))
        tuft.addQuadCurve(to: CGPoint(x: c.x + 8 * s, y: c.y - 24 * s), control: CGPoint(x: c.x, y: c.y - 34 * s))
        tuft.addQuadCurve(to: CGPoint(x: c.x - 8 * s, y: c.y - 24 * s), control: CGPoint(x: c.x, y: c.y - 18 * s))
        ctx.fill(tuft, with: .color(look.hair.opacity(0.9)))
        eyesAndBrows(&ctx, c: CGPoint(x: c.x, y: c.y - 6 * s), s: s, spacing: 11, iris: Color(hex: "#5A3A1E"))
        // Muzzle.
        let muzzle = Path(roundedRect: CGRect(x: c.x - 17 * s, y: c.y + 4 * s, width: 34 * s, height: 22 * s), cornerRadius: 11 * s)
        ctx.fill(muzzle, with: .linearGradient(Gradient(colors: [Color(hex: "#D8A585"), Color(hex: "#B07E62")]),
                                               startPoint: CGPoint(x: c.x, y: c.y + 4 * s), endPoint: CGPoint(x: c.x, y: c.y + 26 * s)))
        for sx in [-1.0, 1.0] {
            ctx.fill(Path(ellipseIn: CGRect(x: c.x + sx * 7 * s - 2.5 * s, y: c.y + 9 * s, width: 5 * s, height: 3.4 * s)), with: .color(Color(hex: "#5A3528")))
        }
        mouthShape(&ctx, c: CGPoint(x: c.x, y: c.y + 19 * s), s: s * 0.9, lip: Color(hex: "#6E3B2C"))
    }

    // MARK: eyes, brows, mouth

    private func eyesAndBrows(_ ctx: inout GraphicsContext, c: CGPoint, s: CGFloat, spacing: CGFloat, iris: Color) {
        // Blink: a quick close every ~4.3 s, a double blink now and then.
        let phase = t.truncatingRemainder(dividingBy: 4.3)
        let blink = phase < 0.12 || (Int(t / 4.3) % 3 == 0 && phase > 0.22 && phase < 0.32)
        let open: CGFloat = blink ? 0.08 : expression == .surprised ? 1.25 : expression == .happy ? 0.7 : expression == .listening ? 1.1 : 1
        let gx = CGFloat(gaze.dx) * 2.2 * s
        let gy = CGFloat(expression == .thinking ? -0.8 : gaze.dy) * 1.6 * s
        for sx in [-1.0, 1.0] {
            let e = CGPoint(x: c.x + sx * spacing * s, y: c.y)
            let white = Path(ellipseIn: CGRect(x: e.x - 5 * s, y: e.y - 4.5 * s * open, width: 10 * s, height: 9 * s * open))
            ctx.fill(white, with: .color(.white.opacity(0.96)))
            if open > 0.2 {
                var clip = ctx
                clip.clip(to: white)
                clip.fill(Path(ellipseIn: CGRect(x: e.x - 3.4 * s + gx, y: e.y - 3.4 * s + gy, width: 6.8 * s, height: 6.8 * s)), with: .color(iris))
                clip.fill(Path(ellipseIn: CGRect(x: e.x - 1.8 * s + gx, y: e.y - 1.8 * s + gy, width: 3.6 * s, height: 3.6 * s)), with: .color(.black))
                clip.fill(Path(ellipseIn: CGRect(x: e.x - 0.4 * s + gx, y: e.y - 2.4 * s + gy, width: 1.6 * s, height: 1.6 * s)), with: .color(.white))
            }
            ctx.stroke(Path(ellipseIn: CGRect(x: e.x - 5 * s, y: e.y - 4.5 * s * open, width: 10 * s, height: 9 * s * open)),
                       with: .color(.black.opacity(0.35)), lineWidth: 0.8 * s)
            // Brows carry most of the expression.
            let (lift, tilt): (CGFloat, CGFloat) = {
                switch expression {
                case .neutral: return (0, 0)
                case .happy: return (1, 0)
                case .thinking: return (sx < 0 ? 3 : 0, 0)
                case .surprised: return (4, 0)
                case .worried: return (2, 2.4)
                case .listening: return (2, 0)
                }
            }()
            var brow = Path()
            let by = e.y - 8.5 * s - lift * s
            brow.move(to: CGPoint(x: e.x - 5 * s, y: by + tilt * CGFloat(sx) * s * -0.5))
            brow.addQuadCurve(to: CGPoint(x: e.x + 5 * s, y: by - tilt * CGFloat(sx) * s * -0.5), control: CGPoint(x: e.x, y: by - 2 * s))
            ctx.stroke(brow, with: .color(kind == .ox ? look.hair.opacity(0.85) : look.hair), style: StrokeStyle(lineWidth: 2.2 * s, lineCap: .round))
        }
    }

    private func mouthShape(_ ctx: inout GraphicsContext, c: CGPoint, s: CGFloat, lip: Color) {
        // Width and opening per viseme; expressions bend the corners.
        let (w, h): (CGFloat, CGFloat) = {
            switch mouth {
            case .rest: return (11, 0)
            case .closed: return (10, 0.6)
            case .small: return (10, 3)
            case .open: return (12, 7.5)
            case .wide: return (14, 4.5)
            case .round: return (7, 7)
            case .teeth: return (12, 3.2)
            }
        }()
        let corner: CGFloat = expression == .happy ? -3 : expression == .worried ? 2.4 : expression == .surprised ? 0 : -1
        if h < 0.8 {
            var line = Path()
            line.move(to: CGPoint(x: c.x - w / 2 * s, y: c.y + corner * s))
            line.addQuadCurve(to: CGPoint(x: c.x + w / 2 * s, y: c.y + corner * s), control: CGPoint(x: c.x, y: c.y - corner * 1.4 * s))
            ctx.stroke(line, with: .color(lip), style: StrokeStyle(lineWidth: 2 * s, lineCap: .round))
            return
        }
        let rect = CGRect(x: c.x - w / 2 * s, y: c.y - h / 2 * s, width: w * s, height: h * s)
        let shape = mouth == .round ? Path(ellipseIn: rect) : Path(roundedRect: rect, cornerRadius: min(w, h) / 2 * s)
        ctx.fill(shape, with: .color(Color(hex: "#2A1015")))
        if mouth == .teeth || mouth == .wide || mouth == .open {
            ctx.fill(Path(roundedRect: CGRect(x: rect.minX + 1.5 * s, y: rect.minY, width: rect.width - 3 * s, height: min(2.2 * s, rect.height / 2)), cornerRadius: 1 * s),
                     with: .color(.white.opacity(0.92)))
        }
        if mouth == .open || mouth == .round {
            ctx.fill(Path(ellipseIn: CGRect(x: c.x - 3 * s, y: rect.maxY - 3 * s, width: 6 * s, height: 2.6 * s)), with: .color(Color(hex: "#C45A63")))
        }
        ctx.stroke(shape, with: .color(lip), lineWidth: 1.4 * s)
    }
}

extension Expression {
    /// The face the avatar wears for the run's mood.
    static func of(_ mood: Mood, buddy: Buddy.Phase) -> Expression {
        switch buddy {
        case .listening: return .listening
        case .thinking: return .thinking
        case .message: return .worried
        case .speaking: return .happy
        case .idle: break
        }
        switch mood {
        case .needsYou: return .surprised
        case .error: return .worried
        case .done: return .happy
        case .thinking, .working: return .thinking
        default: return .neutral
        }
    }
}

/// Maps Buddy's speech and gestures onto the pixel cast's poses and mouths.
enum PixelBuddy {
    static func pose(expression: Expression, mouth: Viseme, gesture: Gesture, t: Double) -> PixelPose {
        let m: String = {
            switch mouth {
            case .rest: return expression == .happy ? "smile" : "rest"
            case .closed: return "closed"
            case .small: return "small"
            case .open: return "open"
            case .wide, .teeth: return "wide"
            case .round: return "round"
            }
        }()
        // A quick blink every ~4 s.
        let blink = t.truncatingRemainder(dividingBy: 4.1) < 0.13
        let wave = Int(t * 5) % 2
        switch gesture {
        case .rest: return PixelPose(dir: .front, pose: expression == .thinking ? "think" : "stand", mouth: m, blink: blink)
        case .beat(let n): return PixelPose(dir: .front, pose: n % 3 == 0 ? "open" : "stand", mouth: m, blink: blink)
        case .open: return PixelPose(dir: .front, pose: "open", mouth: m, blink: blink)
        case .point: return PixelPose(dir: .front, pose: "point", mouth: m, blink: blink)
        case .wave: return PixelPose(dir: .front, pose: "wave", frame: wave, mouth: m, blink: blink)
        case .think: return PixelPose(dir: .front, pose: "think", mouth: m, blink: blink)
        }
    }
}
