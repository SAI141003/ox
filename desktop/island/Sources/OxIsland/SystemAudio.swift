import AVFoundation
import CoreMedia
import ScreenCaptureKit

/// What the Mac plays (the other side of a call: Zoom, Meet, FaceTime,
/// WhatsApp…), recorded with ScreenCaptureKit's audio capture into a file
/// during a call, for the call notes. Needs Screen Recording access for OX
/// Island (macOS asks once); without it the notes keep your microphone only.
/// The island's own sounds are left out.
final class SystemAudioRecorder: NSObject, SCStreamOutput, SCStreamDelegate {
    let url: URL
    private var stream: SCStream?
    private var file: AVAudioFile?
    private let queue = DispatchQueue(label: "dev.ox.island.system-audio")
    private(set) var frames: AVAudioFramePosition = 0
    private(set) var failure: String?

    init(url: URL) { self.url = url }

    func start() async -> Bool {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first else { failure = "no display to capture audio from"; return false }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let cfg = SCStreamConfiguration()
            cfg.capturesAudio = true
            cfg.excludesCurrentProcessAudio = true
            cfg.sampleRate = 48_000
            cfg.channelCount = 1
            // Audio is what we want: the smallest possible picture, once a second.
            cfg.width = 2
            cfg.height = 2
            cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            let s = SCStream(filter: filter, configuration: cfg, delegate: self)
            try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
            try await s.startCapture()
            stream = s
            return true
        } catch {
            failure = (error as NSError).code == -3801 ? "Screen Recording access is off for OX Island (System Settings › Privacy & Security › Screen & System Audio Recording)" : error.localizedDescription
            return false
        }
    }

    func stop() async {
        try? await stream?.stopCapture()
        stream = nil
        queue.sync { file = nil }   // closes the file
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sb.isValid, let pcm = Self.pcm(from: sb) else { return }
        if file == nil { file = try? AVAudioFile(forWriting: url, settings: pcm.format.settings, commonFormat: pcm.format.commonFormat, interleaved: pcm.format.isInterleaved) }
        do { try file?.write(from: pcm); frames += AVAudioFramePosition(pcm.frameLength) } catch {}
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) { failure = error.localizedDescription }

    /// A sample buffer as a PCM buffer (its own format, copied).
    static func pcm(from sb: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard let desc = CMSampleBufferGetFormatDescription(sb), let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc) else { return nil }
        var basic = asbd.pointee
        guard let format = AVAudioFormat(streamDescription: &basic) else { return nil }
        let n = AVAudioFrameCount(CMSampleBufferGetNumSamples(sb))
        guard n > 0, let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: n) else { return nil }
        buf.frameLength = n
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(sb, at: 0, frameCount: Int32(n), into: buf.mutableAudioBufferList)
        return status == noErr ? buf : nil
    }
}
