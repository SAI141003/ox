import SwiftUI

/// The "motion → text" screen: segments are classified against the trained vocabulary
/// and appended to a running transcript, with the mic transcript alongside for comparison.
struct DecodeView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if model.classifier == nil {
                    Label("Train at least two words in the Train tab first.", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
                controls
                transcriptPanel
                HStack(alignment: .top, spacing: 16) {
                    lastPredictionPanel
                    micPanel
                }
            }
            .padding(20)
        }
    }

    // MARK: Controls

    private var controls: some View {
        @Bindable var model = model
        @Bindable var capture = model.capture
        return GroupBox {
            VStack(alignment: .leading, spacing: 12) {
                Picker("Segmentation", selection: $model.decodeMode) {
                    ForEach(CaptureController.Mode.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 320)

                if model.decodeMode == .hold {
                    HoldToCaptureButton(
                        title: "Mouth a word",
                        isCapturing: capture.isCapturing,
                        isEnabled: model.classifier != nil && model.motion.status == .streaming,
                        onBegin: capture.begin,
                        onEnd: capture.end)
                } else {
                    autoControls
                }

                HStack(spacing: 24) {
                    LabeledContent("Max distance") {
                        Slider(value: $model.maxDistance, in: 0.2...4).frame(width: 140)
                        Text(String(format: "%.2f", model.maxDistance)).monospacedDigit().frame(width: 36)
                    }
                    LabeledContent("Min confidence") {
                        Slider(value: $model.minConfidence, in: 0...0.5).frame(width: 140)
                        Text(String(format: "%.2f", model.minConfidence)).monospacedDigit().frame(width: 36)
                    }
                }
                .font(.callout)
            }
            .padding(6)
        }
    }

    private var autoControls: some View {
        @Bindable var capture = model.capture
        let scaleMax = max((capture.threshold ?? 0.05) * 2, 0.02)
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button(capture.isCalibrating ? "Calibrating… stay still" : "Calibrate noise floor") {
                    capture.calibrate()
                }
                .disabled(capture.isCalibrating || model.motion.status != .streaming)
                if let floor = capture.noiseFloor {
                    Text(String(format: "floor %.4f", floor)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                Spacer()
                Circle()
                    .fill(capture.isCapturing ? Color.red : Color.secondary.opacity(0.3))
                    .frame(width: 10, height: 10)
                Text(capture.isCapturing ? "Capturing" : "Listening")
                    .font(.caption)
            }
            LevelMeter(value: capture.energy / scaleMax,
                       marker: capture.threshold.map { $0 / scaleMax },
                       tint: capture.isCapturing ? .red : .blue)
            LabeledContent("Trigger × floor") {
                Slider(value: $capture.triggerRatio, in: 1.5...10).frame(width: 160)
                Text(String(format: "%.1f×", capture.triggerRatio)).monospacedDigit()
            }
            .font(.callout)
            if capture.noiseFloor == nil {
                Text("Calibrate first: keep still for 2 s so the detector learns your resting motion.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: Transcript

    private var transcriptPanel: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Decoded from motion").font(.headline)
                    Spacer()
                    Button("Clear", action: model.clearDecoded)
                        .disabled(model.decoded.isEmpty)
                }
                if model.decoded.isEmpty {
                    Text("Mouth a trained word…")
                        .font(.system(size: 28, weight: .regular, design: .rounded))
                        .foregroundStyle(.tertiary)
                        .frame(maxWidth: .infinity, minHeight: 80, alignment: .topLeading)
                } else {
                    decodedText
                        .font(.system(size: 28, weight: .medium, design: .rounded))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, minHeight: 80, alignment: .topLeading)
                }
                Text("Faded words were rejected by the distance/confidence thresholds.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .padding(6)
        }
    }

    private var decodedText: Text {
        model.decoded.reduce(Text("")) { text, word in
            let piece = Text(word.text + " ")
            return text + (word.prediction.accepted ? piece : piece.foregroundColor(.secondary.opacity(0.4)))
        }
    }

    // MARK: Diagnostics

    private var lastPredictionPanel: some View {
        GroupBox("Last segment") {
            VStack(alignment: .leading, spacing: 8) {
                if let prediction = model.decoded.last?.prediction {
                    let worst = prediction.ranked.last?.distance ?? 1
                    ForEach(prediction.ranked) { candidate in
                        HStack {
                            Text(candidate.label).frame(width: 70, alignment: .leading)
                            LevelMeter(value: 1 - candidate.distance / max(worst * 1.2, 1e-6),
                                       tint: candidate == prediction.best ? .green : .gray)
                            Text(String(format: "%.2f", candidate.distance))
                                .font(.caption.monospacedDigit())
                                .frame(width: 40, alignment: .trailing)
                        }
                    }
                    Text(String(format: "Confidence %.2f · %@", prediction.confidence,
                                prediction.accepted ? "accepted" : "rejected"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    SignalPlot(title: "Rotation rate", samples: model.lastSegment,
                               channels: SignalPlot.rotation, minScale: 0.05, height: 60)
                } else {
                    Text("DTW distance to each word's closest take appears here.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
        }
    }

    private var micPanel: some View {
        GroupBox("Microphone transcript (reference)") {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Button(model.audio.isRunning ? "Stop Mic" : "Start Mic") {
                        Task { await model.toggleMic() }
                    }
                    LevelMeter(value: Double(model.audio.level))
                    Button("Clear", action: model.transcriber.clear)
                }
                Text(model.transcriber.text.isEmpty ? "Whisper or speak to compare against the motion decoder." : model.transcriber.text)
                    .foregroundStyle(model.transcriber.text.isEmpty ? .secondary : .primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, minHeight: 60, alignment: .topLeading)
                if model.transcriber.isRunning {
                    Text(model.transcriber.isOnDevice ? "On-device recognition" : "Server recognition")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if let error = model.audio.error ?? model.transcriber.error {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
        }
    }
}
