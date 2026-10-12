// swift-tools-version:5.10
// OX Island — a tiny ox that lives in the MacBook notch and watches your ox
// agent runs. Zero dependencies: SwiftUI + AppKit + POSIX sockets.
import Foundation
import PackageDescription

// Info.plist is linked into the binary (__TEXT,__info_plist): macOS needs the
// microphone and speech-recognition usage strings before OX Buddy may listen.
let infoPlist = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Info.plist").path

let package = Package(
    name: "OxIsland",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "OxIsland",
            path: "Sources/OxIsland",
            // Rendered ox frames come from art/bull_render.py (Blender).
            resources: [.copy("Resources")],
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", infoPlist]),
            ]
        ),
    ]
)
