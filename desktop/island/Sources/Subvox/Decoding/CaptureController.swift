import Foundation
import Observation

/// Cuts the continuous motion stream into word-sized segments, either while Space is held
/// or automatically when motion energy rises above a calibrated noise floor.
@MainActor @Observable
final class CaptureController {
    enum Mode: String, CaseIterable, Identifiable {
        case hold = "Hold Space"
        case auto = "Auto-detect"
        var id: String { rawValue }
    }

    static let calibrationSeconds: TimeInterval = 2
    static let prerollSeconds: TimeInterval = 0.3
    static let hangoverSeconds: TimeInterval = 0.35
    static let maxAutoSeconds: TimeInterval = 3
    static let maxHoldSeconds: TimeInterval = 6

    var autoEnabled = false {
        didSet { if !autoEnabled, isCapturing, !isManual { finish() } }
    }
    var triggerRatio: Double = 3

    private(set) var isCapturing = false
    private(set) var isCalibrating = false
    private(set) var energy: Double = 0
    private(set) var noiseFloor: Double?

    var threshold: Double? { noiseFloor.map { $0 * triggerRatio } }

    var onSegment: (([MotionSample]) -> Void)?

    @ObservationIgnored private var isManual = false
    @ObservationIgnored private var buffer: [MotionSample] = []
    @ObservationIgnored private var preroll: [MotionSample] = []
    @ObservationIgnored private var calibration: [Double] = []
    @ObservationIgnored private var calibrationEnd: TimeInterval?
    @ObservationIgnored private var quietSince: TimeInterval?

    func begin() {
        guard !isCapturing else { return }
        isManual = true
        isCapturing = true
        buffer = preroll
    }

    func end() {
        guard isCapturing, isManual else { return }
        finish()
    }

    func calibrate() {
        calibration = []
        calibrationEnd = nil
        isCalibrating = true
    }

    func ingest(_ sample: MotionSample) {
        let e = MotionFeatures.energy(sample)
        energy = energy * 0.6 + e * 0.4

        if isCalibrating {
            let end = calibrationEnd ?? sample.t + Self.calibrationSeconds
            calibrationEnd = end
            calibration.append(energy)
            if sample.t >= end {
                let sorted = calibration.sorted()
                noiseFloor = max(sorted[sorted.count / 2], 1e-4)
                isCalibrating = false
            }
        }

        preroll.append(sample)
        if let keepFrom = preroll.firstIndex(where: { $0.t >= sample.t - Self.prerollSeconds }), keepFrom > 0 {
            preroll.removeFirst(keepFrom)
        }

        if isCapturing {
            buffer.append(sample)
            let duration = sample.t - (buffer.first?.t ?? sample.t)
            if isManual {
                if duration > Self.maxHoldSeconds { finish() }
            } else if let threshold {
                if energy < threshold * 0.7 {
                    let since = quietSince ?? sample.t
                    quietSince = since
                    if sample.t - since > Self.hangoverSeconds { finish() }
                } else {
                    quietSince = nil
                }
                if duration > Self.maxAutoSeconds { finish() }
            }
        } else if autoEnabled, !isCalibrating, let threshold, energy > threshold {
            isManual = false
            isCapturing = true
            quietSince = nil
            buffer = preroll
        }
    }

    private func finish() {
        let segment = buffer
        buffer = []
        isCapturing = false
        isManual = false
        quietSince = nil
        guard segment.count >= 4, let first = segment.first, let last = segment.last, last.t - first.t >= 0.15 else { return }
        onSegment?(segment)
    }
}
