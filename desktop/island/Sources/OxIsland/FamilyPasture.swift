import SwiftUI
import AppKit

/// The herd on the pasture when nothing is running: the elder (the first ox),
/// the ox, and its friends Puff, Pebble and Dot. Each one lives its own day:
/// wanders, grazes, walks to the trough to drink, plays with another (head-butts,
/// then a chase), naps, gets the zoomies. A friend standing in for a working
/// agent session is away at work, so the pasture also says who is busy.
final class Herd {
    static let shared = Herd()

    enum Act: Equatable { case wander, graze, drink, play, nap, run, stand, look, hop }

    struct Member: Identifiable {
        let id: String
        let name: String
        let folder: String       // Resources/<folder>/<cycle>
        let size: CGFloat        // relative height
        let napper: Double       // how much it likes to nap
        var x: CGFloat           // 0…1 across the pasture
        var lane: CGFloat        // 0 back … 1 front
        var right = true
        var act: Act = .graze
        var until: Double = 0
        var target: CGFloat = 0.5
        var partner: String?
        var bubble: String?
        var bubbleUntil: Double = 0
        var phase = Double.random(in: 0...10)
    }

    private(set) var members: [Member] = [
        Member(id: "elder", name: "Elder", folder: "family/elder", size: 1.08, napper: 2.0, x: 0.18, lane: 0.15),
        Member(id: "ox", name: "Ox", folder: "ox", size: 1.0, napper: 1.0, x: 0.42, lane: 0.7),
        Member(id: "puff", name: "Puff", folder: "friends/puff", size: 0.82, napper: 1.0, x: 0.6, lane: 0.35),
        Member(id: "pebble", name: "Pebble", folder: "friends/pebble", size: 0.8, napper: 0.6, x: 0.3, lane: 0.9),
        Member(id: "dot", name: "Dot", folder: "friends/dot", size: 0.8, napper: 0.8, x: 0.75, lane: 0.6),
    ]
    /// Where the water is.
    static let trough: CGFloat = 0.86
    private var last: Double?

    /// The cycle folder to draw, falling back to what this member has.
    static func frames(_ m: Member, _ t: Double) -> [NSImage] {
        let want: [String]
        switch m.act {
        case .wander: want = ["walk"]
        case .graze: want = ["graze"]
        case .drink: want = ["drink", "graze"]
        case .play: want = ["play", "kick", "alert"]
        case .nap: want = ["doze", "idle"]
        case .run: want = ["gallop", "walk"]
        case .stand: want = ["idle"]
        case .look: want = ["look", "idle"]
        case .hop: want = ["happy", "alert", "kick"]
        }
        for w in want { let f = Frames.load("\(m.folder)/\(w)"); if !f.isEmpty { return f } }
        return Frames.load("\(m.folder)/idle")
    }

    /// Who is at work: friends standing in for running sessions (same pick as the session pills).
    func away(_ sessions: [AgentSession]) -> Set<String> {
        var out = Set<String>()
        for s in sessions {
            switch s.mood { case .working, .thinking, .needsYou: out.insert(SessionCharacter.friend(for: s.id)); default: break }
        }
        return out
    }

    func poke(_ id: String, now t: Double) {
        guard let i = members.firstIndex(where: { $0.id == id }) else { return }
        let lines = members[i].act == .nap ? ["zzz… what?", "five more minutes"] : members[i].act == .drink ? ["slurp!", "glug glug"] : ["\(members[i].name)!", "moo!", "hi!", "♥"]
        members[i].act = .hop
        members[i].until = t + 1.2
        members[i].bubble = lines.randomElement()
        members[i].bubbleUntil = t + 1.8
    }

