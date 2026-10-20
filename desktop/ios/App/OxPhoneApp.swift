import SwiftUI
import LocalAuthentication

// OX on your iPhone: what waits on your Mac (an agent asking to run a command),
// answered here or from the lock screen. Paired with `ox phone pair` on the Mac.

@main
struct OxPhoneApp: App {
    @StateObject private var model = PhoneModel()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            Group {
                if model.pairing == nil { PairView(model: model) } else { HomeView(model: model) }
            }
            .preferredColorScheme(.dark)
            .onOpenURL { model.pair(link: $0.absoluteString) }
        }
        .onChange(of: phase) { _, p in p == .active ? model.start() : model.stop() }
    }
}

@MainActor
final class PhoneModel: ObservableObject {
    @Published var pairing: Pairing? = PairingStore.load()
    @Published var state: MacState?
    @Published var error: String?
    @Published var busy: Set<String> = []
    private var timer: Timer?

    func pair(link: String) {
        guard let p = Pairing.parse(link) else { error = "That is not an OX pairing link. On your Mac: ox phone pair"; return }
        PairingStore.save(p)
        pairing = p
        error = nil
        start()
    }

    func forget() { PairingStore.clear(); pairing = nil; state = nil; stop() }

    func start() {
        guard pairing != nil else { return }
        stop()
        Task { await refresh() }
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in Task { await self?.refresh() } }
    }
    func stop() { timer?.invalidate(); timer = nil }

    func refresh() async {
        guard let p = pairing else { return }
        do {
            let s = try await OxLink(pairing: p).state()
            state = s
            error = nil
            await OxActivities.show(s)
        } catch { self.error = error.localizedDescription }
    }

    /// Allow and Always ask for Face ID (or the passcode) first; Deny does not.
    func answer(_ a: Approval, _ decision: String) async {
        if decision != "deny" {
            let ctx = LAContext()
            let ok = (try? await ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Let \(a.project) run \(a.tool) on your Mac")) ?? false
            guard ok else { return }
        }
        guard let p = pairing else { return }
        busy.insert(a.id)
        defer { busy.remove(a.id) }
        do { _ = try await OxLink(pairing: p).answer(a, decision); await refresh() } catch { self.error = error.localizedDescription }
    }
}

struct PairView: View {
    @ObservedObject var model: PhoneModel
    @State private var link = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("OX").font(.system(size: 44, weight: .heavy, design: .rounded))
            Text("Approve what your agents want to run on your Mac, here or from the lock screen.").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 8) {
                Text("1. On your Mac, run").font(.subheadline)
                Text("ox phone pair").font(.system(.body, design: .monospaced)).padding(8).background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.08)))
                Text("2. Scan the code it shows with the Camera, or paste the link here:").font(.subheadline)
            }
            TextField("oxphone://…", text: $link).textInputAutocapitalization(.never).autocorrectionDisabled().textFieldStyle(.roundedBorder)
            Button("Pair") { model.pair(link: link) }.buttonStyle(.borderedProminent).disabled(link.isEmpty)
            if let e = model.error { Text(e).font(.footnote).foregroundStyle(.red) }
            Spacer()
            Text("The link holds a key made for this phone only; everything between it and your Mac is encrypted.").font(.footnote).foregroundStyle(.secondary)
        }
        .padding(24)
    }
}

struct HomeView: View {
    @ObservedObject var model: PhoneModel
    var body: some View {
        NavigationStack {
            List {
                if let e = model.error { Section { Label(e, systemImage: "wifi.exclamationmark").foregroundStyle(.orange) } }
                Section(model.state?.approvals.isEmpty == false ? "Waiting for you" : "") {
                    if let s = model.state, !s.approvals.isEmpty {
                        ForEach(s.approvals) { a in ApprovalCard(approval: a, busy: model.busy.contains(a.id)) { d in Task { await model.answer(a, d) } } }
                    } else if model.state != nil {
                        Label("Nothing is waiting", systemImage: "checkmark.circle").foregroundStyle(.secondary)
                    }
                }
                if let s = model.state, !s.sessions.isEmpty {
                    Section("At work on \(s.mac)") {
                        ForEach(s.sessions) { r in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(r.project).font(.subheadline.weight(.semibold))
                                Text(r.activity).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                    }
                }
            }
            .navigationTitle(model.state?.mac ?? "OX")
            .refreshable { await model.refresh() }
            .toolbar { Menu { Button("Forget this Mac", role: .destructive) { model.forget() } } label: { Image(systemName: "ellipsis.circle") } }
        }
    }
}

struct ApprovalCard: View {
    let approval: Approval
    let busy: Bool
    let decide: (String) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Circle().fill(Color.orange).frame(width: 7, height: 7)
                Text("\(approval.project) wants to run \(approval.tool)").font(.subheadline.weight(.semibold))
            }
            Text(approval.preview.isEmpty ? approval.tool : approval.preview)
                .font(.system(.footnote, design: .monospaced)).lineLimit(4)
                .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.08)))
            HStack {
                Button("Deny") { decide("deny") }.buttonStyle(.bordered)
                Button("Always allow") { decide("always") }.buttonStyle(.bordered)
                Spacer()
                Button { decide("allow") } label: { Label("Allow", systemImage: "faceid") }.buttonStyle(.borderedProminent)
            }
            .disabled(busy)
        }
        .padding(.vertical, 4)
    }
}
