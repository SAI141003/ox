import Foundation
import ActivityKit
import AppIntents
import Security

// The Live Activity on the lock screen and in the Dynamic Island: the approval
// waiting on your Mac, with Deny and Allow. Allow asks for Face ID first (the
// system unlocks before the intent runs); Deny never needs it.

struct OxApprovalAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var approval: Approval?
        var waiting: Int
        var note: String
    }
    var mac: String
}

// The pairing, in this app's Keychain (only on this device, after first unlock).
enum PairingStore {
    private static let service = "ai.ox.phone.pairing"
    static func save(_ p: Pairing) {
        let data = (try? JSONEncoder().encode(p)) ?? Data()
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        SecItemDelete(q as CFDictionary)
        var add = q
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
    static func load() -> Pairing? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return try? JSONDecoder().decode(Pairing.self, from: d)
    }
    static func clear() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary)
    }
}

enum OxActivities {
    /// Show (or update) what is waiting; end the activity when nothing is.
    static func show(_ state: MacState) async {
        let first = state.approvals.first
        let content = OxApprovalAttributes.ContentState(approval: first, waiting: state.approvals.count, note: first == nil ? "Nothing is waiting" : "")
        let live = Activity<OxApprovalAttributes>.activities
        if first == nil {
            for a in live { await a.end(ActivityContent(state: content, staleDate: nil), dismissalPolicy: .immediate) }
            return
        }
        if let a = live.first {
            await a.update(ActivityContent(state: content, staleDate: Date().addingTimeInterval(15 * 60)), alertConfiguration: a.content.state.approval?.id == first?.id ? nil : AlertConfiguration(title: "\(first!.project) wants to run \(first!.tool)", body: "\(first!.preview)", sound: .default))
        } else if ActivityAuthorizationInfo().areActivitiesEnabled {
            _ = try? Activity.request(attributes: OxApprovalAttributes(mac: state.mac), content: ActivityContent(state: content, staleDate: Date().addingTimeInterval(15 * 60)))
        }
    }

    static func answer(socket: String, id: String, decision: String) async throws {
        guard let p = PairingStore.load() else { throw OxLinkError.notPaired }
        let link = OxLink(pairing: p)
        let a = Approval(socket: socket, id: id, tool: "", preview: "", project: "")
        _ = try await link.answer(a, decision)
        if let s = try? await link.state() { await show(s) }
    }
}

/// Allow from the lock screen: the system asks for Face ID before this runs.
struct AllowIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Allow"
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    @Parameter(title: "Socket") var socket: String
    @Parameter(title: "Approval") var approvalId: String
    init() {}
    init(socket: String, approvalId: String) { self.socket = socket; self.approvalId = approvalId }
    func perform() async throws -> some IntentResult {
        try await OxActivities.answer(socket: socket, id: approvalId, decision: "allow")
        return .result()
    }
}

/// Deny never needs unlocking: saying no is always safe.
struct DenyIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Deny"
    @Parameter(title: "Socket") var socket: String
    @Parameter(title: "Approval") var approvalId: String
    init() {}
    init(socket: String, approvalId: String) { self.socket = socket; self.approvalId = approvalId }
    func perform() async throws -> some IntentResult {
        try await OxActivities.answer(socket: socket, id: approvalId, decision: "deny")
        return .result()
    }
}
