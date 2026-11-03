import Foundation

/// The island's pictures and data. Not Bundle.module: SwiftPM's accessor looks
/// beside the .app and then at the folder it was built in, and stops the program
/// when neither exists. ox installs these in Contents/Resources (src/island.js),
/// so on any Mac that did not build ox the island died the moment it started.
enum OxResources {
    static let bundle: Bundle = {
        let name = "OxIsland_OxIsland.bundle"
        let places = [Bundle.main.resourceURL, Bundle.main.bundleURL, Bundle.main.executableURL?.deletingLastPathComponent()]
        for place in places.compactMap({ $0 }) {
            if let found = Bundle(url: place.appendingPathComponent(name)) { return found }
        }
        // Missing pictures are drawn without; they are never worth a crash.
        return Bundle.main
    }()
}