    func step(now t: Double, away: Set<String>) {
        let dt = min(0.15, max(0, t - (last ?? t)))
        last = t
        for i in members.indices {
            if away.contains(members[i].id) { continue }
            var m = members[i]
            let speed: CGFloat = m.act == .run ? 0.16 : 0.045
            if m.act == .wander || m.act == .run || (m.act == .drink && abs(m.x - Self.trough) > 0.03) || (m.act == .play && m.partner != nil && t < m.until - 2.2) {
                // Moving: to the target (the trough, a friend, a spot).
                if m.act == .play, let p = members.first(where: { $0.id == m.partner }) { m.target = p.x + (p.x > m.x ? -0.09 : 0.09) }
                if m.act == .drink { m.target = Self.trough - (members.prefix(i).contains { $0.act == .drink } ? 0.06 : 0) }
                let d = m.target - m.x
                if abs(d) > 0.01 { m.right = d > 0; m.x += max(-speed * CGFloat(dt), min(speed * CGFloat(dt), d)) }
                else if m.act == .wander || m.act == .run { m.until = min(m.until, t) }
            }
            if m.act == .play, let p = members.first(where: { $0.id == m.partner }) { if abs(p.x - m.x) < 0.12 { m.right = p.x > m.x } }
            if t >= m.until { choose(&m, i: i, t: t, away: away) }
            // Personal space: two standing on one spot drift apart (playing pairs and drinkers excepted).
            if ![.play, .drink, .run].contains(m.act) {
                for (j, o) in members.enumerated() where j != i && !away.contains(o.id) && abs(o.x - m.x) < 0.07 && abs(o.lane - m.lane) < 0.35 {
                    let push: CGFloat = (m.x <= o.x ? -1 : 1) * 0.03 * CGFloat(dt)
                    m.x += push
                    if m.act == .graze || m.act == .stand { m.lane = min(1, max(0, m.lane + (m.lane <= o.lane ? -0.2 : 0.2) * CGFloat(dt))) }
                }
            }
            m.x = min(0.97, max(0.03, m.x))
            members[i] = m
        }
    }

    private func choose(_ m: inout Member, i: Int, t: Double, away: Set<String>) {
        // After a play: the chase (one runs off, the other follows).
        if m.act == .play, let pid = m.partner {
            m.partner = nil
            m.act = .run
            m.target = m.x < 0.5 ? CGFloat.random(in: 0.65...0.95) : CGFloat.random(in: 0.05...0.35)
            m.until = t + 4
            if pid < m.id, let j = members.firstIndex(where: { $0.id == pid }) { members[j].act = .run; members[j].target = m.target + (m.target > 0.5 ? -0.1 : 0.1); members[j].until = t + 4.5; members[j].partner = nil }
            return
        }
        let pick: [(Act, Double)] = [(.wander, 26), (.graze, 26), (.drink, 9), (.play, 11), (.nap, 7 * m.napper), (.run, 5), (.stand, 9), (.look, 8)]
        var r = Double.random(in: 0..<pick.reduce(0) { $0 + $1.1 })
        var next: Act = .graze
        for (a, w) in pick { if r < w { next = a; break }; r -= w }
        m.partner = nil
        switch next {
        case .play:
            // A friend who is free (not napping, not away) joins in.
            let free = members.enumerated().filter { $0.offset != i && !away.contains($0.element.id) && [.graze, .stand, .look, .wander].contains($0.element.act) }
            guard let (j, other) = free.randomElement() else { m.act = .graze; m.until = t + 5; return }
            m.act = .play; m.partner = other.id; m.until = t + 5
            members[j].act = .play; members[j].partner = m.id; members[j].until = t + 5.2
            members[j].bubble = ["!", "♪", "come on!"].randomElement(); members[j].bubbleUntil = t + 1.4
        case .wander, .run:
            m.act = next; m.target = CGFloat.random(in: 0.05...0.95); m.until = t + (next == .run ? 4 : 9)
            if Double.random(in: 0...1) < 0.25 { m.lane = CGFloat.random(in: 0...1) }
        case .drink:
            // Two at the trough at a time; the rest graze nearby and wait their turn.
            if members.filter({ $0.act == .drink }).count >= 2 { m.act = .wander; m.target = CGFloat.random(in: 0.45...0.75); m.until = t + 6; return }
            m.act = .drink; m.until = t + 12
        case .nap:
            m.act = .nap; m.until = t + Double.random(in: 12...25)
            m.bubble = "z"; m.bubbleUntil = t + 3
        default:
            m.act = next; m.until = t + Double.random(in: 4...9)
        }
    }
}

