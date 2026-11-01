import CoreMotion

/// One processed headphone-motion reading. `t` is seconds since boot (same clock as
/// `ProcessInfo.systemUptime` and `AVAudioTime` host time), so motion and audio line up.
struct MotionSample: Codable, Hashable, Sendable {
    var t: TimeInterval
    // User acceleration (g), gravity removed.
    var ax: Double, ay: Double, az: Double
    // Rotation rate (rad/s).
    var rx: Double, ry: Double, rz: Double
    // Attitude (rad).
    var pitch: Double, roll: Double, yaw: Double
    // Gravity vector (g).
    var gx: Double, gy: Double, gz: Double
    // Attitude quaternion.
    var qw: Double, qx: Double, qy: Double, qz: Double

    init(_ m: CMDeviceMotion) {
        t = m.timestamp
        ax = m.userAcceleration.x; ay = m.userAcceleration.y; az = m.userAcceleration.z
        rx = m.rotationRate.x; ry = m.rotationRate.y; rz = m.rotationRate.z
        pitch = m.attitude.pitch; roll = m.attitude.roll; yaw = m.attitude.yaw
        gx = m.gravity.x; gy = m.gravity.y; gz = m.gravity.z
        let q = m.attitude.quaternion
        qw = q.w; qx = q.x; qy = q.y; qz = q.z
    }

    init(t: TimeInterval,
         accel: (Double, Double, Double) = (0, 0, 0),
         rotation: (Double, Double, Double) = (0, 0, 0),
         attitude: (Double, Double, Double) = (0, 0, 0)) {
        self.t = t
        (ax, ay, az) = accel
        (rx, ry, rz) = rotation
        (pitch, roll, yaw) = attitude
        (gx, gy, gz) = (0, 0, -1)
        (qw, qx, qy, qz) = (1, 0, 0, 0)
    }

    static let csvHeader = "t,ax,ay,az,rx,ry,rz,pitch,roll,yaw,gx,gy,gz,qw,qx,qy,qz"

    func csvRow(relativeTo t0: TimeInterval) -> String {
        [t - t0, ax, ay, az, rx, ry, rz, pitch, roll, yaw, gx, gy, gz, qw, qx, qy, qz]
            .map { String(format: "%.6f", $0) }
            .joined(separator: ",")
    }
}
