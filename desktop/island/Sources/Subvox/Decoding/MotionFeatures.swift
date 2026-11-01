import Foundation

/// Which motion channels feed the classifier. Toggling these is the ablation experiment:
/// does articulation show up in acceleration, rotation, or slow head attitude?
struct FeatureSet: OptionSet, Codable, Hashable, Sendable {
    let rawValue: Int

    static let acceleration = FeatureSet(rawValue: 1 << 0)
    static let rotation = FeatureSet(rawValue: 1 << 1)
    static let attitude = FeatureSet(rawValue: 1 << 2)
    static let all: FeatureSet = [.acceleration, .rotation, .attitude]
}

enum MotionFeatures {
    /// Activity score used for segmentation. Rotation (rad/s) and acceleration (g) live on
    /// different scales; the 5× weight puts typical jaw-motion values in the same range.
    static func energy(_ s: MotionSample) -> Double {
        let rotation = (s.rx * s.rx + s.ry * s.ry + s.rz * s.rz).squareRoot()
        let accel = (s.ax * s.ax + s.ay * s.ay + s.az * s.az).squareRoot()
        return rotation + 5 * accel
    }

    /// Drops quiet lead-in/lead-out frames so templates align on the articulation itself.
    /// Uses a threshold relative to the segment so it behaves the same for training and decoding.
    static func trim(_ samples: [MotionSample], padding: Int = 2) -> [MotionSample] {
        guard samples.count > 6 else { return samples }
        let energies = samples.map(energy)
        let sorted = energies.sorted()
        let floor = sorted[sorted.count / 5]
        let peak = sorted[sorted.count - 1]
        guard peak > floor * 1.5 else { return samples }
        let threshold = floor + 0.15 * (peak - floor)
        guard let first = energies.firstIndex(where: { $0 > threshold }),
              let last = energies.lastIndex(where: { $0 > threshold }) else { return samples }
        let lo = max(0, first - padding)
        let hi = min(samples.count - 1, last + padding)
        guard hi - lo + 1 >= 5 else { return samples }
        return Array(samples[lo...hi])
    }

    /// Per-frame feature vectors, mean-centered per channel (removes posture/heading bias).
    static func frames(_ samples: [MotionSample], set: FeatureSet) -> [[Double]] {
        guard let origin = samples.first else { return [] }
        var frames = samples.map { s -> [Double] in
            var v: [Double] = []
            if set.contains(.acceleration) { v += [s.ax, s.ay, s.az] }
            if set.contains(.rotation) { v += [s.rx, s.ry, s.rz] }
            if set.contains(.attitude) {
                v += [wrapped(s.pitch - origin.pitch), wrapped(s.roll - origin.roll), wrapped(s.yaw - origin.yaw)]
            }
            return v
        }
        guard let dims = frames.first?.count, dims > 0 else { return frames }
        for d in 0..<dims {
            let mean = frames.reduce(0) { $0 + $1[d] } / Double(frames.count)
            for i in frames.indices { frames[i][d] -= mean }
        }
        return frames
    }

    /// Per-channel standard deviation across a corpus, so no channel dominates the distance.
    static func channelScales(_ sequences: [[[Double]]]) -> [Double] {
        guard let dims = sequences.first?.first?.count else { return [] }
        var sum = [Double](repeating: 0, count: dims)
        var sumSq = [Double](repeating: 0, count: dims)
        var n = 0.0
        for sequence in sequences {
            for frame in sequence {
                for d in 0..<dims {
                    sum[d] += frame[d]
                    sumSq[d] += frame[d] * frame[d]
                }
                n += 1
            }
        }
        guard n > 1 else { return [Double](repeating: 1, count: dims) }
        return (0..<dims).map { d in
            let mean = sum[d] / n
            return max((sumSq[d] / n - mean * mean).squareRoot(), 1e-6)
        }
    }

    static func scaled(_ frames: [[Double]], by scales: [Double]) -> [[Double]] {
        frames.map { frame in zip(frame, scales).map { $0 / $1 } }
    }

    private static func wrapped(_ angle: Double) -> Double {
        atan2(sin(angle), cos(angle))
    }
}
