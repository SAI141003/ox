import SwiftUI

// The office: every agent in a run gets a desk and a pixel ox at a monitor, so
// "who is doing what" is visible at a glance. Lead agent first, then each
// subagent in the order it was delegated. Pixel art is drawn from tiny string
// sprites so it stays crisp at any size and needs no image assets.

private let PX: CGFloat = 3 // one art pixel = 3 points

private enum Palette {
    static let map: [Character: Color] = [
        "H": Color(hex: "#FFF6E6"), // horn
        "B": Color(hex: "#E9A66B"), // hide
        "D": Color(hex: "#BD713B"), // hide shade
        "M": Color(hex: "#FFE8CF"), // muzzle
        "E": Color(hex: "#1A1512"), // eye / ink
        "R": Color(hex: "#F2C14E"), // nose ring
        "S": Color(hex: "#3B82F6"), // shirt (tinted per agent)
        "W": Color.white,
    ]
}

// 12 x 12 ox at a desk, two frames (arms down / arms up) for typing.
private let OX_HEAD = [
    "H..........H",
    "HH........HH",
    ".HDBBBBBBDH.",
    "..BBBBBBBB..",
    ".DBEBBBBEBD.",
    "..BBBBBBBB..",
    "..BMMMMMMB..",
    "..MMEMMEMM..",
    "...MMRRMM...",
    "....DBBD....",
]
private let BODY_A = [
    "..SSSSSSSS..",
    ".SSSSSSSSSS.",
]
private let BODY_B = [
    ".BSSSSSSSSB.",
    "B.SSSSSSSS.B",
]

struct AgentDesk: View {
    enum Kind { case lead, sub }
    let name: String
    let detail: String
    let model: String
    let tokens: Int
    let phase: SubAgent.Phase
    let tint: Color
    var kind: Kind = .sub

    var body: some View {
        VStack(spacing: 3) {
            TimelineView(.animation(minimumInterval: 1 / 12)) { ctx in
                let t = ctx.date.timeIntervalSinceReferenceDate
                Canvas { g, size in draw(&g, size: size, t: t) }
            }
            .frame(width: 84, height: 66)
            Text(name)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(Ink.text)
                .lineLimit(1)
            Text(detail)
                .font(.system(size: 9.5, design: .monospaced))
                .foregroundStyle(phase == .failed ? Ink.red : phase == .done ? Ink.green : Ink.muted)
                .lineLimit(1)
            Text(tokenText)
                .font(.system(size: 9).monospacedDigit())
                .foregroundStyle(Ink.dim)
                .lineLimit(1)
        }
        .frame(width: 92)
    }

    private var tokenText: String {
        let m = model.isEmpty ? "" : String(model.prefix(14))
        guard tokens > 0 else { return m }
        let tk = tokens >= 1000 ? String(format: "%.1fk", Double(tokens) / 1000) : "\(tokens)"
        return m.isEmpty ? "\(tk) tok" : "\(m) · \(tk)"
    }

    private func sprite(_ g: inout GraphicsContext, _ rows: [String], x: CGFloat, y: CGFloat, shirt: Color) {
        for (r, row) in rows.enumerated() {
            for (c, ch) in row.enumerated() where ch != "." {
                let color = ch == "S" ? shirt : (Palette.map[ch] ?? .clear)
                g.fill(Path(CGRect(x: x + CGFloat(c) * PX, y: y + CGFloat(r) * PX, width: PX, height: PX)), with: .color(color))
            }
        }
    }

