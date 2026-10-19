import SwiftUI
import AppKit

/// The Meadow (docs/HERD_SCRIPT.md): the elder (the first ox), the ox, its
/// friends Puff, Pebble and Dot, and Maple the messenger live in a little
/// forest inside the card when nothing needs you. Each lives its own day
/// (wander, graze, drink at the pond, play and chase, nap, explore behind the
/// trees), and the meadow answers what is happening on the island: music,
/// a question waiting, a run done or failed, a plan near its limit, mail or an
/// alert (Maple brings it), night, rain.
final class Herd {
    static let shared = Herd()

    enum Act: Equatable { case wander, graze, drink, play, nap, run, stand, look, hop, explore, dizzy, worried, deliver }

    struct Member: Identifiable {
        let id: String
        let name: String
        let folder: String       // Resources/<folder>/<cycle>
        let size: CGFloat        // relative height
        let napper: Double       // how much it likes to nap
        let player: Double       // how much it likes to play
        let drinker: Double      // how much it likes the pond
        var x: CGFloat           // 0…1 across the meadow
        var lane: CGFloat        // 0 back … 1 front
        var right = true
        var act: Act = .graze
        var until: Double = 0
        var target: CGFloat = 0.5
        var partner: String?
        var bubble: String?
        var bubbleUntil: Double = 0
        var phase = Double.random(in: 0...10)
        var hidden = false       // behind the far trees, exploring
    }

    /// What is going on, read from the island each frame.
    struct World: Equatable {
        var music = false
        var waiting = false      // an approval or a question
        var done = false
        var failed = false
        var stressed = false     // a plan past 80 %
        var night = false
        var rain = false
        var snow = false
        var news: String? = nil  // what Maple brings (mail, an alert, a hire)
    }

    private(set) var members: [Member] = [
        Member(id: "elder", name: "Elder", folder: "family/elder", size: 1.08, napper: 2.0, player: 0.4, drinker: 1.0, x: 0.18, lane: 0.15),
        Member(id: "ox", name: "Ox", folder: "ox", size: 1.0, napper: 1.0, player: 1.0, drinker: 1.0, x: 0.42, lane: 0.7),
        Member(id: "puff", name: "Puff", folder: "friends/puff", size: 0.82, napper: 1.0, player: 1.0, drinker: 1.0, x: 0.6, lane: 0.35),
        Member(id: "pebble", name: "Pebble", folder: "friends/pebble", size: 0.8, napper: 0.6, player: 1.8, drinker: 0.8, x: 0.3, lane: 0.9),
        Member(id: "dot", name: "Dot", folder: "friends/dot", size: 0.8, napper: 0.8, player: 1.0, drinker: 1.8, x: 0.75, lane: 0.6),
        Member(id: "maple", name: "Maple", folder: "friends/maple", size: 0.9, napper: 0.8, player: 1.2, drinker: 1.0, x: 0.08, lane: 0.5),
    ]
    /// Where the water is, and where the trees give shelter.
    static let pond: CGFloat = 0.86
    static let shelter: [CGFloat] = [0.12, 0.5]
    private var last: Double?
    private var world = World()
    private var seenNews: String?

