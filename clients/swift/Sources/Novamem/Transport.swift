import Foundation
#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

/// Responses larger than this are rejected rather than kept.
public let maxResponseBytes = 8 << 20

/// Follows redirects, but never carries the bearer to another origin: Go's
/// http.Client drops Authorization on a cross-origin hop, and so does this.
final class SameOriginAuth: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_: URLSession, task: URLSessionTask, willPerformHTTPRedirection _: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void)
    {
        // URLSession builds the redirected request without Authorization, so
        // a same-origin hop has to carry it over explicitly; a cross-origin
        // one must not.
        var next = request
        let from = task.currentRequest ?? task.originalRequest
        if let from, let a = from.url, let b = request.url, Self.sameOrigin(a, b) {
            next.setValue(from.value(forHTTPHeaderField: "Authorization"), forHTTPHeaderField: "Authorization")
        } else {
            next.setValue(nil, forHTTPHeaderField: "Authorization")
        }
        completionHandler(next)
    }

    static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        func port(_ u: URL) -> Int {
            u.port ?? (u.scheme == "https" ? 443 : 80)
        }
        return a.scheme == b.scheme && a.host?.lowercased() == b.host?.lowercased() && port(a) == port(b)
    }
}

/// One function makes every request, so failures are classified once.
final class Transport: @unchecked Sendable {
    let config: Config
    private let session: URLSession

    init(_ config: Config) {
        self.config = config
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = config.timeout
        c.timeoutIntervalForResource = config.timeout
        session = URLSession(configuration: c, delegate: SameOriginAuth(), delegateQueue: nil)
    }

    deinit { session.finishTasksAndInvalidate() }

    private func redact(_ s: String) -> String {
        s.replacingOccurrences(of: config.token, with: "[redacted]")
    }

    /// Performs one request; returns its status and JSON bytes (nil when
    /// `expectBody` is false) or throws NovamemError / CancellationError.
    func call(_ op: String, _ method: String, _ path: String, body: Data? = nil,
              query: [String: String?] = [:], expectBody: Bool = true) async throws -> (status: Int, body: Data?)
    {
        var comps = URLComponents(string: config.baseURL + path)!
        let q = query.compactMap { k, v in v.flatMap { $0.isEmpty ? nil : URLQueryItem(name: k, value: $0) } }
        if !q.isEmpty {
            comps.queryItems = q.sorted { $0.name < $1.name }
        }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (status, raw) = try await exchange(op, req)
        return try (status, decode(op, status, raw, expectBody))
    }

    private func exchange(_ op: String, _ req: URLRequest) async throws -> (Int, Data) {
        let box = TaskBox()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (k: CheckedContinuation<(Int, Data), Error>) in
                let task = session.dataTask(with: req) { data, response, error in
                    if let error {
                        k.resume(throwing: self.transportError(op, error))
                        return
                    }
                    k.resume(returning: ((response as? HTTPURLResponse)?.statusCode ?? 0, data ?? Data()))
                }
                box.set(task)
                task.resume()
            }
        } onCancel: {
            box.cancel()
        }
    }

    private func transportError(_ op: String, _ error: Error) -> Error {
        let e = error as NSError
        if e.domain == NSURLErrorDomain, e.code == NSURLErrorCancelled {
            return CancellationError()
        }
        if e.domain == NSURLErrorDomain, e.code == NSURLErrorTimedOut {
            return NovamemError(op: op, message: "timed out", unavailable: true, retryable: true)
        }
        // Refused dial, DNS, reset, TLS: the host could not be consulted.
        return NovamemError(op: op, message: redact("unreachable: \(e.localizedDescription)"), unavailable: true, retryable: true)
    }

    private func decode(_ op: String, _ status: Int, _ raw: Data, _ expectBody: Bool) throws -> Data? {
        if raw.count > maxResponseBytes {
            throw NovamemError(op: op, message: "response body exceeds 8 MiB", statusCode: status, unavailable: true)
        }
        guard (200 ..< 300).contains(status) else { throw httpError(op, status, raw) }
        if !expectBody {
            return nil
        }
        // A 2xx with no body is not the contract: decoding it into a default
        // would tell a forget caller the delete happened.
        if String(decoding: raw, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw NovamemError(op: op, message: "empty response body", statusCode: status, unavailable: true)
        }
        // In practice a proxy's HTML error page: we never reached a working
        // novamem. Not retryable — the same request parses the same way.
        guard (try? JSONSerialization.jsonObject(with: raw, options: [.fragmentsAllowed])) != nil else {
            throw NovamemError(op: op, message: "malformed response body", statusCode: status, unavailable: true)
        }
        return raw
    }

    private func httpError(_ op: String, _ status: Int, _ raw: Data) -> NovamemError {
        var message = ""
        var code = ""
        if let o = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any], let e = o["error"] as? String, !e.isEmpty {
            message = e
            code = (o["code"] as? String) ?? ""
        }
        if message.isEmpty {
            let text = String(decoding: raw, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            message = text.count > 256 ? String(text.prefix(256)) + "…" : text
        }
        // The server's message and code are quoted verbatim; a server echoing
        // the credential back would otherwise launder it into the logs.
        let unavailable = status >= 500 || status == 429
        return NovamemError(op: op, message: redact(message), statusCode: status, code: redact(code),
                            unavailable: unavailable, retryable: unavailable)
    }
}

/// Holds a task so a cancellation arriving before it exists still lands.
private final class TaskBox: @unchecked Sendable {
    private let lock = NSLock()
    private var task: URLSessionTask?
    private var cancelled = false

    func set(_ t: URLSessionTask) {
        lock.lock()
        task = t
        let c = cancelled
        lock.unlock()
        if c {
            t.cancel()
        }
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let t = task
        lock.unlock()
        t?.cancel()
    }
}
