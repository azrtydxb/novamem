using System.Collections.Generic;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace Novamem;

/// <summary>
/// Server administration, with an admin user's bearer: provisioning one novamem
/// user per agent, and revoking leaked tokens.
/// </summary>
public sealed class Admin : Base
{
    public Admin(NovamemOptions options)
        : base(options) { }

    public Task<ProvisionedUser> ProvisionUserAsync(
        ProvisionUserRequest request,
        CancellationToken ct = default
    )
    {
        if (Blank(request.Email) || string.IsNullOrEmpty(request.Password))
            throw new NovamemException("provision-user", "email and password are required");
        return Call<ProvisionedUser>(
            "provision-user",
            HttpMethod.Post,
            "/v1/admin/users",
            request,
            ct
        );
    }

    /// <summary>Revoke a bearer by presenting its plaintext.</summary>
    public Task<RevokeResult> RevokeUserTokenAsync(string token, CancellationToken ct = default)
    {
        if (Blank(token))
            throw new NovamemException("revoke-user-token", "token is required");
        return Call<RevokeResult>(
            "revoke-user-token",
            HttpMethod.Post,
            "/v1/admin/tokens/revoke",
            Fields(("token", token)),
            ct
        );
    }

    public Task<AdminUserList> ListUsersAsync(CancellationToken ct = default) =>
        Call<AdminUserList>("list-users", HttpMethod.Get, "/v1/admin/users", null, ct);

    public Task<UserDeletionPreview> PreviewDeleteUserAsync(
        string id,
        CancellationToken ct = default
    )
    {
        if (Blank(id))
            throw new NovamemException("preview-delete-user", "userID is required");
        return Call<UserDeletionPreview>(
            "preview-delete-user",
            HttpMethod.Delete,
            "/v1/admin/users/" + Seg(id),
            null,
            ct,
            new Dictionary<string, string?> { ["dryRun"] = "true" }
        );
    }

    public Task<UserDeletion> DeleteUserAsync(string id, CancellationToken ct = default)
    {
        if (Blank(id))
            throw new NovamemException("delete-user", "userID is required");
        return Call<UserDeletion>(
            "delete-user",
            HttpMethod.Delete,
            "/v1/admin/users/" + Seg(id),
            null,
            ct
        );
    }

    /// <summary>null clears that override (it is sent as JSON null).</summary>
    public Task<QuotaResult> SetUserQuotaAsync(
        string id,
        int? maxEntries = null,
        int? writesPerMinute = null,
        CancellationToken ct = default
    )
    {
        if (Blank(id))
            throw new NovamemException("set-user-quota", "userID is required");
        return Call<QuotaResult>(
            "set-user-quota",
            HttpMethod.Put,
            $"/v1/admin/users/{Seg(id)}/quota",
            new Dictionary<string, object?>
            {
                ["maxEntries"] = maxEntries,
                ["writesPerMinute"] = writesPerMinute,
            },
            ct
        );
    }
}
