import Foundation

/// Dynamic time warping between two multichannel sequences, with a Sakoe–Chiba band.
/// Lets the same mouthed word match when said faster or slower.
enum DTW {
    static func distance(_ a: [[Double]], _ b: [[Double]], bandFraction: Double = 0.25) -> Double {
        let n = a.count, m = b.count
        guard n > 0, m > 0 else { return .infinity }
        let band = max(abs(n - m), Int(Double(max(n, m)) * bandFraction))

        var previous = [Double](repeating: .infinity, count: m + 1)
        var current = previous
        previous[0] = 0

        for i in 1...n {
            for j in current.indices { current[j] = .infinity }
            let lo = max(1, i - band)
            let hi = min(m, i + band)
            if lo <= hi {
                for j in lo...hi {
                    let cost = euclidean(a[i - 1], b[j - 1])
                    current[j] = cost + min(previous[j], current[j - 1], previous[j - 1])
                }
            }
            swap(&previous, &current)
        }
        // Normalize by the maximum path length so long and short words compare fairly.
        return previous[m] / Double(n + m)
    }

    private static func euclidean(_ x: [Double], _ y: [Double]) -> Double {
        var sum = 0.0
        for k in 0..<min(x.count, y.count) {
            let d = x[k] - y[k]
            sum += d * d
        }
        return sum.squareRoot()
    }
}
