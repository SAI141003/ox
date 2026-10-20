import Foundation
import IOKit.ps

/// ox's idle promise for the island: nothing animates faster than it must.
/// On battery or in Low Power Mode the characters move at a lower frame rate;
/// idle ones hold still. Checked at most every 30 s (it is a cheap system call).
enum Energy {
    private static var cached = false
    private static var checkedAt = Date.distantPast

    /// True on battery power or in Low Power Mode.
    static var saving: Bool {
        if Date().timeIntervalSince(checkedAt) > 30 {
            checkedAt = Date()
            var battery = false
            if let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
               let type = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() as String? {
                battery = type == kIOPSBatteryPowerValue
            }
            cached = battery || ProcessInfo.processInfo.isLowPowerModeEnabled
        }
        return cached
    }

    /// Seconds between frames for an animation that wants `fps` when active.
    static func interval(_ fps: Double, active: Bool) -> Double {
        let f = active ? fps : min(fps, saving ? 6 : 10)
        return 1.0 / (saving ? max(4, f * 0.6) : f)
    }
}
