import CoreMotion
import Observation

/// Streams `CMHeadphoneMotionManager` updates from connected AirPods.
@MainActor @Observable
final class HeadphoneMotionService {
    enum Status: Equatable {
        case unsupported
        case denied
        case waiting
        case streaming
        case error(String)

        var label: String {
            switch self {
            case .unsupported: "Headphone motion unsupported"
            case .denied: "Motion access denied"
            case .waiting: "Waiting for AirPods"
            case .streaming: "Streaming"
            case .error(let message): message
            }
        }
    }

    static let historySeconds: TimeInterval = 10

    private(set) var status: Status = .waiting
    private(set) var isConnected = false
    private(set) var latest: MotionSample?
    private(set) var history: [MotionSample] = []
    private(set) var sampleRate: Double = 0
    private(set) var sampleCount = 0

    var onSample: ((MotionSample) -> Void)?

    @ObservationIgnored private let manager = CMHeadphoneMotionManager()
    @ObservationIgnored private let proxy = DelegateProxy()
    @ObservationIgnored private var rateWindow: [TimeInterval] = []

    func start() {
        guard manager.isDeviceMotionAvailable else {
            status = .unsupported
            return
        }
        switch CMHeadphoneMotionManager.authorizationStatus() {
        case .denied, .restricted:
            status = .denied
            return
        default:
            break
        }

        proxy.onChange = { [weak self] connected in
            Task { @MainActor in self?.connectionChanged(connected) }
        }
        manager.delegate = proxy
        manager.startConnectionStatusUpdates()
        manager.startDeviceMotionUpdates(to: .main) { [weak self] motion, error in
            MainActor.assumeIsolated {
                self?.handle(motion, error)
            }
        }
    }

    func stop() {
        manager.stopDeviceMotionUpdates()
        manager.stopConnectionStatusUpdates()
    }

    private func connectionChanged(_ connected: Bool) {
        isConnected = connected
        if !connected {
            status = .waiting
            sampleRate = 0
            rateWindow.removeAll()
        }
    }

    private func handle(_ motion: CMDeviceMotion?, _ error: Error?) {
        if let error {
            let ns = error as NSError
            if ns.domain == CMErrorDomain, ns.code == Int(CMErrorMotionActivityNotAuthorized.rawValue) {
                status = .denied
            } else {
                status = .error(error.localizedDescription)
            }
            return
        }
        guard let motion else { return }

        let sample = MotionSample(motion)
        latest = sample
        status = .streaming
        isConnected = true
        sampleCount += 1

        history.append(sample)
        let cutoff = sample.t - Self.historySeconds
        if let firstKept = history.firstIndex(where: { $0.t >= cutoff }), firstKept > 0 {
            history.removeFirst(firstKept)
        }

        rateWindow.append(sample.t)
        rateWindow.removeAll { $0 < sample.t - 1 }
        if let first = rateWindow.first, sample.t > first {
            sampleRate = Double(rateWindow.count - 1) / (sample.t - first)
        }

        onSample?(sample)
    }
}

private final class DelegateProxy: NSObject, CMHeadphoneMotionManagerDelegate {
    var onChange: ((Bool) -> Void)?

    func headphoneMotionManagerDidConnect(_ manager: CMHeadphoneMotionManager) {
        onChange?(true)
    }

    func headphoneMotionManagerDidDisconnect(_ manager: CMHeadphoneMotionManager) {
        onChange?(false)
    }
}
