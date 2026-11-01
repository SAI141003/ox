import SwiftUI

/// Multi-channel line plot of motion samples, drawn with Canvas so it keeps up at sensor rate.
struct SignalPlot: View {
    struct Channel {
        var name: String
        var color: Color
        var value: KeyPath<MotionSample, Double>
    }

    var title: String
    var samples: [MotionSample]
    var channels: [Channel]
    /// Visible time span; defaults to the extent of `samples`.
    var span: ClosedRange<TimeInterval>?
    var minScale: Double = 0.02
    var height: CGFloat = 90
    var showsHeader = true

    static let acceleration = [
        Channel(name: "x", color: .red, value: \.ax),
        Channel(name: "y", color: .green, value: \.ay),
        Channel(name: "z", color: .blue, value: \.az),
    ]
    static let rotation = [
        Channel(name: "x", color: .red, value: \.rx),
        Channel(name: "y", color: .green, value: \.ry),
        Channel(name: "z", color: .blue, value: \.rz),
    ]
    static let attitude = [
        Channel(name: "pitch", color: .orange, value: \.pitch),
        Channel(name: "roll", color: .purple, value: \.roll),
        Channel(name: "yaw", color: .teal, value: \.yaw),
    ]

    var body: some View {
        let range = span ?? ((samples.first?.t ?? 0)...(samples.last?.t ?? 1))
        let visible = samples.filter { range.contains($0.t) }
        let scale = max(minScale, channels.flatMap { c in visible.map { abs($0[keyPath: c.value]) } }.max() ?? 0)

        VStack(alignment: .leading, spacing: 4) {
            if showsHeader {
                HStack(spacing: 10) {
                    Text(title).font(.caption.weight(.semibold))
                    ForEach(channels, id: \.name) { channel in
                        Label(channel.name, systemImage: "circle.fill")
                            .labelStyle(.titleAndIcon)
                            .font(.caption2)
                            .foregroundStyle(channel.color)
                    }
                    Spacer()
                    Text("±\(scale, specifier: "%.3f")")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            Canvas { context, size in
                let mid = size.height / 2
                var axis = Path()
                axis.move(to: CGPoint(x: 0, y: mid))
                axis.addLine(to: CGPoint(x: size.width, y: mid))
                context.stroke(axis, with: .color(.secondary.opacity(0.3)), lineWidth: 0.5)

                let width = max(range.upperBound - range.lowerBound, 1e-3)
                for channel in channels {
                    var path = Path()
                    for (i, s) in visible.enumerated() {
                        let point = CGPoint(
                            x: (s.t - range.lowerBound) / width * size.width,
                            y: mid - s[keyPath: channel.value] / scale * (mid - 2))
                        if i == 0 { path.move(to: point) } else { path.addLine(to: point) }
                    }
                    context.stroke(path, with: .color(channel.color), lineWidth: 1.2)
                }
            }
            .frame(height: height)
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 6))
        }
    }
}

struct LevelMeter: View {
    var value: Double
    var marker: Double?
    var tint: Color = .green

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(.quaternary)
                Capsule().fill(tint.gradient)
                    .frame(width: geo.size.width * min(max(value, 0), 1))
                if let marker {
                    Rectangle().fill(.primary)
                        .frame(width: 2)
                        .offset(x: geo.size.width * min(max(marker, 0), 1) - 1)
                }
            }
        }
        .frame(height: 8)
        .animation(.linear(duration: 0.08), value: value)
    }
}

/// Mouse alternative to holding Space.
struct HoldToCaptureButton: View {
    var title: String
    var isCapturing: Bool
    var isEnabled = true
    var onBegin: () -> Void
    var onEnd: () -> Void

    @State private var pressed = false

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: isCapturing ? "waveform" : "mouth")
                .font(.system(size: 30, weight: .medium))
                .symbolEffect(.variableColor.iterative, isActive: isCapturing)
            Text(isCapturing ? "Capturing…" : title)
                .font(.headline)
            Text("Hold Space or press and hold here")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 120)
        .background(
            RoundedRectangle(cornerRadius: 14)
                .fill(isCapturing ? Color.red.opacity(0.18) : Color.accentColor.opacity(0.10)))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(isCapturing ? Color.red : Color.accentColor.opacity(0.4), lineWidth: isCapturing ? 2 : 1))
        .contentShape(Rectangle())
        .opacity(isEnabled ? 1 : 0.4)
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    guard isEnabled, !pressed else { return }
                    pressed = true
                    onBegin()
                }
                .onEnded { _ in
                    guard pressed else { return }
                    pressed = false
                    onEnd()
                })
    }
}

struct MotionStatusBadge: View {
    var status: HeadphoneMotionService.Status
    var rate: Double

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(status == .streaming ? "AirPods · \(Int(rate.rounded())) Hz" : status.label)
                .font(.callout.monospacedDigit())
        }
        .padding(.horizontal, 8)
    }

    private var color: Color {
        switch status {
        case .streaming: .green
        case .waiting: .orange
        default: .red
        }
    }
}
