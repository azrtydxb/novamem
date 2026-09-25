import Foundation

/// Server administration, with an admin user's bearer: provisioning one
/// novamem user per agent, and revoking leaked tokens.
public final class Admin: Base, @unchecked Sendable {
    public func provisionUser(_ request: ProvisionUserRequest) async throws -> ProvisionedUser {
        if Self.blank(request.email) || request.password.isEmpty {
            throw NovamemError(op: "provision-user", message: "email and password are required")
        }
        return try await Self.decode(
            "provision-user",
            t.call("provision-user", "POST", "/v1/admin/users", body: Self.encode("provision-user", request))
        )
    }

    /// Revoke a bearer by presenting its plaintext.
    public func revokeUserToken(token: String) async throws -> RevokeResult {
        if Self.blank(token) {
            throw NovamemError(op: "revoke-user-token", message: "token is required")
        }
        return try await Self.decode(
            "revoke-user-token",
            t.call("revoke-user-token", "POST", "/v1/admin/tokens/revoke", body: Self.object(["token": token]))
        )
    }

    public func listUsers() async throws -> AdminUserList {
        try await Self.decode("list-users", t.call("list-users", "GET", "/v1/admin/users"))
    }

    public func previewDeleteUser(id: String) async throws -> UserDeletionPreview {
        if Self.blank(id) {
            throw NovamemError(op: "preview-delete-user", message: "userID is required")
        }
        return try await Self.decode(
            "preview-delete-user",
            t.call("preview-delete-user", "DELETE", "/v1/admin/users/" + Self.seg(id), query: ["dryRun": "true"])
        )
    }

    public func deleteUser(id: String) async throws -> UserDeletion {
        if Self.blank(id) {
            throw NovamemError(op: "delete-user", message: "userID is required")
        }
        return try await Self.decode("delete-user", t.call("delete-user", "DELETE", "/v1/admin/users/" + Self.seg(id)))
    }

    /// nil clears that override (it is sent as JSON null).
    public func setUserQuota(id: String, maxEntries: Int? = nil, writesPerMinute: Int? = nil) async throws -> QuotaResult {
        if Self.blank(id) {
            throw NovamemError(op: "set-user-quota", message: "userID is required")
        }
        return try await Self.decode("set-user-quota", t.call("set-user-quota", "PUT", "/v1/admin/users/\(Self.seg(id))/quota",
                                                              body: Self.object([
                                                                  "maxEntries": maxEntries,
                                                                  "writesPerMinute": writesPerMinute,
                                                              ])))
    }
}
