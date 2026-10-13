import SwiftUI

/// A run's face: its own colour, and an expression for what it is doing, so a
/// glance at the island says who is busy, who is stuck and who needs you.
///
///   asleep   closed eyes            idle      calm eyes, a slow blink
///   thinking eyes drift side to side working   eyes drift, faster
///   needs you  wide eyes, amber ring  done      happy ^ ^ eyes
///   error    x x eyes, red ring
struct AgentFace: View {
    let color: Color
    let mood: Mood
    var size: CGFloat = 18

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: !animated)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            Canvas { g, sz in
                let r = min(sz.width, sz.height) / 2
                let c = CGPoint(x: sz.width / 2, y: sz.height / 2)
                g.fill(Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)), with: .color(color))
                if let ring {
                    let pulse = 0.5 + 0.5 * sin(t * 4)
                    g.stroke(Path(ellipseIn: CGRect(x: c.x - r - 1.5, y: c.y - r - 1.5, width: 2 * r + 3, height: 2 * r + 3)),
                             with: .color(ring.opacity(0.5 + 0.5 * pulse)), lineWidth: 1.5)
                }
                let eyeY = c.y - r * 0.08
                let gap = r * 0.42
                let ink = Color.black.opacity(0.82)
                switch mood {
                case .sleeping:
                    for dx in [-gap, gap] {
                        var p = Path(); p.move(to: CGPoint(x: c.x + dx - r * 0.16, y: eyeY)); p.addLine(to: CGPoint(x: c.x + dx + r * 0.16, y: eyeY))
                        g.stroke(p, with: .color(ink), style: StrokeStyle(lineWidth: max(1, r * 0.13), lineCap: .round))
                    }
                case .done:
                    for dx in [-gap, gap] {
                        var p = Path()
                        p.move(to: CGPoint(x: c.x + dx - r * 0.17, y: eyeY + r * 0.07))
                        p.addLine(to: CGPoint(x: c.x + dx, y: eyeY - r * 0.12))
                        p.addLine(to: CGPoint(x: c.x + dx + r * 0.17, y: eyeY + r * 0.07))
                        g.stroke(p, with: .color(ink), style: StrokeStyle(lineWidth: max(1, r * 0.13), lineCap: .round, lineJoin: .round))
                    }
                case .error:
                    for dx in [-gap, gap] {
                        let e = r * 0.13
                        var p = Path()
                        p.move(to: CGPoint(x: c.x + dx - e, y: eyeY - e)); p.addLine(to: CGPoint(x: c.x + dx + e, y: eyeY + e))
                        p.move(to: CGPoint(x: c.x + dx + e, y: eyeY - e)); p.addLine(to: CGPoint(x: c.x + dx - e, y: eyeY + e))
                        g.stroke(p, with: .color(ink), style: StrokeStyle(lineWidth: max(1, r * 0.12), lineCap: .round))
                    }
                case .needsYou:
                    for dx in [-gap, gap] {
                        let e = r * 0.2
                        g.fill(Path(ellipseIn: CGRect(x: c.x + dx - e, y: eyeY - e, width: 2 * e, height: 2 * e)), with: .color(ink))
                    }
                default:
                    // idle, thinking, working: tall eyes; busy eyes drift, idle ones blink.
                    let speed: Double = { if case .working = mood { return 3.2 }; return mood == .thinking ? 1.6 : 0 }()
                    let drift = speed > 0 ? CGFloat(sin(t * speed)) * r * 0.14 : 0
                    let blink = speed == 0 && (t.truncatingRemainder(dividingBy: 4.2)) < 0.12
                    for dx in [-gap, gap] {
                        let w = r * 0.2, h = blink ? r * 0.05 : r * 0.42
                        g.fill(Path(roundedRect: CGRect(x: c.x + dx + drift - w / 2, y: eyeY - h / 2, width: w, height: h), cornerRadius: w / 2), with: .color(ink))
                    }
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel(label)
    }

    private var animated: Bool {
        switch mood {
        case .working, .thinking, .needsYou, .error, .idle: return true
        default: return false
        }
    }

    private var ring: Color? {
        switch mood {
        case .needsYou: return Ink.amber
        case .error: return Ink.red
        default: return nil
        }
    }

    private var label: String {
        switch mood {
        case .sleeping: return "asleep"
        case .idle: return "idle"
        case .thinking: return "thinking"
        case .working(let tool): return "working: \(tool)"
        case .needsYou: return "needs you"
        case .done: return "done"
        case .error(let m): return "error: \(m)"
        }
    }
}