    /// The cycle folder to draw, falling back to what this member has.
    static func frames(_ m: Member, _ t: Double) -> [NSImage] {
        let want: [String]
        switch m.act {
        case .wander, .explore: want = ["walk"]
        case .graze: want = ["graze"]
        case .drink: want = ["drink", "graze"]
        case .play: want = ["play", "kick", "alert"]
        case .nap: want = ["doze", "idle"]
        case .run, .deliver: want = ["gallop", "walk"]
        case .stand: want = ["idle"]
        case .look: want = ["look", "idle"]
        case .hop: want = ["happy", "alert", "kick"]
        case .dizzy: want = ["dizzy", "alert"]
        case .worried: want = ["worried", "idle"]
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

    func poke(_ id: String, now t: Double) -> String? {
        guard let i = members.firstIndex(where: { $0.id == id }) else { return nil }
        if members[i].id == "maple", let n = world.news { members[i].bubble = n; members[i].bubbleUntil = t + 4; return n }
        let lines = members[i].act == .nap ? ["zzz… what?", "five more minutes"] : members[i].act == .drink ? ["slurp!", "glug glug"] : ["\(members[i].name)!", "moo!", "hi!", "♥"]
        members[i].act = .hop
        members[i].until = t + 1.2
        members[i].bubble = lines.randomElement()
        members[i].bubbleUntil = t + 1.8
        return nil
    }

    /// The island changed: the meadow reacts (each reaction a few seconds, then back to its day).
    func react(_ w: World, now t: Double, away: Set<String>) {
        let before = world
        world = w
        func all(_ act: Act, _ secs: Double, only: (Member) -> Bool = { _ in true }, say: String? = nil) {
            for i in members.indices where !away.contains(members[i].id) && only(members[i]) {
                members[i].act = act; members[i].until = t + secs + Double.random(in: 0...0.6); members[i].partner = nil; members[i].hidden = false
                if let say, i == members.indices.first(where: { !away.contains(members[$0].id) && only(members[$0]) }) { members[i].bubble = say; members[i].bubbleUntil = t + 2.5 }
            }
        }
        if w.done && !before.done { all(.hop, 2.4, say: "done!") }
        if w.failed && !before.failed { all(.dizzy, 2.5, only: { $0.id == "ox" }, say: "ouch") }
        if w.waiting && !before.waiting { all(.look, 4, say: "?") }
        if w.stressed && !before.stressed { all(.worried, 6, only: { $0.id == "elder" }, say: "that plan is nearly full") }
        if w.night && !before.night { all(.nap, 60, say: "goodnight") }
        // Morning: everyone up.
        if !w.night && before.night { all(.graze, 3, say: "morning!") }
        // Music starts: they stop and bob to it.
        if w.music && !before.music { all(.stand, 3, only: { $0.act != .nap }, say: "♪") }
        // Morning: everyone up.
        if !w.night && before.night { all(.graze, 3, say: "morning!") }
        // Music starts: they stop and bob to it.
        if w.music && !before.music { all(.stand, 3, only: { $0.act != .nap }, say: "♪") }
        if w.rain && !before.rain { for i in members.indices where !away.contains(members[i].id) { members[i].act = .wander; members[i].target = Self.shelter[i % 2] + CGFloat.random(in: -0.05...0.05); members[i].lane = 0.1; members[i].until = t + 20 } }
        // Maple brings news: gallops in from the left and stops at the front.
        if let n = w.news, n != seenNews, let i = members.firstIndex(where: { $0.id == "maple" }), !away.contains("maple") {
            seenNews = n
            members[i].x = 0.02; members[i].lane = 1; members[i].act = .deliver; members[i].target = 0.45; members[i].until = t + 8; members[i].hidden = false
        }
        if w.news == nil { seenNews = nil }
    }

    func step(now t: Double, away: Set<String>) {
        let dt = min(0.15, max(0, t - (last ?? t)))
        last = t
        for i in members.indices {
            if away.contains(members[i].id) { continue }
            var m = members[i]
            let speed: CGFloat = m.act == .run || m.act == .deliver ? 0.17 : 0.045
            if [.wander, .run, .explore, .deliver].contains(m.act) || (m.act == .drink && abs(m.x - Self.pond) > 0.03) || (m.act == .play && m.partner != nil && t < m.until - 2.2) {
                if m.act == .play, let p = members.first(where: { $0.id == m.partner }) { m.target = p.x + (p.x > m.x ? -0.09 : 0.09) }
                if m.act == .drink { m.target = Self.pond - (members.prefix(i).contains { $0.act == .drink } ? 0.06 : 0) }
                let d = m.target - m.x
                if abs(d) > 0.01 { m.right = d > 0; m.x += max(-speed * CGFloat(dt), min(speed * CGFloat(dt), d)) }
                else if m.act == .deliver { m.act = .stand; m.until = t + 10; m.right = true; if let n = world.news { m.bubble = n; m.bubbleUntil = t + 6 } }
                else if m.act == .explore { m.hidden = true; m.act = .stand; m.until = t + Double.random(in: 4...8) }
                else if (m.act == .wander || m.act == .run) && world.rain && Self.shelter.contains(where: { abs($0 - m.x) < 0.12 }) { m.act = .stand; m.until = t + Double.random(in: 6...12) }
                else if (m.act == .wander || m.act == .run) && world.rain && Self.shelter.contains(where: { abs($0 - m.x) < 0.12 }) { m.act = .stand; m.until = t + Double.random(in: 6...12) }
                else if m.act == .wander || m.act == .run { m.until = min(m.until, t) }
            }
            if m.act == .play, let p = members.first(where: { $0.id == m.partner }) { if abs(p.x - m.x) < 0.12 { m.right = p.x > m.x } }
            if t >= m.until { m.hidden = false; choose(&m, i: i, t: t, away: away) }
            // Personal space: two standing on one spot drift apart.
            // Maple holds her spot while she shows her note.
            if ![.play, .drink, .run, .deliver].contains(m.act) && !(m.id == "maple" && t < m.bubbleUntil) {
                for (j, o) in members.enumerated() where j != i && !away.contains(o.id) && abs(o.x - m.x) < 0.07 && abs(o.lane - m.lane) < 0.35 {
                    m.x += (m.x <= o.x ? -1 : 1) * 0.03 * CGFloat(dt)
                    if m.act == .graze || m.act == .stand { m.lane = min(1, max(0, m.lane + (m.lane <= o.lane ? -0.2 : 0.2) * CGFloat(dt))) }
                }
            }
            m.x = min(0.97, max(0.03, m.x))
            members[i] = m
        }
    }

    private func choose(_ m: inout Member, i: Int, t: Double, away: Set<String>) {
        if world.night { m.act = .nap; m.until = t + 40; return }
        // Rain: stay under the trees (graze or stand there).
        if world.rain {
            let spot = Self.shelter.min(by: { abs($0 - m.x) < abs($1 - m.x) }) ?? 0.12
            if abs(spot - m.x) > 0.12 { m.act = .wander; m.target = spot + CGFloat.random(in: -0.06...0.06); m.lane = 0.1; m.until = t + 20 }
            else { m.act = Bool.random() ? .graze : .stand; m.until = t + Double.random(in: 6...12) }
            return
        }
        // Rain: stay under the trees (graze or stand there), a little shuffle now and then.
        if world.rain {
            let spot = Self.shelter.min(by: { abs($0 - m.x) < abs($1 - m.x) }) ?? 0.12
            if abs(spot - m.x) > 0.12 { m.act = .wander; m.target = spot + CGFloat.random(in: -0.06...0.06); m.lane = 0.1; m.until = t + 20 }
            else { m.act = Bool.random() ? .graze : .stand; m.until = t + Double.random(in: 6...12) }
            return
        }
        if m.act == .play, let pid = m.partner {
            m.partner = nil
            m.act = .run
            m.target = m.x < 0.5 ? CGFloat.random(in: 0.65...0.95) : CGFloat.random(in: 0.05...0.35)
            m.until = t + 4
            if pid < m.id, let j = members.firstIndex(where: { $0.id == pid }) { members[j].act = .run; members[j].target = m.target + (m.target > 0.5 ? -0.1 : 0.1); members[j].until = t + 4.5; members[j].partner = nil }
            return
        }
        // Music: they bob in place (stand), now and then a hop.
        if world.music, Double.random(in: 0...1) < 0.8 { m.act = Double.random(in: 0...1) < 0.25 ? .hop : .stand; m.until = t + Double.random(in: 3...6); return }
        let pick: [(Act, Double)] = [(.wander, 24), (.graze, 24), (.drink, 8 * m.drinker), (.play, 10 * m.player), (.nap, 7 * m.napper), (.run, 5), (.stand, 8), (.look, 7), (.explore, world.rain ? 0 : 5)]
        var r = Double.random(in: 0..<pick.reduce(0) { $0 + $1.1 })
        var next: Act = .graze
        for (a, w) in pick { if r < w { next = a; break }; r -= w }
        m.partner = nil
        switch next {
        case .play:
            let free = members.enumerated().filter { $0.offset != i && !away.contains($0.element.id) && [.graze, .stand, .look, .wander].contains($0.element.act) }
            guard let (j, other) = free.randomElement() else { m.act = .graze; m.until = t + 5; return }
            m.act = .play; m.partner = other.id; m.until = t + 5
            members[j].act = .play; members[j].partner = m.id; members[j].until = t + 5.2
            members[j].bubble = ["!", "♪", "come on!"].randomElement(); members[j].bubbleUntil = t + 1.4
        case .wander, .run:
            m.act = next; m.target = CGFloat.random(in: 0.05...0.95); m.until = t + (next == .run ? 4 : 9)
            if Double.random(in: 0...1) < 0.25 { m.lane = CGFloat.random(in: 0.1...1) }
        case .explore:
            // Into the trees at the back, a while out of sight, then out again.
            m.act = .explore; m.lane = 0; m.target = Self.shelter.randomElement()!; m.until = t + 16
        case .drink:
            if members.filter({ $0.act == .drink }).count >= 2 { m.act = .wander; m.target = CGFloat.random(in: 0.45...0.75); m.until = t + 6; return }
            m.act = .drink; m.until = t + 12
        case .nap:
            m.act = .nap; m.until = t + Double.random(in: 12...25)
            m.bubble = "z"; m.bubbleUntil = t + 3
        default:
            m.act = next; m.until = t + Double.random(in: 4...9)
        }
    }

    /// For tests and the script: the world as last seen.
    var current: World { world }
}

/// The Meadow drawn in a card: sky by the hour, far trees, the pond, the herd by depth, near bushes, weather.
struct HerdScene: View {
    /// Screenshots: show the meadow even while sessions run (OX_ISLAND_DEMO=herd).
    static var demo = false
    @ObservedObject var bridge: OxBridge
    let herd = Herd.shared

    private func world() -> Herd.World {
        let hour = Calendar.current.component(.hour, from: Date())
        let wx = (bridge.day.weather?.text ?? "").lowercased()
        var news: String? = nil
        if let a = bridge.meshAlerts.first { news = a.text }
        else if let h = bridge.proposedHire { news = "\(h.hiredBy) wants to hire \(h.name)" }
        else if bridge.mail.messages.count > 0 { news = "\(bridge.mail.messages.count) unread mail" }
        let mood = bridge.headlineMood
        return Herd.World(
            music: bridge.player.track?.playing == true,
            waiting: bridge.pendingSession != nil,
            done: mood == Mood.done, failed: { if case .error = mood { return true }; return false }(),
            stressed: bridge.gauges.contains { $0.percent >= 80 },
            night: hour >= 20 || hour < 5,
            rain: wx.contains("rain") || wx.contains("drizzle") || wx.contains("shower") || wx.contains("thunder"),
            snow: wx.contains("snow") || wx.contains("sleet"),
            news: news)
    }

    var body: some View {
        GeometryReader { geo in
            TimelineView(.animation(minimumInterval: 1 / 12)) { tl in
                let t = tl.date.timeIntervalSinceReferenceDate
                let away = Self.demo ? Set<String>() : herd.away(bridge.sessions)
                let w0 = world()
                let _ = herd.react(w0, now: t, away: away)
                let _ = herd.step(now: t, away: away)
                let w = geo.size.width, h = geo.size.height
                ZStack(alignment: .topLeading) {
                    sky(h: h, night: w0.night).frame(width: w, height: h)
                    if w0.night { stars(w: w, h: h, t: t) }
                    farTrees(w: w, h: h, night: w0.night)
                    LinearGradient(colors: [Color(hex: w0.night ? "#0E1A12" : "#1B2A1E").opacity(0), Color(hex: w0.night ? "#122016" : "#20402A").opacity(0.6)], startPoint: .top, endPoint: .bottom)
                        .frame(height: h * 0.6).offset(y: h * 0.4)
                    ForEach(0..<9, id: \.self) { k in
                        let fx = CGFloat((k * 37 + 11) % 100) / 100
                        Text(k % 3 == 0 ? "✿" : "ˬ").font(.system(size: k % 3 == 0 ? 7 : 9)).foregroundStyle(k % 3 == 0 ? Color(hex: "#F5D0FE").opacity(0.55) : Color(hex: "#4ADE80").opacity(0.35))
                            .position(x: fx * w, y: h * (0.64 + CGFloat(k % 4) * 0.08))
                    }
                    pond(w: w, h: h, t: t)
                    ForEach(herd.members.filter { !away.contains($0.id) && !$0.hidden }.sorted { $0.lane < $1.lane }) { m in
                        member(m, w: w, h: h, t: t, music: w0.music)
                    }
                    nearBushes(w: w, h: h, night: w0.night)
                    if !w0.rain && !w0.snow && !w0.night { birds(w: w, h: h, t: t) }
                    if w0.rain || w0.snow { weather(w: w, h: h, t: t, snow: w0.snow) }
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

    // The sky follows the clock: dawn, day, dusk, night.
    private func sky(h: CGFloat, night: Bool) -> some View {
        let hour = Calendar.current.component(.hour, from: Date())
        let (top, bottom): (String, String) = night ? ("#0B1026", "#141A33") : hour < 7 ? ("#2B2140", "#5B3A55") : hour < 18 ? ("#16324A", "#1E3A4F") : ("#3A2238", "#6B3A2E")
        return LinearGradient(colors: [Color(hex: top).opacity(0.85), Color(hex: bottom).opacity(0.35)], startPoint: .top, endPoint: .bottom)
    }

    private func stars(w: CGFloat, h: CGFloat, t: Double) -> some View {
        ZStack {
            ForEach(0..<14, id: \.self) { k in
                Circle().fill(Color.white.opacity(0.35 + 0.35 * abs(sin(t * 0.8 + Double(k)))))
                    .frame(width: k % 4 == 0 ? 2 : 1.3, height: k % 4 == 0 ? 2 : 1.3)
                    .position(x: CGFloat((k * 53 + 7) % 100) / 100 * w, y: CGFloat((k * 29 + 5) % 30) / 100 * h + 4)
            }
            Circle().fill(Color(hex: "#F5F3CE")).frame(width: 9, height: 9).position(x: w * 0.82, y: h * 0.14)
        }
    }

    // Pines and round trees along the back: the forest the herd explores.
    private func farTrees(w: CGFloat, h: CGFloat, night: Bool) -> some View {
        let shade = Color(hex: night ? "#0F2418" : "#1F4A2E")
        let light = Color(hex: night ? "#15301F" : "#2E6B42")
        return ZStack {
            ForEach(0..<9, id: \.self) { k in
                let x = (CGFloat(k) + 0.3) / 9 * w + CGFloat((k * 13) % 7) - 3
                let tall = h * (0.26 + CGFloat((k * 7) % 5) * 0.025)
                if k % 3 == 1 {
                    Circle().fill(light).frame(width: tall * 0.75, height: tall * 0.75).position(x: x, y: h * 0.47 - tall * 0.3)
                } else {
                    Triangle().fill(shade).frame(width: tall * 0.55, height: tall).position(x: x, y: h * 0.47 - tall * 0.38)
                }
                Rectangle().fill(Color(hex: "#3B2A1E")).frame(width: 2.5, height: h * 0.06).position(x: x, y: h * 0.5)
            }
        }
    }

    private func nearBushes(w: CGFloat, h: CGFloat, night: Bool) -> some View {
        let c = Color(hex: night ? "#13281A" : "#285C38")
        return ZStack {
            Ellipse().fill(c).frame(width: w * 0.16, height: h * 0.2).position(x: w * 0.03, y: h * 1.0)
            Ellipse().fill(c.opacity(0.95)).frame(width: w * 0.14, height: h * 0.17).position(x: w * 0.99, y: h * 1.0)
        }
        .allowsHitTesting(false)
    }

    private func pond(w: CGFloat, h: CGFloat, t: Double) -> some View {
        ZStack {
            Ellipse().fill(LinearGradient(colors: [Color(hex: "#38BDF8").opacity(0.75), Color(hex: "#0EA5E9").opacity(0.55)], startPoint: .top, endPoint: .bottom))
                .frame(width: min(54, w * 0.15), height: 9)
            Ellipse().stroke(Color.white.opacity(0.25 + 0.15 * sin(t * 2)), lineWidth: 0.8).frame(width: min(30, w * 0.08), height: 4)
        }
        .position(x: Herd.pond * w + 6, y: h * 0.82)
    }

    private func birds(w: CGFloat, h: CGFloat, t: Double) -> some View {
        let p = (t.truncatingRemainder(dividingBy: 24)) / 24
        return ZStack {
            ForEach(0..<2, id: \.self) { k in
                Text("︶").font(.system(size: 7, weight: .bold)).foregroundStyle(Color.white.opacity(0.55))
                    .scaleEffect(y: 0.6 + 0.4 * abs(sin(t * 7 + Double(k))))
                    .position(x: CGFloat(p) * (w + 40) - 20 + CGFloat(k) * 12, y: h * 0.16 + CGFloat(k) * 5 + 3 * CGFloat(sin(t * 2 + Double(k))))
            }
        }
        .allowsHitTesting(false)
    }

    private func weather(w: CGFloat, h: CGFloat, t: Double, snow: Bool) -> some View {
        ZStack {
            ForEach(0..<22, id: \.self) { k in
                let speed = snow ? 0.18 : 0.9
                let y = ((t * speed + Double(k) * 0.37).truncatingRemainder(dividingBy: 1)) * Double(h)
                let x = CGFloat((k * 47 + 3) % 100) / 100 * w + (snow ? CGFloat(sin(t + Double(k))) * 4 : 0)
                if snow { Circle().fill(Color.white.opacity(0.8)).frame(width: 2.2, height: 2.2).position(x: x, y: CGFloat(y)) }
                else { Capsule().fill(Color(hex: "#A5D8FF").opacity(0.55)).frame(width: 1, height: 6).position(x: x, y: CGFloat(y)) }
            }
        }
        .allowsHitTesting(false)
    }

    private func member(_ m: Herd.Member, w: CGFloat, h: CGFloat, t: Double, music: Bool) -> some View {
        let frames = Herd.frames(m, t)
        let depth = 0.72 + 0.28 * m.lane
        let ht = h * 0.48 * m.size * depth
        let y = h * (0.52 + 0.33 * m.lane)
        // To the music: a small bob on the beat while standing.
        let bob = music && m.act == .stand ? CGFloat(abs(sin(t * 4.2 + m.phase))) * -2.5 : 0
        return ZStack {
            if !frames.isEmpty {
                Image(nsImage: frames[Int((t + m.phase) * 12) % frames.count]).resizable().interpolation(.high)
                    .frame(width: ht * 4 / 3, height: ht)
                    .scaleEffect(x: m.right ? 1 : -1, y: 1)
                    .opacity(0.75 + 0.25 * depth)
                    .offset(y: bob)
            }
            if let b = m.bubble, t < m.bubbleUntil {
                Text(b).font(.system(size: 9, weight: .semibold)).foregroundStyle(.black).lineLimit(1)
                    .padding(.horizontal, 5).padding(.vertical, 1).background(Capsule().fill(Color.white.opacity(0.92)))
                    .offset(y: -ht * 0.62)
            }
        }
        .position(x: m.x * w, y: y)
        .onTapGesture {
            let news = herd.poke(m.id, now: Date().timeIntervalSinceReferenceDate)
            // Maple's note opens where it came from.
            if news != nil {
                if !bridge.meshAlerts.isEmpty || bridge.proposedHire != nil { bridge.pinnedOpen = true } else { bridge.tray = .mail; bridge.pinnedOpen = true }
            }
        }
        .help(m.name)
    }
}

struct Triangle: Shape {
    func path(in r: CGRect) -> Path { Path { p in p.move(to: CGPoint(x: r.midX, y: r.minY)); p.addLine(to: CGPoint(x: r.maxX, y: r.maxY)); p.addLine(to: CGPoint(x: r.minX, y: r.maxY)); p.closeSubpath() } }
}
