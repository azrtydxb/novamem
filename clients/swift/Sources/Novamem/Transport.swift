import Foundation
#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

/// Responses larger than this are rejected rather than kept.
public let maxResponseBytes = 8 << 20

/// The session's delegate. It routes each task's callbacks to its Exchange,
/// streams the body so an oversize answer is cut off at the limit instead
/// of buffered whole, and follows redirects without ever carrying the
/// bearer to another origin (Go's http.Client drops Authorization on a
/// cross-origin hop, and so does this).
final class SessionDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var exchanges: [Int: Exchange] = [:]

    func register(_ task: URLSessionTask, _ x: Exchange) {
        lock.lock()
        exchanges[task.taskIdentifier] = x
        lock.unlock()
    }

    private func lookup(_ task: URLSessionTask, remove: Bool = false) -> Exchange? {
        lock.lock()
        defer { lock.unlock() }
        return remove ? exchanges.removeValue(forKey: task.taskIdentifier) : exchanges[task.taskIdentifier]
    }

    func urlSession(_: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lookup(dataTask)?.append(data)
    }

    func urlSession(_: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lookup(task, remove: true)?.finish((task.response as? HTTPURLResponse)?.statusCode ?? 0, error)
    }

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

/// One request in flight. Whichever ends it first — completion, the
/// deadline, the caller's cancellation or the size limit — decides the
/// outcome, and the continuation is resumed exactly once.
final class Exchange: @unchecked Sendable {
    enum Stop { case cancelled, timedOut, oversize }

    private let lock = NSLock()
    private var task: URLSessionTask?
    private var continuation: CheckedContinuation<(Int, Data), Error>?
    private var body = Data()
    private var stop: Stop?
    private let failure: (Stop?, Int, Error?) -> Error

    init(failure: @escaping (Stop?, Int, Error?) -> Error) {
        self.failure = failure
    }

    /// A stop that arrived before the task existed still lands: the task is
    /// cancelled instead of started.
    func start(_ t: URLSessionTask, _ k: CheckedContinuation<(Int, Data), Error>) {
        lock.lock()
        task = t
        continuation = k
        let stopped = stop != nil
        lock.unlock()
        stopped ? t.cancel() : t.resume()
    }

    /// Ends the exchange early; the first reason given is the one reported.
    func halt(_ why: Stop) {
        lock.lock()
        if stop == nil {
            stop = why
        }
        let t = task
        lock.unlock()
        t?.cancel()
    }

    func append(_ d: Data) {
        lock.lock()
        let over = body.count + d.count > maxResponseBytes
        if !over {
            body.append(d)
        }
        lock.unlock()
        if over {
            halt(.oversize)
        }
    }

    func finish(_ status: Int, _ error: Error?) {
        lock.lock()
        let k = continuation
        continuation = nil
        let why = stop
        let data = body
        lock.unlock()
        guard let k else { return }
        if why == nil, error == nil {
            k.resume(returning: (status, data))
        } else {
            k.resume(throwing: failure(why, status, error))
        }
    }
}

/// One function makes every request, so failures are classified once.
final class Transport: @unchecked Sendable {
    let config: Config
    private let session: URLSession
    private let delegate = SessionDelegate()

    init(_ config: Config) {
        self.config = config
        let c = URLSessionConfiguration.ephemeral
        // The deadline is enforced by exchange(), not by URLSession:
        // swift-corelibs-foundation arms its timer with
        // Int(timeoutInterval) * 1000 ms, so a sub-second timeout becomes a
        // 0 ms one that fires before the request is sent. These are only a
        // backstop well past the real deadline.
        c.timeoutIntervalForRequest = config.timeout + 60
        c.timeoutIntervalForResource = config.timeout + 60
        session = URLSession(configuration: c, delegate: delegate, delegateQueue: nil)
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
        var req = URLRequest(url: comps.url!, timeoutInterval: config.timeout + 60)
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
        let x = Exchange { why, status, error in
            switch why {
            case .cancelled: CancellationError()
            case .timedOut: NovamemError(op: op, message: "timed out", unavailable: true, retryable: true)
            case .oversize: NovamemError(op: op, message: "response body exceeds 8 MiB", statusCode: status,
                                         unavailable: true)
            case nil: self.transportError(op, error ?? CancellationError())
            }
        }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (k: CheckedContinuation<(Int, Data), Error>) in
                let task = session.dataTask(with: req)
                delegate.register(task, x)
                DispatchQueue.global().asyncAfter(deadline: .now() + config.timeout) { x.halt(.timedOut) }
                x.start(task, k)
            }
        } onCancel: {
            x.halt(.cancelled)
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
        return NovamemError(op: op, message: redact("unreachable: \(e.localizedDescription)"), unavailable: true,
                            retryable: true)
    }

    private func decode(_ op: String, _ status: Int, _ raw: Data, _ expectBody: Bool) throws -> Data? {
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
        if let o = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any], let e = o["error"] as? String,
           !e.isEmpty
        {
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
