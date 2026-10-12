import SwiftUI

// OX Canvas in the notch: the same render tree ox's `show_ui` tool draws in the
// terminal (src/ui-lang.js -> tool-end meta.canvas.tree), drawn natively here.
// Buttons show their number; the user presses them in the terminal, where ox's
// approvals live.

/// One node of a canvas tree: `{type, props}` straight from the wire.
struct CanvasNode: Identifiable, Equatable {
    let id = UUID()
    /// Each drawn canvas is a new value; identity is enough to know it changed.
    static func == (a: CanvasNode, b: CanvasNode) -> Bool { a.id == b.id }
    let type: String
    let props: [String: Any]

    init?(_ any: Any?) {
        guard let d = any as? [String: Any], let t = d["type"] as? String else { return nil }
        type = t
        props = d["props"] as? [String: Any] ?? [:]
    }

    func str(_ k: String) -> String? {
        switch props[k] {
        case let s as String: return s
        case let n as NSNumber: return CanvasFormat.number(n.doubleValue)
        default: return nil
        }
    }
    func num(_ k: String) -> Double? { (props[k] as? NSNumber)?.doubleValue ?? Double(str(k) ?? "") }
    func nodes(_ k: String) -> [CanvasNode] { (props[k] as? [Any] ?? []).compactMap { CanvasNode($0) } }
    func list(_ k: String) -> [Any] { props[k] as? [Any] ?? [] }
}

enum CanvasFormat {
    static func number(_ v: Double) -> String {
        if v == v.rounded() && abs(v) < 1e15 { return NumberFormatter.localizedString(from: NSNumber(value: Int(v)), number: .decimal) }
        return String(format: "%.2f", v).replacingOccurrences(of: #"\.?0+$"#, with: "", options: .regularExpression)
    }
    static func cell(_ v: Any, type: String?) -> String {
        if let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() {
            switch type {
            case "currency": return "$" + String(format: "%.2f", n.doubleValue)
            case "percent": return number(n.doubleValue) + "%"
            default: return number(n.doubleValue)
            }
        }
        if v is NSNull { return "—" }
        return "\(v)"
    }
    static func tone(_ t: String?) -> Color {
        switch t {
        case "success": return Ink.green
        case "warning": return Ink.amber
        case "error", "danger": return Ink.red
        case "info": return Color(red: 0.47, green: 0.67, blue: 1)
        default: return Ink.muted
        }
    }
    static func statusTone(_ s: String) -> String {
        let l = s.lowercased()
        if l.range(of: "fail|error|red|down|blocked", options: .regularExpression) != nil { return "error" }
        if l.range(of: "pass|ok|done|green|up|success", options: .regularExpression) != nil { return "success" }
        if l.range(of: "warn|pending|slow|skip", options: .regularExpression) != nil { return "warning" }
        return "plain"
    }
}

/// Numbers buttons in reading order, the same order the terminal uses.
final class CanvasButtons {
    private(set) var count = 0
    func next() -> Int { count += 1; return count }
}

struct CanvasView: View {
    let root: CanvasNode

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            CanvasNodeView(node: root, buttons: CanvasButtons())
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
        }
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Ink.card)
                .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Color.white.opacity(0.05), lineWidth: 1))
        )
    }
}

struct CanvasNodeView: View {
    let node: CanvasNode
    let buttons: CanvasButtons

