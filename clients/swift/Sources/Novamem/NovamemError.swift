import Foundation

/// Every failure of a call. Never contains the bearer token.
///
/// The one question every caller must be able to answer is "could the store
/// be consulted?" — `isUnavailable`. It is true for a refused dial, a timeout,
/// a 5xx, a 429, or a body that is not the JSON the API promises. Any other
/// error is a real answer that was not success: a rejected token, a bad
/// request, an id that is not in your scope (`isNotFound`). An empty result
/// with no error is the only thing this SDK presents as "nothing is stored".
/// A cancelled task throws `CancellationError`.
public struct NovamemError: Error, CustomStringConvertible, CustomDebugStringConvertible, Sendable, Equatable {
    /// The client method that failed ("search", "remove-member", …).
    public let op: String
    /// The HTTP status, or 0 when no response was received.
    public let statusCode: Int
    /// The server's machine-readable error code, when it sent one.
    public let code: String
    /// The server's message, or a description of the transport failure.
    public let message: String
    /// The store could not be consulted. Say so; do not claim ignorance.
    public let isUnavailable: Bool
    /// Calling again could plausibly succeed. The SDK never retries for you.
    public let isRetryable: Bool
    /// The store answered: that id is not in your scope.
    public var isNotFound: Bool {
        statusCode == 404
    }

    init(op: String, message: String, statusCode: Int = 0, code: String = "", unavailable: Bool = false, retryable: Bool = false) {
        self.op = op
        self.message = message
        self.statusCode = statusCode
        self.code = code
        isUnavailable = unavailable
        isRetryable = retryable
    }

    public var description: String {
        var s = "novamem \(op)"
        if statusCode != 0 {
            s += ": \(statusCode)"
        }
        if !code.isEmpty {
            s += " [\(code)]"
        }
        if !message.isEmpty {
            s += ": \(message)"
        }
        return s
    }

    public var debugDescription: String {
        "NovamemError(op: \(op), statusCode: \(statusCode), code: \(code), message: \(message), retryable: \(isRetryable))"
    }
}
