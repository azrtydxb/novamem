import Foundation

/// Everything a client needs, all of it injected: nothing is read from the
/// environment.
public struct Config: Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public static let defaultTimeout: TimeInterval = 15

    /// The service root, e.g. "https://novamem.example.com".
    public let baseURL: String
    /// Bounds each call, even one given no deadline.
    public let timeout: TimeInterval
    let token: String

    /// Fails on a missing or unusable setting, naming the field and never
    /// quoting the value.
    public init(baseURL: String, token: String, timeout: TimeInterval = Config.defaultTimeout) throws {
        var base = baseURL.trimmingCharacters(in: .whitespaces)
        while base.hasSuffix("/") {
            base.removeLast()
        }
        guard let u = URL(string: base), ["http", "https"].contains(u.scheme ?? ""), !(u.host ?? "").isEmpty else {
            throw NovamemError(op: "config", message: "baseURL is not an absolute http(s) URL")
        }
        guard !token.trimmingCharacters(in: .whitespaces).isEmpty else {
            throw NovamemError(op: "config", message: "token is required")
        }
        self.baseURL = base
        self.token = token
        self.timeout = timeout > 0 ? timeout : Config.defaultTimeout
    }

    public var description: String {
        "Config(baseURL: \(baseURL), token: [redacted])"
    }

    public var debugDescription: String {
        description
    }
}
