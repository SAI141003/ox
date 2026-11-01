import XCTest
@testable import Subvox

final class DecodingTests: XCTestCase {
    /// A synthetic "word": a burst of rotation at `frequency` cycles over the segment.
    private func take(_ frequency: Double, axis: Int, frames: Int = 30, noise: Double = 0.01) -> [MotionSample] {
        (0..<frames).map { i in
            let t = Double(i) / 25
            let envelope = sin(Double.pi * Double(i) / Double(frames - 1))
            let v = 0.2 * envelope * sin(2 * .pi * frequency * Double(i) / Double(frames))
            let jitter = { Double.random(in: -noise...noise) }
            var rotation = (jitter(), jitter(), jitter())
            switch axis {
            case 0: rotation.0 += v
            case 1: rotation.1 += v
            default: rotation.2 += v
            }
            return MotionSample(t: t, rotation: rotation)
        }
    }

    func testDTWIdenticalIsZeroAndWarpTolerant() {
        let a = MotionFeatures.frames(take(2, axis: 0, noise: 0), set: .rotation)
        let stretched = MotionFeatures.frames(take(2, axis: 0, frames: 40, noise: 0), set: .rotation)
        let other = MotionFeatures.frames(take(2, axis: 1, noise: 0), set: .rotation)
        XCTAssertEqual(DTW.distance(a, a), 0, accuracy: 1e-12)
        XCTAssertLessThan(DTW.distance(a, stretched), DTW.distance(a, other))
    }

    func testClassifierSeparatesDistinctWords() throws {
        var templates: [Template] = []
        for _ in 0..<6 {
            templates.append(Template(label: "yes", samples: take(2, axis: 0)))
            templates.append(Template(label: "no", samples: take(3, axis: 1)))
        }
        let classifier = try XCTUnwrap(TemplateClassifier(templates: templates, featureSet: .all))
        let prediction = classifier.predict(take(3, axis: 1), maxDistance: 10, minConfidence: 0)
        XCTAssertEqual(prediction.best?.label, "no")
        XCTAssertTrue(prediction.accepted)
    }

    func testEvaluationBeatsChanceOnlyWhenSignalExists() throws {
        var real: [Template] = []
        var noise: [Template] = []
        for _ in 0..<8 {
            real.append(Template(label: "yes", samples: take(2, axis: 0)))
            real.append(Template(label: "no", samples: take(3, axis: 2)))
            noise.append(Template(label: "yes", samples: take(0, axis: 0, noise: 0.05)))
            noise.append(Template(label: "no", samples: take(0, axis: 0, noise: 0.05)))
        }
        let signal = try XCTUnwrap(Evaluation.run(templates: real, featureSet: .all, permutations: 200))
        XCTAssertGreaterThan(signal.accuracy, 0.9)
        XCTAssertLessThan(signal.pValue, 0.01)

        let null = try XCTUnwrap(Evaluation.run(templates: noise, featureSet: .all, permutations: 200))
        XCTAssertGreaterThan(null.pValue, 0.01)
    }

    func testTrimDropsQuietPadding() {
        let quiet = (0..<20).map { MotionSample(t: Double($0) / 25) }
        let burst = take(2, axis: 0, noise: 0).map { s -> MotionSample in
            var s = s; s.t += 0.8; return s
        }
        let trimmed = MotionFeatures.trim(quiet + burst + quiet.map { var s = $0; s.t += 2; return s })
        XCTAssertLessThan(trimmed.count, 40)
        XCTAssertGreaterThanOrEqual(trimmed.count, 20)
    }
}
