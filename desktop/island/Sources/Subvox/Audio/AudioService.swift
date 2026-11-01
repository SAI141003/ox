import AVFoundation
import CoreAudio
import Observation

/// Fans microphone buffers out to consumers (speech recognizer, session recorder) on the
/// audio render thread. Consumers must be cheap and thread-safe.
final class AudioSink: @unchecked Sendable {
    typealias Consumer = (AVAudioPCMBuffer, AVAudioTime) -> Void

    private let lock = NSLock()
    private var consumers: [UUID: Consumer] = [:]
    private var onLevel: ((Float) -> Void)?

    func add(_ consumer: @escaping Consumer) -> UUID {
        let id = UUID()
        lock.withLock { consumers[id] = consumer }
        return id
    }

    func remove(_ id: UUID) {
        lock.withLock { _ = consumers.removeValue(forKey: id) }
    }

    func setLevelHandler(_ handler: ((Float) -> Void)?) {
        lock.withLock { onLevel = handler }
    }

    func dispatch(_ buffer: AVAudioPCMBuffer, _ time: AVAudioTime) {
        let (current, levelHandler) = lock.withLock { (Array(consumers.values), onLevel) }
        for consumer in current { consumer(buffer, time) }
        levelHandler?(Self.normalizedLevel(buffer))
    }

    /// RMS of channel 0 mapped from -60…0 dBFS onto 0…1.
    private static func normalizedLevel(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        let n = Int(buffer.frameLength)
        var sum: Float = 0
        for i in 0..<n { sum += samples[i] * samples[i] }
        let rms = (sum / Float(n)).squareRoot()
        let db = 20 * log10(max(rms, 1e-7))
        return max(0, min(1, (db + 60) / 60))
    }
}

@MainActor @Observable
final class AudioService {
    private(set) var isRunning = false
    private(set) var level: Float = 0
    private(set) var devices: [AudioDevices.Device] = []
    private(set) var activeDeviceName: String?
    private(set) var error: String?
    /// `nil` means "system default input".
    var selectedDeviceID: AudioDeviceID? {
        didSet {
            guard oldValue != selectedDeviceID, isRunning else { return }
            stop()
            Task { await start() }
        }
    }

    @ObservationIgnored let sink = AudioSink()
    @ObservationIgnored private var engine: AVAudioEngine?

    func refreshDevices() {
        devices = AudioDevices.inputDevices()
    }

    func start() async {
        guard !isRunning else { return }
        error = nil

        guard await AVCaptureDevice.requestAccess(for: .audio) else {
            error = "Microphone access denied. Enable it in System Settings › Privacy & Security."
            return
        }

        let engine = AVAudioEngine()
        let input = engine.inputNode
        let deviceID = selectedDeviceID ?? AudioDevices.defaultInputID()
        if let selectedDeviceID, let unit = input.audioUnit {
            var id = selectedDeviceID
            let status = AudioUnitSetProperty(
                unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                &id, UInt32(MemoryLayout<AudioDeviceID>.size))
            if status != noErr {
                error = "Couldn't switch input device (\(status))."
                return
            }
        }

        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            error = "Input device has no usable format."
            return
        }

        sink.setLevelHandler { [weak self] level in
            Task { @MainActor in self?.level = level }
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format, block: Self.tapBlock(for: sink))

        do {
            engine.prepare()
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            self.error = error.localizedDescription
            return
        }

        self.engine = engine
        activeDeviceName = deviceID.flatMap(AudioDevices.name(of:))
        isRunning = true
    }

    func stop() {
        guard let engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
        sink.setLevelHandler(nil)
        isRunning = false
        level = 0
        activeDeviceName = nil
    }

    // Built outside main-actor isolation: the tap runs on the audio render thread.
    nonisolated private static func tapBlock(for sink: AudioSink) -> AVAudioNodeTapBlock {
        { buffer, time in sink.dispatch(buffer, time) }
    }
}
