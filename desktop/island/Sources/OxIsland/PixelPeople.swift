import SwiftUI

// The pixel cast (art/CHARACTERS.md): original Pixel-Agents-style people
// composed from layered string sprites in Resources/pixel/people.json, which
// art/pixel_people.py writes and previews. Same layers, same order, same
// 1-px outline here, so what the preview shows is what the island draws.

enum PixelDir: String { case front, side, back }

struct PixelPose: Hashable {
    var dir: PixelDir = .front
    var pose = "stand"
    var frame = 0
    var mouth = "rest"
    var blink = false
}

enum PixelCast {
    /// Helpers in delegation order; the farmer only visits the pasture.
    static let helpers = ["mira", "theo", "ade", "lin", "sol", "rui"]

    private struct Spec {
        let heads: [String: [String]]
        let eyes: [String: [String: [String]]]
        let mouths: [String: [String: [String]]]
        let hair: [String: [String: [String]]]
        let acc: [String: [String: [String]]]
        let bodies: [String: [String: [[String]]]]
        let people: [String: [String: Any]]
        let shared: [String: String]
    }

    private static let spec: Spec? = {
        guard let url = Bundle.module.url(forResource: "people", withExtension: "json", subdirectory: "Resources/pixel"),
              let data = try? Data(contentsOf: url),
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        func layers(_ k: String) -> [String: [String: [String]]] { j[k] as? [String: [String: [String]]] ?? [:] }
        return Spec(heads: j["heads"] as? [String: [String]] ?? [:], eyes: layers("eyes"), mouths: layers("mouths"),
                    hair: layers("hair"), acc: layers("acc"), bodies: j["bodies"] as? [String: [String: [[String]]]] ?? [:],
                    people: j["people"] as? [String: [String: Any]] ?? [:], shared: j["shared"] as? [String: String] ?? [:])
    }()

    static var available: Bool { spec != nil }
    static func has(_ person: String) -> Bool { spec?.people[person] != nil }

    static func frames(_ dir: PixelDir, _ pose: String) -> Int { spec?.bodies[dir.rawValue]?[pose]?.count ?? 1 }

    private static var gridCache: [String: [[Character]]] = [:]

    /// The composed 16 x 24 grid of colour codes ("." = empty).
    static func grid(_ person: String, _ p: PixelPose) -> [[Character]] {
        let key = "\(person)|\(p.dir.rawValue)|\(p.pose)|\(p.frame)|\(p.mouth)|\(p.blink)"
        if let g = gridCache[key] { return g }
        guard let s = spec, let who = s.people[person] else { return [] }
        var g = Array(repeating: Array(repeating: Character("."), count: 16), count: 24)
        func stamp(_ layer: [String]?) {
            guard let layer else { return }
            for (y, row) in layer.enumerated() where y < 24 {
                for (x, ch) in row.enumerated() where x < 16 && ch != "." { g[y][x] = ch }
            }
        }
        let d = p.dir.rawValue
        let face = p.dir == .side ? "side" : "front"
        let bodies = s.bodies[d]?[p.pose] ?? s.bodies[d]?["stand"] ?? []
        if !bodies.isEmpty { stamp(bodies[p.frame % bodies.count]) }
        stamp(s.heads[d])
        if p.dir != .back {
            stamp(s.eyes[face]?[p.blink ? "blink" : "open"])
            stamp(s.mouths[face]?[p.mouth] ?? s.mouths[face]?["rest"])
        }
        stamp(s.hair[who["style"] as? String ?? "short"]?[d])
        for a in who["acc"] as? [String] ?? [] { stamp(s.acc[a]?[d]) }
        gridCache[key] = g
        return g
    }

    private static var colourCache: [String: [Character: Color]] = [:]

    static func colours(_ person: String) -> [Character: Color] {
        if let c = colourCache[person] { return c }
        guard let s = spec, let p = s.people[person] else { return [:] }
        func c(_ k: String, _ fallback: String = "#FF00FF") -> Color { Color(hex: (p[k] as? String) ?? s.shared[k] ?? fallback) }
        let map: [Character: Color] = [
            "s": c("skin"), "S": c("skinShade"), "h": c("hair"), "H": c("hairLight"), "d": c("hairDark"),
            "c": c("shirt"), "C": c("shirtShade"), "p": c("pants"), "P": c("pants"), "k": c("shoes"),
            "e": c("eye"), "m": c("mouth"), "t": c("teeth"), "r": c("tongue"), "b": c("blush"), "g": c("glasses"),
            "y": c("hat", "#E9C27B"), "Y": c("hatBand", "#B5462F"), "o": c("pants"), "w": c("white"),
        ]
        colourCache[person] = map
        return map
    }

    static var outline: Color { Color(hex: spec?.shared["outline"] ?? "#1A1214") }

    /// Draw one sprite with its outline. `px` is points per art pixel; the
    /// sprite is 18 x 26 art pixels including the outline.
    static func draw(_ ctx: inout GraphicsContext, _ person: String, _ pose: PixelPose, at origin: CGPoint, px: CGFloat, flip: Bool = false) {
        let g = grid(person, pose)
        guard !g.isEmpty else { return }
        let map = colours(person)
        func filled(_ x: Int, _ y: Int) -> Bool { y >= 0 && y < 24 && x >= 0 && x < 16 && g[y][x] != "." }
        func rect(_ x: Int, _ y: Int) -> CGRect {
            let col = flip ? 15 - x : x
            return CGRect(x: origin.x + CGFloat(col + 1) * px, y: origin.y + CGFloat(y + 1) * px, width: px + 0.3, height: px + 0.3)
        }
        let line = outline
        for y in -1...24 {
            for x in -1...16 where !filled(x, y) {
                if filled(x + 1, y) || filled(x - 1, y) || filled(x, y + 1) || filled(x, y - 1) {
                    ctx.fill(Path(rect(x, y)), with: .color(line))
                }
            }
        }
        for y in 0..<24 {
            for x in 0..<16 where g[y][x] != "." {
                ctx.fill(Path(rect(x, y)), with: .color(map[g[y][x]] ?? .pink))
            }
        }
    }
}

/// One pixel person, sized by height (the outline included).
struct PixelPersonView: View {
    let person: String
    var pose = PixelPose()
    var flip = false
    var height: CGFloat

    var body: some View {
        let px = height / 26
        Canvas { ctx, _ in PixelCast.draw(&ctx, person, pose, at: .zero, px: px, flip: flip) }
            .frame(width: px * 18, height: height)
            .accessibilityHidden(true)
    }
}

/// A pixel helper walking back and forth in a lane: the notch crew.
struct PixelWalker: View {
    let person: String
    let height: CGFloat
    var phaseOffset: Double = 0

    var body: some View {
        GeometryReader { geo in
            TimelineView(.animation(minimumInterval: 1.0 / 12.0)) { ctx in
                let t = ctx.date.timeIntervalSinceReferenceDate + phaseOffset
                let w = height * 18 / 26
                let lane = max(0, geo.size.width - w)
                let speed = max(10, height * 0.8)
                let period = lane > 2 ? Double(lane / speed) : 1
                let leg = t.truncatingRemainder(dividingBy: 2 * period)
                let right = leg < period
                let x = lane > 2 ? CGFloat(right ? leg / period : 2 - leg / period) * lane : 0
                PixelPersonView(person: person, pose: PixelPose(dir: .side, pose: "walk", frame: Int(t * 8) % 4), flip: !right, height: height)
                    .offset(x: x)
                    .frame(width: geo.size.width, height: geo.size.height, alignment: .bottomLeading)
            }
        }
        .frame(height: height)
    }
}