    private func draw(_ g: inout GraphicsContext, size: CGSize, t: Double) {
        let working = phase == .working || phase == .starting
        // Floor shadow + desk.
        g.fill(Path(roundedRect: CGRect(x: 6, y: 52, width: 72, height: 8), cornerRadius: 2), with: .color(Color(hex: "#5B3A24")))
        g.fill(Path(CGRect(x: 10, y: 60, width: 4, height: 6)), with: .color(Color(hex: "#3D2718")))
        g.fill(Path(CGRect(x: 70, y: 60, width: 4, height: 6)), with: .color(Color(hex: "#3D2718")))
        // Monitor: screen glows with the agent's colour while it works.
        g.fill(Path(roundedRect: CGRect(x: 46, y: 24, width: 30, height: 22), cornerRadius: 2), with: .color(Color(hex: "#22252B")))
        let glow = working ? 0.55 + 0.35 * abs(sin(t * 3)) : phase == .done ? 0.35 : 0.12
        g.fill(Path(CGRect(x: 49, y: 27, width: 24, height: 16)), with: .color(tint.opacity(glow)))
        if working {
            // Scrolling "code" lines.
            for i in 0..<4 {
                let w = CGFloat(6 + (Int(t * 6) + i * 3) % 14)
                g.fill(Path(CGRect(x: 51, y: 29 + CGFloat(i) * 3.5, width: w, height: 1.6)), with: .color(.white.opacity(0.7)))
            }
        }
        g.fill(Path(CGRect(x: 59, y: 46, width: 4, height: 6)), with: .color(Color(hex: "#22252B")))

        // The ox, bobbing while it types, still while it thinks.
        let bob: CGFloat = working ? (Int(t * 6) % 2 == 0 ? 0 : 1) : 0
        let ox = CGFloat(8), oy = CGFloat(10) + bob
        sprite(&g, OX_HEAD, x: ox, y: oy, shirt: tint)
        sprite(&g, (working && Int(t * 6) % 2 == 0) ? BODY_B : BODY_A, x: ox, y: oy + 10 * PX, shirt: tint)
        if kind == .lead {
            // A tiny crown marks the lead agent.
            g.fill(Path(CGRect(x: ox + 4 * PX, y: oy - 2 * PX, width: 4 * PX, height: PX)), with: .color(Palette.map["R"]!))
            g.fill(Path(CGRect(x: ox + 4 * PX, y: oy - 3 * PX, width: PX, height: PX)), with: .color(Palette.map["R"]!))
            g.fill(Path(CGRect(x: ox + 7 * PX, y: oy - 3 * PX, width: PX, height: PX)), with: .color(Palette.map["R"]!))
        }

        // Status mark above the head.
        switch phase {
        case .thinking:
            let n = Int(t * 3) % 4
            for i in 0..<n { g.fill(Path(ellipseIn: CGRect(x: 30 + CGFloat(i) * 5, y: 4, width: 3, height: 3)), with: .color(.white.opacity(0.8))) }
        case .done:
            var p = Path()
            p.move(to: CGPoint(x: 30, y: 7)); p.addLine(to: CGPoint(x: 34, y: 11)); p.addLine(to: CGPoint(x: 42, y: 2))
            g.stroke(p, with: .color(Ink.green), lineWidth: 2.4)
        case .failed:
            g.fill(Path(CGRect(x: 34, y: 1, width: 3, height: 7)), with: .color(Ink.red))
            g.fill(Path(CGRect(x: 34, y: 10, width: 3, height: 3)), with: .color(Ink.red))
        default:
            break
        }
    }
}

struct PixelOffice: View {
    @ObservedObject var bridge: OxBridge
    let session: AgentSession

    private static let tints = ["#3B82F6", "#EC4899", "#10B981", "#F59E0B", "#8B5CF6", "#06B6D4", "#EF4444"]

    var body: some View {
        let working = session.agents.filter { $0.endedAt == nil }.count
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("Office").font(.system(size: 12, weight: .semibold)).foregroundStyle(Ink.text)
                Text("\(working) working, \(session.agents.count - working) finished")
                    .font(.system(size: 11)).foregroundStyle(Ink.muted)
                Spacer()
                Text(teamTokens).font(.system(size: 11).monospacedDigit()).foregroundStyle(Ink.dim)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 4) {
                    AgentDesk(name: "lead", detail: session.activity, model: session.model,
                              tokens: session.tokensIn + session.tokensOut,
                              phase: leadPhase, tint: Color(hex: bridge.color(of: session)), kind: .lead)
                    ForEach(Array(session.agents.enumerated()), id: \.element.id) { i, a in
                        AgentDesk(name: a.label, detail: detail(a), model: a.model, tokens: a.tokens,
                                  phase: a.phase, tint: Color(hex: Self.tints[(i + 1) % Self.tints.count]))
                    }
                }
            }
        }
    }

    private var leadPhase: SubAgent.Phase {
        switch session.mood {
        case .working: return .working
        case .done: return .done
        case .error: return .failed
        default: return .thinking
        }
    }

    private func detail(_ a: SubAgent) -> String {
        switch a.phase {
        case .starting: return "starting"
        case .working: return a.tool.isEmpty ? "working" : a.tool
        case .thinking: return "thinking"
        case .done: return a.costUsd > 0 ? String(format: "done $%.3f", a.costUsd) : "done"
        case .failed: return "failed"
        }
    }

    private var teamTokens: String {
        let total = session.tokensIn + session.tokensOut + session.agents.reduce(0) { $0 + $1.tokens }
        return total >= 1000 ? String(format: "%.1fk tokens", Double(total) / 1000) : "\(total) tokens"
    }
}
