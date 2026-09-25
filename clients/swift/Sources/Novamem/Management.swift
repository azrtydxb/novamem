import Foundation

/// The caller's own /v1/me/* surface: tokens, projects and members, the
/// active project, and the maintenance endpoints.
public final class Management: Base, @unchecked Sendable {
    public func mintToken(_ request: MintTokenRequest = MintTokenRequest()) async throws -> MintedToken {
        try await Self.decode("mint-token", t.call("mint-token", "POST", "/v1/me/tokens", body: Self.encode("mint-token", request)))
    }

    public func listTokens() async throws -> TokenList {
        try await Self.decode("list-tokens", t.call("list-tokens", "GET", "/v1/me/tokens"))
    }

    public func revokeToken(hash: String) async throws -> TokenDeleted {
        if Self.blank(hash) {
            throw NovamemError(op: "revoke-token", message: "tokenHash is required")
        }
        return try await Self.decode(
            "revoke-token",
            t.call("revoke-token", "DELETE", "/v1/me/tokens/" + Self.seg(hash.trimmingCharacters(in: .whitespaces)))
        )
    }

    public func listProjects() async throws -> ProjectList {
        try await Self.decode("list-projects", t.call("list-projects", "GET", "/v1/me/projects"))
    }

    public func createProject(name: String) async throws -> Project {
        if Self.blank(name) {
            throw NovamemError(op: "create-project", message: "name is required")
        }
        return try await Self.decode(
            "create-project",
            t.call("create-project", "POST", "/v1/me/projects", body: Self.object(["name": name]))
        )
    }

    public func deleteProject(id: String) async throws -> ProjectDeleted {
        if Self.blank(id) {
            throw NovamemError(op: "delete-project", message: "id is required")
        }
        return try await Self.decode("delete-project", t.call("delete-project", "DELETE", "/v1/me/projects/" + Self.seg(id)))
    }

    public func listProjectMembers(id: String) async throws -> MemberList {
        if Self.blank(id) {
            throw NovamemError(op: "list-members", message: "id is required")
        }
        return try await Self.decode("list-members", t.call("list-members", "GET", "/v1/me/projects/\(Self.seg(id))/members"))
    }

    /// Adds a user by their EXACT sign-in email (the wire field is named
    /// "username" for historical reasons). `role` is "member" or "owner".
    public func addProjectMember(id: String, email: String, role: String? = nil) async throws -> MemberAdded {
        if Self.blank(id) || Self.blank(email) {
            throw NovamemError(op: "add-member", message: "id and email are required")
        }
        return try await Self.decode("add-member", t.call("add-member", "POST", "/v1/me/projects/\(Self.seg(id))/members",
                                                          body: Self.fields([("username", email), ("role", role)])))
    }

    public func removeProjectMember(id: String, userId: String) async throws -> MemberRemoved {
        if Self.blank(id) || Self.blank(userId) {
            throw NovamemError(op: "remove-member", message: "id and userId are required")
        }
        return try await Self.decode(
            "remove-member",
            t.call("remove-member", "DELETE", "/v1/me/projects/\(Self.seg(id))/members/\(Self.seg(userId))")
        )
    }

    public func removeProjectMemberByUsername(id: String, username: String) async throws -> MemberRemoved {
        if Self.blank(id) || Self.blank(username) {
            throw NovamemError(op: "remove-member", message: "id and username are required")
        }
        let members = try await listProjectMembers(id: id).members
        guard let m = members.first(where: { $0.username == username && !Self.blank($0.userId) }), let userId = m.userId else {
            throw NovamemError(op: "remove-member", message: "unknown member '\(username)'")
        }
        return try await removeProjectMember(id: id, userId: userId)
    }

    public func activeProject() async throws -> ActiveProject {
        try await Self.decode("active-project", t.call("active-project", "GET", "/v1/me/active-project"))
    }

    public func setActiveProject(project: String) async throws -> ActiveProject {
        if Self.blank(project) {
            throw NovamemError(op: "set-active-project", message: "project is required")
        }
        return try await Self.decode(
            "set-active-project",
            t.call("set-active-project", "PUT", "/v1/me/active-project", body: Self.object(["project": project]))
        )
    }

    public func clearActiveProject() async throws {
        _ = try await t.call("clear-active-project", "DELETE", "/v1/me/active-project", expectBody: false)
    }

    public func decay(effectiveDays: Int? = nil) async throws -> DecayResult {
        try await Self.decode("decay", t.call("decay", "POST", "/v1/decay", body: Self.fields([("effectiveDays", effectiveDays)])))
    }

    public func hygiene(k: Int? = nil) async throws -> HygieneReport {
        try await Self.decode("hygiene", t.call("hygiene", "POST", "/v1/hygiene", body: Self.fields([("k", k)])))
    }

    public func evaluate(suite: String? = nil) async throws -> EvaluateReport {
        try await Self.decode("evaluate", t.call("evaluate", "POST", "/v1/evaluate", body: Self.fields([("suite", suite)])))
    }

    public func adoption(client: String? = nil) async throws -> AdoptionReport {
        try await Self.decode("adoption", t.call("adoption", "POST", "/v1/adoption", body: Self.fields([("client", client)])))
    }

    /// Throws a NovamemError with code "observer_disabled" when the server's
    /// observer is off — a configuration answer, not an outage.
    public func observe(project: String? = nil, limit: Int? = nil) async throws -> ObserveResult {
        do {
            return try await Self.decode(
                "observe",
                t.call("observe", "POST", "/v1/observe", body: Self.fields([("project", project), ("limit", limit)]))
            )
        } catch let e as NovamemError where e.statusCode == 503 {
            throw NovamemError(op: "observe", message: "observer disabled", statusCode: 503, code: "observer_disabled")
        }
    }

    public func changes(since: String? = nil, afterSeq: Int64? = nil, limit: Int? = nil) async throws -> ChangeFeed {
        try await Self.decode("changes", t.call("changes", "GET", "/v1/me/changes",
                                                query: [
                                                    "since": since.map(Wire.timestamp),
                                                    "afterSeq": afterSeq.map(String.init),
                                                    "limit": limit.map(String.init),
                                                ]))
    }

    public func usage() async throws -> Usage {
        try await Self.decode("usage", t.call("usage", "GET", "/v1/me/usage"))
    }

    /// One page, oldest first. Pass `nextAfterId` back as `afterId` until a
    /// page comes back with no entries.
    public func export(afterId: String? = nil, limit: Int? = nil) async throws -> ExportPage {
        try await Self.decode(
            "export",
            t.call("export", "GET", "/v1/me/export", query: ["afterId": afterId, "limit": limit.map(String.init)])
        )
    }

    /// Store 1-200 entries (an export page's entries fit as-is),
    /// unconditionally, deduplicated by content hash.
    public func `import`(entries: [JSONValue]) async throws -> ImportResult {
        if entries.isEmpty {
            throw NovamemError(op: "import", message: "entries are required")
        }
        let body = try Self.encode("import", ["entries": JSONValue.array(entries)])
        return try await Self.decode("import", t.call("import", "POST", "/v1/me/import", body: body))
    }
}
