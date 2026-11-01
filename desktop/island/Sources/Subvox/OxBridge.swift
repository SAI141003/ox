// Subvox inside ox. Subvox is Joe Blau's prototype (github.com/joeblau/subvox,
// MIT, see LICENSE here): AirPods head motion → silently mouthed words, with a
// small-vocabulary DTW template recognizer and a permutation test that says
// whether the signal is real. Every screen and file of it is kept as it was;
// this file adds the two things ox needs:
//
//   SubvoxRootView   the whole app (Sensors, Train, Decode) as one view, for the
//                    "Silent words" window that OX Island opens
//   SubvoxOx.emit    an accepted word, appended to ~/.ox/subvox/words.jsonl when
//                    "Send words to ox" is on; OX Island reads it: with an
//                    approval waiting, a trained "yes"/"allow" allows once and
//                    "no"/"deny"/"stop" denies; any other word is shown
import SwiftUI

public enum SubvoxOx {
    static let key = "subvox.sendToOx"
    public static var sendToOx: Bool {
        get { UserDefaults.standard.bool(forKey: key) }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }

    public static var wordsFile: URL {
        let home = ProcessInfo.processInfo.environment["OX_HOME"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ox")
        return home.appendingPathComponent("subvox/words.jsonl")
    }

    static func emit(_ word: String, confidence: Double) {
        guard sendToOx else { return }
        let line: [String: Any] = ["word": word, "confidence": confidence, "at": Date().timeIntervalSince1970]
        guard let data = try? JSONSerialization.data(withJSONObject: line), var text = String(data: data, encoding: .utf8) else { return }
        text += "\n"
        let url = wordsFile
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile(); h.write(Data(text.utf8)); try? h.close()
        } else {
            try? Data(text.utf8).write(to: url)
        }
    }
}

struct SendToOxToggle: View {
    @State private var on = SubvoxOx.sendToOx
    var body: some View {
        Toggle(isOn: $on) { Label("Send words to ox", systemImage: "arrow.up.forward.app") }
            .toggleStyle(.button)
            .onChange(of: on) { _, v in SubvoxOx.sendToOx = v }
            .help("Accepted words go to OX Island: with an approval waiting, \"yes\" or \"allow\" allows once and \"no\", \"deny\" or \"stop\" denies")
    }
}

/// The whole Subvox app as one view.
public struct SubvoxRootView: View {
    @State private var model = AppModel()
    public init() {}
    public var body: some View {
        ContentView()
            .environment(model)
            .frame(minWidth: 980, minHeight: 680)
            .task { model.start() }
    }
}