    var body: some View {
        switch node.type {
        case "Stack":
            VStack(alignment: .leading, spacing: node.str("gap") == "tight" ? 3 : 8) {
                ForEach(node.nodes("children")) { CanvasNodeView(node: $0, buttons: buttons) }
            }
        case "Row":
            HStack(alignment: .top, spacing: 14) {
                ForEach(node.nodes("children")) { CanvasNodeView(node: $0, buttons: buttons).frame(maxWidth: .infinity, alignment: .leading) }
            }
        case "Card":
            VStack(alignment: .leading, spacing: 6) {
                Text(node.str("title") ?? "").font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Ink.text)
                ForEach(node.nodes("children")) { CanvasNodeView(node: $0, buttons: buttons) }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white.opacity(0.04)))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(CanvasFormat.tone(node.str("tone")).opacity(node.str("tone").map { $0 == "plain" ? 0.12 : 0.55 } ?? 0.12), lineWidth: 1))
        case "Header":
            VStack(alignment: .leading, spacing: 1) {
                Text(node.str("title") ?? "").font(.system(size: 13, weight: .bold, design: .rounded)).foregroundStyle(Ink.gold)
                if let s = node.str("subtitle") { Text(s).font(.system(size: 10.5)).foregroundStyle(Ink.muted) }
            }
        case "Text":
            let style = node.str("style") ?? "body"
            Text(node.str("text") ?? "")
                .font(.system(size: style == "large" ? 13 : 11, weight: style == "strong" || style == "large" ? .semibold : .regular))
                .foregroundStyle(style == "muted" ? Ink.muted : Ink.text.opacity(0.9))
                .fixedSize(horizontal: false, vertical: true)
        case "Stat":
            VStack(alignment: .leading, spacing: 1) {
                Text(node.str("label") ?? "").font(.system(size: 10)).foregroundStyle(Ink.muted)
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text(node.str("value") ?? "—").font(.system(size: 17, weight: .bold, design: .rounded)).foregroundStyle(Ink.text).monospacedDigit()
                    if let u = node.str("unit") { Text(u).font(.system(size: 10)).foregroundStyle(Ink.muted) }
                    if let d = node.num("delta") {
                        Text("\(d >= 0 ? "▲" : "▼") \(CanvasFormat.number(abs(d)))")
                            .font(.system(size: 10, weight: .semibold)).foregroundStyle(d >= 0 ? Ink.green : Ink.red)
                    }
                }
            }
        case "Fields":
            let pairs = (node.props["pairs"] as? [String: Any] ?? [:]).sorted { $0.key < $1.key }
            VStack(alignment: .leading, spacing: 2) {
                ForEach(pairs, id: \.key) { k, v in
                    HStack(spacing: 8) {
                        Text(k).font(.system(size: 10.5)).foregroundStyle(Ink.muted).frame(width: 90, alignment: .leading)
                        Text(CanvasFormat.cell(v, type: nil)).font(.system(size: 10.5)).foregroundStyle(Ink.text).lineLimit(1)
                    }
                }
            }
        case "Table": CanvasTable(cols: node.nodes("columns").filter { $0.type == "Col" })
        case "BarChart": CanvasBars(node: node)
        case "Sparkline": CanvasSpark(node: node)
        case "Progress":
            let max = node.num("max") ?? 100
            let frac = Swift.max(0, Swift.min(1, (node.num("value") ?? 0) / (max == 0 ? 100 : max)))
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(node.str("label") ?? "").font(.system(size: 10.5)).foregroundStyle(Ink.text)
                    Spacer()
                    Text("\(Int((frac * 100).rounded()))%").font(.system(size: 10.5, weight: .semibold)).foregroundStyle(Ink.muted).monospacedDigit()
                }
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.white.opacity(0.08))
                        Capsule().fill(LinearGradient(colors: [Ink.gold, Ink.gold.opacity(0.7)], startPoint: .leading, endPoint: .trailing))
                            .frame(width: g.size.width * frac)
                    }
                }
                .frame(height: 5)
            }
        case "List":
            let ordered = (node.props["ordered"] as? Bool) == true
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(node.list("items").prefix(12).enumerated()), id: \.offset) { i, it in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(ordered ? "\(i + 1)." : "•").font(.system(size: 10.5)).foregroundStyle(Ink.dim)
                        Text(CanvasFormat.cell(it, type: nil)).font(.system(size: 10.5)).foregroundStyle(Ink.text.opacity(0.9)).lineLimit(1)
                    }
                }
            }
        case "Callout":
            let tone = CanvasFormat.tone(node.str("tone"))
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5).fill(tone).frame(width: 3)
                VStack(alignment: .leading, spacing: 1) {
                    Text(node.str("title") ?? "").font(.system(size: 11, weight: .semibold)).foregroundStyle(Ink.text)
                    if let t = node.str("text") { Text(t).font(.system(size: 10.5)).foregroundStyle(Ink.muted).fixedSize(horizontal: false, vertical: true) }
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        case "Badge":
            Text(node.str("text") ?? "").font(.system(size: 10, weight: .semibold))
                .padding(.horizontal, 7).padding(.vertical, 2)
                .background(Capsule().fill(CanvasFormat.tone(node.str("tone")).opacity(0.22)))
                .foregroundStyle(CanvasFormat.tone(node.str("tone")) == Ink.muted ? Ink.text : CanvasFormat.tone(node.str("tone")))
        case "Code", "Diff":
            let src = node.str(node.type == "Code" ? "code" : "diff") ?? ""
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(src.split(separator: "\n", omittingEmptySubsequences: false).prefix(10).enumerated()), id: \.offset) { _, line in
                    Text(String(line)).font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(node.type == "Diff" ? diffColor(String(line)) : Ink.text.opacity(0.85)).lineLimit(1)
                }
            }
            .padding(8)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.35)))
        case "Divider": Rectangle().fill(Color.white.opacity(0.08)).frame(height: 1)
        case "Button": CanvasButton(node: node, n: buttons.next())
        case "Buttons":
            HStack(spacing: 8) { ForEach(node.nodes("buttons")) { CanvasNodeView(node: $0, buttons: buttons) } }
        case "Select":
            HStack(spacing: 6) {
                Text(node.str("name") ?? "").font(.system(size: 10.5)).foregroundStyle(Ink.muted)
                ForEach(node.nodes("options")) { o in
                    let n = buttons.next()
                    let on = "\(o.props["value"] ?? "")" == "\(node.props["value"] ?? "")"
                    Text("\(n) \(o.str("label") ?? o.str("value") ?? "")")
                        .font(.system(size: 10.5, weight: on ? .semibold : .regular))
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Capsule().fill(on ? Ink.gold.opacity(0.25) : Color.white.opacity(0.06)))
                        .foregroundStyle(on ? Ink.gold : Ink.text.opacity(0.8))
                }
            }
        default: EmptyView()
        }
    }

    private func diffColor(_ l: String) -> Color {
        if l.hasPrefix("+"), !l.hasPrefix("+++") { return Ink.green }
        if l.hasPrefix("-"), !l.hasPrefix("---") { return Ink.red }
        if l.hasPrefix("@@") { return Color(red: 0.47, green: 0.67, blue: 1) }
        return Ink.muted
    }
}