/// The pasture drawn in a card: grass, a trough, flowers, the herd by depth.
struct HerdScene: View {
    /// Screenshots: show the pasture even while sessions run (OX_ISLAND_DEMO=herd).
    static var demo = false
    @ObservedObject var bridge: OxBridge
    let herd = Herd.shared

    var body: some View {
        GeometryReader { geo in
            TimelineView(.animation(minimumInterval: 1 / 12)) { tl in
                let t = tl.date.timeIntervalSinceReferenceDate
                let away = Self.demo ? Set<String>() : herd.away(bridge.sessions)
                let _ = herd.step(now: t, away: away)
                let w = geo.size.width, h = geo.size.height
                ZStack(alignment: .topLeading) {
                    // The grass: a soft horizon and a few tufts and flowers.
                    LinearGradient(colors: [Color(hex: "#1B2A1E").opacity(0), Color(hex: "#20402A").opacity(0.55)], startPoint: .top, endPoint: .bottom)
                        .frame(height: h * 0.62).offset(y: h * 0.38)
                    ForEach(0..<9, id: \.self) { k in
                        let fx = CGFloat((k * 37 + 11) % 100) / 100
                        Text(k % 3 == 0 ? "✿" : "ˬ").font(.system(size: k % 3 == 0 ? 7 : 9)).foregroundStyle(k % 3 == 0 ? Color(hex: "#F5D0FE").opacity(0.55) : Color(hex: "#4ADE80").opacity(0.35))
                            .position(x: fx * w, y: h * (0.62 + CGFloat(k % 4) * 0.09))
                    }
                    trough(w: w, h: h, t: t)
                    ForEach(herd.members.filter { !away.contains($0.id) }.sorted { $0.lane < $1.lane }) { m in
                        member(m, w: w, h: h, t: t)
                    }
                    if !away.isEmpty {
                        Text("\(herd.members.filter { away.contains($0.id) }.map(\.name).joined(separator: ", ")) \(T("at work"))")
                            .font(.system(size: 9, weight: .medium)).foregroundStyle(HomeInk.faint)
                            .padding(.horizontal, 6).padding(.vertical, 2).background(Capsule().fill(Color.black.opacity(0.35)))
                            .position(x: w - 52, y: 10)
                    }
                }
            }
        }
        .clipped()
    }

    private func trough(w: CGFloat, h: CGFloat, t: Double) -> some View {
        let tw = min(46, w * 0.13)
        return ZStack {
            RoundedRectangle(cornerRadius: 3).fill(Color(hex: "#7C5A3A")).frame(width: tw, height: 9)
            RoundedRectangle(cornerRadius: 2).fill(LinearGradient(colors: [Color(hex: "#7DD3FC"), Color(hex: "#38BDF8")], startPoint: .leading, endPoint: .trailing))
                .frame(width: tw - 6, height: 3).offset(y: -2.5)
                .opacity(0.8 + 0.2 * sin(t * 3))
        }
        .position(x: Herd.trough * w + 6, y: h * 0.8)
    }

    private func member(_ m: Herd.Member, w: CGFloat, h: CGFloat, t: Double) -> some View {
        let frames = Herd.frames(m, t)
        let depth = 0.72 + 0.28 * m.lane
        let ht = h * 0.5 * m.size * depth
        let y = h * (0.5 + 0.34 * m.lane)
        return ZStack {
            if !frames.isEmpty {
                Image(nsImage: frames[Int((t + m.phase) * 12) % frames.count]).resizable().interpolation(.high)
                    .frame(width: ht * 4 / 3, height: ht)
                    .scaleEffect(x: m.right ? 1 : -1, y: 1)
                    .opacity(0.75 + 0.25 * depth)
            }
            if let b = m.bubble, t < m.bubbleUntil {
                Text(b).font(.system(size: 9, weight: .semibold)).foregroundStyle(.black)
                    .padding(.horizontal, 5).padding(.vertical, 1).background(Capsule().fill(Color.white.opacity(0.92)))
                    .offset(y: -ht * 0.62)
            }
        }
        .position(x: m.x * w, y: y)
        .onTapGesture { herd.poke(m.id, now: Date().timeIntervalSinceReferenceDate) }
        .help(m.name)
    }
}
