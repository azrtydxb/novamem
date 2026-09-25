// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Novamem",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "Novamem", targets: ["Novamem"]),
        .executable(name: "novamem-smoke", targets: ["NovamemSmoke"]),
    ],
    // Foundation only (ADR 0009): no dependencies, by design.
    targets: [
        .target(name: "Novamem"),
        .executableTarget(name: "NovamemSmoke", dependencies: ["Novamem"]),
        .testTarget(name: "NovamemTests", dependencies: ["Novamem"]),
    ]
)