struct CanvasButton: View {
    let node: CanvasNode
    let n: Int
    var body: some View {
        let tone = node.str("tone")
        HStack(spacing: 5) {
            Text("\(n)").font(.system(size: 9.5, weight: .bold, design: .rounded))
                .frame(width: 15, height: 15).background(Circle().fill(Color.white.opacity(0.12)))
            Text(node.str("label") ?? "").font(.system(size: 11, weight: .semibold))
        }
        .padding(.leading, 4).padding(.trailing, 10).padding(.vertical, 3)
        .background(Capsule().fill(tone == "primary" ? Color.white : tone == "danger" ? Ink.red.opacity(0.25) : Color.white.opacity(0.08)))
        .foregroundStyle(tone == "primary" ? Color.black : tone == "danger" ? Ink.red : Ink.text)
        .help("Type \(n) in the ox terminal to press this")
    }
}

struct CanvasTable: View {
    let cols: [CanvasNode]
    var body: some View {
        let rows = min(8, cols.map { $0.list("values").count }.max() ?? 0)
        Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 3) {
            GridRow {
                ForEach(cols) { c in Text(c.str("label") ?? "").font(.system(size: 10, weight: .semibold)).foregroundStyle(Ink.muted) }
            }
            Divider().overlay(Color.white.opacity(0.08))
            ForEach(0..<rows, id: \.self) { r in
                GridRow {
                    ForEach(cols) { c in
                        let vals = c.list("values")
                        let v: Any = r < vals.count ? vals[r] : NSNull()
                        let type = c.str("type")
                        let text = CanvasFormat.cell(v, type: type)
                        if type == "status" {
                            let tone = CanvasFormat.statusTone(text)
                            Text("\(tone == "error" ? "✗" : tone == "success" ? "✓" : "•") \(text)")
                                .font(.system(size: 10.5)).foregroundStyle(CanvasFormat.tone(tone == "plain" ? nil : tone))
                        } else {
                            Text(text).font(.system(size: 10.5)).foregroundStyle(Ink.text.opacity(0.9)).monospacedDigit().lineLimit(1)
                                .gridColumnAlignment(["number", "currency", "percent"].contains(type ?? "") ? .trailing : .leading)
                        }
                    }
                }
            }
        }
    }
}

struct CanvasBars: View {
    let node: CanvasNode
    var body: some View {
        let labels = node.list("labels").map { "\($0)" }
        let vals = node.list("values").map { ($0 as? NSNumber)?.doubleValue ?? 0 }
        let top = max(vals.max() ?? 1, 1e-9)
        VStack(alignment: .leading, spacing: 3) {
            if let t = node.str("title") { Text(t).font(.system(size: 10, weight: .semibold)).foregroundStyle(Ink.muted) }
            ForEach(Array(labels.prefix(8).enumerated()), id: \.offset) { i, l in
                HStack(spacing: 8) {
                    Text(l).font(.system(size: 10.5)).foregroundStyle(Ink.text).frame(width: 70, alignment: .leading).lineLimit(1)
                    GeometryReader { g in
                        Capsule().fill(LinearGradient(colors: [Ink.gold, Ink.gold.opacity(0.65)], startPoint: .leading, endPoint: .trailing))
                            .frame(width: max(3, g.size.width * (i < vals.count ? vals[i] : 0) / top))
                    }
                    .frame(height: 7)
                    Text(CanvasFormat.number(i < vals.count ? vals[i] : 0)).font(.system(size: 10.5)).foregroundStyle(Ink.muted).monospacedDigit()
                        .frame(width: 44, alignment: .trailing)
                }
            }
        }
    }
}

struct CanvasSpark: View {
    let node: CanvasNode
    var body: some View {
        let vals = node.list("values").compactMap { ($0 as? NSNumber)?.doubleValue }
        HStack(spacing: 8) {
            if let l = node.str("label") { Text(l).font(.system(size: 10.5)).foregroundStyle(Ink.muted) }
            Canvas { ctx, size in
                guard vals.count > 1, let lo = vals.min(), let hi = vals.max() else { return }
                let span = hi - lo == 0 ? 1 : hi - lo
                var path = Path()
                for (i, v) in vals.enumerated() {
                    let p = CGPoint(x: size.width * CGFloat(i) / CGFloat(vals.count - 1), y: size.height * (1 - CGFloat((v - lo) / span)))
                    if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
                }
                ctx.stroke(path, with: .color(Ink.gold), style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
            }
            .frame(width: 110, height: 18)
            if let last = vals.last { Text(CanvasFormat.number(last)).font(.system(size: 10.5)).foregroundStyle(Ink.text).monospacedDigit() }
        }
    }
}
