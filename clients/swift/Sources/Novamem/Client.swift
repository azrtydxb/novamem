import Foundation

/// The data-plane operations an agent needs. Project and token administration
/// live on Management and Admin, so an agent holding a Client cannot perform
/// them by accident.
public final class Client: Base, @unchecked Sendable {
    /// Durable write with semantic dedup. A declined worthiness gate is not an
    /// error: check `result.id`.
    public func capture(_ request: CaptureRequest) async throws -> CaptureResult {
        if Self.blank(request.content) {
            throw NovamemError(op: "capture", message: "content is required")
        }
        return try await Self.decode("capture", t.call("capture", "POST", "/v1/capture", body: Self.encode("capture", request)))
    }

    public func search(_ request: SearchRequest) async throws -> SearchResult {
        if Self.blank(request.query) {
            throw NovamemError(op: "search", message: "query is required")
        }
        let r = try await t.call("search", "POST", "/v1/search", body: Self.encode("search", request))
        try Self.degradedEmpty("search", r)
        return try Self.decode("search", r)
    }

    public func recent(_ request: RecentRequest = RecentRequest()) async throws -> EntryList {
        let r = try await t.call("recent", "POST", "/v1/recent", body: Self.encode("recent", request))
        try Self.degradedEmpty("recent", r)
        return try Self.decode("recent", r)
    }

    /// `recent` over the last 24 hours.
    public func today(_ request: RecentRequest = RecentRequest()) async throws -> EntryList {
        var r = request
        r.since = Wire.format(Date(timeIntervalSinceNow: -24 * 3600))
        return try await recent(r)
    }

    public func neighbors(_ request: NeighborsRequest) async throws -> SearchResult {
        if Self.blank(request.id) {
            throw NovamemError(op: "neighbors", message: "id is required")
        }
        let r = try await t.call("neighbors", "POST", "/v1/neighbors", body: Self.encode("neighbors", request))
        try Self.degradedEmpty("neighbors", r)
        return try Self.decode("neighbors", r)
    }

    /// Rewrite an entry in place, preserving its id, hits and edges.
    public func update(id: String, _ request: UpdateRequest = UpdateRequest()) async throws -> UpdateResult {
        if Self.blank(id) {
            throw NovamemError(op: "update", message: "id is required")
        }
        let trimmed = id.trimmingCharacters(in: .whitespaces)
        let r = try await t.call("update", "PUT", "/v1/memories/" + Self.seg(trimmed), body: Self.encode("update", request))
        var out: UpdateResult = try Self.decode("update", r)
        if out.id.isEmpty {
            out.id = trimmed
        }
        return out
    }

    /// Never reports success on a failed delete. An id that is not in your
    /// scope comes back `deleted: false` with no error.
    public func forget(_ request: ForgetRequest) async throws -> ForgetResult {
        if Self.blank(request.id) {
            throw NovamemError(op: "forget", message: "id is required")
        }
        do {
            return try await Self.decode("forget", t.call("forget", "POST", "/v1/forget", body: Self.encode("forget", request)))
        } catch let e as NovamemError where e.isNotFound {
            return ForgetResult(coldDeleteOk: true, deleted: false)
        }
    }

    /// Unconditional store: no worthiness gate, no dedup pass.
    public func remember(_ request: CaptureRequest) async throws -> RememberResult {
        if Self.blank(request.content) {
            throw NovamemError(op: "remember", message: "content is required")
        }
        return try await Self.decode("remember", t.call("remember", "POST", "/v1/remember", body: Self.encode("remember", request)))
    }

    public func context(_ request: ContextRequest) async throws -> SearchResult {
        if Self.blank(request.message) {
            throw NovamemError(op: "context", message: "message is required")
        }
        return try await Self.decode("context", t.call("context", "POST", "/v1/context", body: Self.encode("context", request)))
    }

    public func sessionRecap(_ request: SessionRecapRequest) async throws -> SessionRecapResult {
        try await Self.decode(
            "session-recap",
            t.call("session-recap", "POST", "/v1/session-recap", body: Self.encode("session-recap", request))
        )
    }

    /// A not-found error here means the server's observer is disabled.
    public func contextPrefix(project: String? = nil) async throws -> ContextPrefix {
        try await Self.decode("context-prefix", t.call("context-prefix", "GET", "/v1/context-prefix", query: ["project": project]))
    }

    public func stats() async throws -> Stats {
        try await Self.decode("stats", t.call("stats", "GET", "/v1/stats"))
    }

    /// A served `{"ok": false}` — including /health's own 503 — is an answer
    /// ("not healthy"), not an outage.
    public func health() async throws -> Bool {
        do {
            let h: Health = try await Self.decode("health", t.call("health", "GET", "/health"))
            return h.ok
        } catch let e as NovamemError where e.statusCode == 503 {
            return false
        }
    }
}
