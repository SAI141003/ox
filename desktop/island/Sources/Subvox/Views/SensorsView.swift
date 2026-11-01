import CoreAudio
import SwiftUI

struct SensorsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let motion = model.motion
        let span = motion.latest.map { ($0.t - 8)...$0.t }

        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 16) {
                    motionCard
                    MicrophoneCard()
                }

                GroupBox("Live motion (last 8 s)") {
                    VStack(spacing: 12) {
                        SignalPlot(title: "User acceleration (g)", samples: motion.history,
                                   channels: SignalPlot.acceleration, span: span, minScale: 0.01)
                        SignalPlot(title: "Rotation rate (rad/s)", samples: motion.history,
                                   channels: SignalPlot.rotation, span: span, minScale: 0.05)
                        SignalPlot(title: "Attitude (rad)", samples: motion.history,
                                   channels: SignalPlot.attitude, span: span, minScale: 0.1)
                    }
                    .padding(6)
                }

                RecordingCard()
            }
            .padding(20)
        }
    }

    private var motionCard: some View {
        let motion = model.motion
        return GroupBox("AirPods motion") {
            VStack(alignment: .leading, spacing: 8) {
                LabeledContent("Status", value: motion.status.label)
                LabeledContent("Sample rate", value: String(format: "%.1f Hz", motion.sampleRate))
                LabeledContent("Samples", value: "\(motion.sampleCount)")
                if let s = motion.latest {
                    LabeledContent("Gravity", value: String(format: "%.2f, %.2f, %.2f", s.gx, s.gy, s.gz))
                }
                if motion.status == .waiting {
                    Text("Put in AirPods Pro and make sure they're the active output on this Mac.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .font(.callout.monospacedDigit())
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
        }
    }
}

private struct MicrophoneCard: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var audio = model.audio
        GroupBox("Microphone") {
            VStack(alignment: .leading, spacing: 10) {
                Picker("Input", selection: $audio.selectedDeviceID) {
                    Text("System default").tag(AudioDeviceID?.none)
                    ForEach(audio.devices) { device in
                        Text(device.name).tag(Optional(device.id))
                    }
                }
                HStack {
                    Button(audio.isRunning ? "Stop Mic" : "Start Mic") {
                        Task { await model.toggleMic() }
                    }
                    Button("Refresh", systemImage: "arrow.clockwise") { audio.refreshDevices() }
                        .labelStyle(.iconOnly)
                    LevelMeter(value: Double(audio.level))
                }
                if let name = audio.activeDeviceName {
                    Text("Capturing from \(name)").font(.caption).foregroundStyle(.secondary)
                }
                if let error = audio.error ?? model.transcriber.error {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
                Text("Selecting AirPods as input switches them to the Bluetooth headset profile, which can lower playback quality.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
        }
    }
}

private struct RecordingCard: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var recorder = model.recorder
        GroupBox("Experiment recording") {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Picker("Condition", selection: $recorder.condition) {
                        ForEach(SessionRecorder.Condition.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .disabled(recorder.isRecording)
                }
                TextField("Prompt / what you're saying (e.g. “yes no yes stop”)", text: $recorder.prompt)
                    .textFieldStyle(.roundedBorder)
                HStack {
                    Button {
                        recorder.isRecording ? recorder.stop() : recorder.start(audio: model.audio)
                    } label: {
                        Label(recorder.isRecording ? "Stop" : "Record",
                              systemImage: recorder.isRecording ? "stop.fill" : "record.circle")
                    }
                    .tint(recorder.isRecording ? .red : .accentColor)
                    .buttonStyle(.borderedProminent)

                    if recorder.isRecording, let startedAt = recorder.startedAt {
                        Text(startedAt, style: .timer).monospacedDigit()
                        Text("· \(recorder.motionCount) samples · \(recorder.eventCount) marks")
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if let url = recorder.lastSessionURL {
                        Button("Show Last Session") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                    }
                }
                Text(model.audio.isRunning
                     ? "Motion + audio will be recorded. While recording, hold Space to mark each utterance."
                     : "Motion only — start the mic above to also record audio. Hold Space to mark each utterance.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let error = recorder.error {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
        }
    }
}
