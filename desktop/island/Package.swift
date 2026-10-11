// swift-tools-version:5.10
// OX Island — a tiny ox that lives in the MacBook notch and watches your ox
// agent runs. Zero dependencies: SwiftUI + AppKit + POSIX sockets.
import PackageDescription

let package = Package(
    name: "OxIsland",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "OxIsland",
            path: "Sources/OxIsland"
        ),
    ]
)
