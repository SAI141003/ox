import Foundation
import CryptoKit

// The phone's side of src/phone-bridge.js: every request and reply sealed with
// AES-256-GCM under the key from pairing, with a time and a fresh nonce.
// Shared by the app and the Live Activity's buttons.

struct Pairing: Codable, Equatable {
    var host: String
    var port: Int
    var id: String
    var key: Data
    var mac: String = ""

    /// oxphone://192.168.1.5:47890/<id>#<key, base64url>
    static func parse(_ link: String) -> Pairing? {
        guard let url = URL(string: link.trimmingCharacters(in: .whitespacesAndNewlines)), url.scheme == "oxphone",
              let host = url.host, let port = url.port, let frag = url.fragment,
              let key = Data(base64URL: frag), key.count == 32 else { return nil }
        let id = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !id.isEmpty else { return nil }
        return Pairing(host: host, port: port, id: id, key: key)
    }
}

struct Approval: Identifiable, Equatable, Codable, Hashable {
    var socket: String
    var id: String
    var tool: String
    var preview: String
    var project: String
}

struct SessionRow: Identifiable, Equatable, Codable {
    var project: String
    var activity: String
    var phase: String
    var id: String { project + activity }
}

struct MacState: Equatable {
    var mac: String
    var approvals: [Approval]
    var sessions: [SessionRow]
}

enum OxLinkError: LocalizedError {
    case refused(Int), unreadable, notPaired
    var errorDescription: String? {
        switch self {
        case .refused(let code): return code == 429 ? "Too many failed tries: wait ten minutes." : "Your Mac refused this phone (\(code)). Pair it again: ox phone pair."
        case .unreadable: return "The reply could not be read."
        case .notPaired: return "Not paired yet."
        }
    }
}

struct OxLink {
    let pairing: Pairing

    func call(_ op: String, _ args: [String: Any] = [:]) async throws -> [String: Any] {
        let key = SymmetricKey(data: pairing.key)
        let payload: [String: Any] = ["op": op, "ts": Int(Date().timeIntervalSince1970 * 1000), "args": args]
        let plain = try JSONSerialization.data(withJSONObject: payload)
        let nonce = AES.GCM.Nonce()
        let box = try AES.GCM.seal(plain, using: key, nonce: nonce)
        let body: [String: Any] = ["id": pairing.id, "n": Data(nonce).base64EncodedString(), "c": (box.ciphertext + box.tag).base64EncodedString()]
        var req = URLRequest(url: URL(string: "http://\(pairing.host):\(pairing.port)/v1")!)
        req.httpMethod = "POST"
        req.timeoutInterval = 6
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else { throw OxLinkError.refused(code) }
        guard let env = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let n = (env["n"] as? String).flatMap({ Data(base64Encoded: $0) }),
              let c = (env["c"] as? String).flatMap({ Data(base64Encoded: $0) }) else { throw OxLinkError.unreadable }
        let opened = try AES.GCM.open(try AES.GCM.SealedBox(combined: n + c), using: key)
        guard let out = try JSONSerialization.jsonObject(with: opened) as? [String: Any] else { throw OxLinkError.unreadable }
        return out
    }

    func state() async throws -> MacState {
        let j = try await call("state")
        let approvals = ((j["approvals"] as? [[String: Any]]) ?? []).map {
            Approval(socket: $0["socket"] as? String ?? "", id: $0["id"] as? String ?? "", tool: $0["tool"] as? String ?? "tool",
                     preview: $0["preview"] as? String ?? "", project: $0["project"] as? String ?? "")
        }
        let sessions = ((j["sessions"] as? [[String: Any]]) ?? []).map {
            SessionRow(project: $0["project"] as? String ?? "", activity: $0["activity"] as? String ?? "", phase: $0["phase"] as? String ?? "")
        }
        return MacState(mac: j["mac"] as? String ?? "your Mac", approvals: approvals, sessions: sessions)
    }

    /// allow, deny or always.
    func answer(_ a: Approval, _ decision: String) async throws -> Bool {
        let j = try await call("answer", ["socket": a.socket, "id": a.id, "decision": decision])
        return j["ok"] as? Bool ?? false
    }
}

extension Data {
    init?(base64URL s: String) {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b += "=" }
        self.init(base64Encoded: b)
    }
}
