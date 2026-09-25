using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Novamem;

/// <summary>
/// The caller's own /v1/me/* surface: tokens, projects and members, the active
/// project, and the maintenance endpoints.
/// </summary>
public sealed class Management : Base
{
    public Management(NovamemOptions options)
        : base(options) { }

    public Task<MintedToken> MintTokenAsync(
        MintTokenRequest? request = null,
        CancellationToken ct = default
    ) =>
        Call<MintedToken>(
            "mint-token",
            HttpMethod.Post,
            "/v1/me/tokens",
            request ?? new MintTokenRequest(),
            ct
        );

    public Task<TokenList> ListTokensAsync(CancellationToken ct = default) =>
        Call<TokenList>("list-tokens", HttpMethod.Get, "/v1/me/tokens", null, ct);

    public Task<TokenDeleted> RevokeTokenAsync(string hash, CancellationToken ct = default)
    {
        if (Blank(hash))
            throw new NovamemException("revoke-token", "tokenHash is required");
        return Call<TokenDeleted>(
            "revoke-token",
            HttpMethod.Delete,
            "/v1/me/tokens/" + Seg(hash.Trim()),
            null,
            ct
        );
    }

    public Task<ProjectList> ListProjectsAsync(CancellationToken ct = default) =>
        Call<ProjectList>("list-projects", HttpMethod.Get, "/v1/me/projects", null, ct);

    public Task<Project> CreateProjectAsync(string name, CancellationToken ct = default)
    {
        if (Blank(name))
            throw new NovamemException("create-project", "name is required");
        return Call<Project>(
            "create-project",
            HttpMethod.Post,
            "/v1/me/projects",
            Fields(("name", name)),
            ct
        );
    }

    public Task<ProjectDeleted> DeleteProjectAsync(string id, CancellationToken ct = default)
    {
        if (Blank(id))
            throw new NovamemException("delete-project", "id is required");
        return Call<ProjectDeleted>(
            "delete-project",
            HttpMethod.Delete,
            "/v1/me/projects/" + Seg(id),
            null,
            ct
        );
    }

    public Task<MemberList> ListProjectMembersAsync(string id, CancellationToken ct = default)
    {
        if (Blank(id))
            throw new NovamemException("list-members", "id is required");
        return Call<MemberList>(
            "list-members",
            HttpMethod.Get,
            $"/v1/me/projects/{Seg(id)}/members",
            null,
            ct
        );
    }

    /// <summary>
    /// Adds a user by their EXACT sign-in email (the wire field is named
    /// "username" for historical reasons). role is "member" or "owner".
    /// </summary>
    public Task<MemberAdded> AddProjectMemberAsync(
        string id,
        string email,
        string? role = null,
        CancellationToken ct = default
    )
    {
        if (Blank(id) || Blank(email))
            throw new NovamemException("add-member", "id and email are required");
        return Call<MemberAdded>(
            "add-member",
            HttpMethod.Post,
            $"/v1/me/projects/{Seg(id)}/members",
            Fields(("username", email), ("role", role)),
            ct
        );
    }

    public Task<MemberRemoved> RemoveProjectMemberAsync(
        string id,
        string userId,
        CancellationToken ct = default
    )
    {
        if (Blank(id) || Blank(userId))
            throw new NovamemException("remove-member", "id and userId are required");
        return Call<MemberRemoved>(
            "remove-member",
            HttpMethod.Delete,
            $"/v1/me/projects/{Seg(id)}/members/{Seg(userId)}",
            null,
            ct
        );
    }

    public async Task<MemberRemoved> RemoveProjectMemberByUsernameAsync(
        string id,
        string username,
        CancellationToken ct = default
    )
    {
        if (Blank(id) || Blank(username))
            throw new NovamemException("remove-member", "id and username are required");
        var members = (await ListProjectMembersAsync(id, ct).ConfigureAwait(false)).Members;
        var m = members.FirstOrDefault(x => x.Username == username && !Blank(x.UserId));
        if (m is null)
            throw new NovamemException("remove-member", $"unknown member '{username}'");
        return await RemoveProjectMemberAsync(id, m.UserId!, ct).ConfigureAwait(false);
    }

    public Task<ActiveProject> ActiveProjectAsync(CancellationToken ct = default) =>
        Call<ActiveProject>("active-project", HttpMethod.Get, "/v1/me/active-project", null, ct);

    public Task<ActiveProject> SetActiveProjectAsync(string project, CancellationToken ct = default)
    {
        if (Blank(project))
            throw new NovamemException("set-active-project", "project is required");
        return Call<ActiveProject>(
            "set-active-project",
            HttpMethod.Put,
            "/v1/me/active-project",
            Fields(("project", project)),
            ct
        );
    }

    public Task ClearActiveProjectAsync(CancellationToken ct = default) =>
        T.CallAsync(
            "clear-active-project",
            HttpMethod.Delete,
            "/v1/me/active-project",
            null,
            null,
            false,
            ct
        );

    public Task<DecayResult> DecayAsync(
        int? effectiveDays = null,
        CancellationToken ct = default
    ) =>
        Call<DecayResult>(
            "decay",
            HttpMethod.Post,
            "/v1/decay",
            Fields(("effectiveDays", effectiveDays)),
            ct
        );

    public Task<HygieneReport> HygieneAsync(int? k = null, CancellationToken ct = default) =>
        Call<HygieneReport>("hygiene", HttpMethod.Post, "/v1/hygiene", Fields(("k", k)), ct);

    public Task<EvaluateReport> EvaluateAsync(
        string? suite = null,
        CancellationToken ct = default
    ) =>
        Call<EvaluateReport>(
            "evaluate",
            HttpMethod.Post,
            "/v1/evaluate",
            Fields(("suite", suite)),
            ct
        );

    public Task<AdoptionReport> AdoptionAsync(
        string? client = null,
        CancellationToken ct = default
    ) =>
        Call<AdoptionReport>(
            "adoption",
            HttpMethod.Post,
            "/v1/adoption",
            Fields(("client", client)),
            ct
        );

    /// <summary>
    /// Throws a NovamemException with Code "observer_disabled" when the
    /// server's observer is off — a configuration answer, not an outage.
    /// </summary>
    public async Task<ObserveResult> ObserveAsync(
        string? project = null,
        int? limit = null,
        CancellationToken ct = default
    )
    {
        try
        {
            return await Call<ObserveResult>(
                    "observe",
                    HttpMethod.Post,
                    "/v1/observe",
                    Fields(("project", project), ("limit", limit)),
                    ct
                )
                .ConfigureAwait(false);
        }
        catch (NovamemException e) when (e.StatusCode == 503)
        {
            throw new NovamemException("observe", "observer disabled", 503, "observer_disabled");
        }
    }

    public Task<ChangeFeed> ChangesAsync(
        string? since = null,
        long? afterSeq = null,
        int? limit = null,
        CancellationToken ct = default
    ) =>
        Call<ChangeFeed>(
            "changes",
            HttpMethod.Get,
            "/v1/me/changes",
            null,
            ct,
            new Dictionary<string, string?>
            {
                ["since"] = since is null ? null : TimestampConverter.Normalize(since),
                ["afterSeq"] = afterSeq?.ToString(CultureInfo.InvariantCulture),
                ["limit"] = limit?.ToString(CultureInfo.InvariantCulture),
            }
        );

    public Task<Usage> UsageAsync(CancellationToken ct = default) =>
        Call<Usage>("usage", HttpMethod.Get, "/v1/me/usage", null, ct);

    /// <summary>One page, oldest first. Pass NextAfterId back as afterId until a page comes back with no entries.</summary>
    public Task<ExportPage> ExportAsync(
        string? afterId = null,
        int? limit = null,
        CancellationToken ct = default
    ) =>
        Call<ExportPage>(
            "export",
            HttpMethod.Get,
            "/v1/me/export",
            null,
            ct,
            new Dictionary<string, string?>
            {
                ["afterId"] = afterId,
                ["limit"] = limit?.ToString(CultureInfo.InvariantCulture),
            }
        );

    /// <summary>Store 1-200 entries (an export page's entries fit as-is), unconditionally, deduplicated by content hash.</summary>
    public Task<ImportResult> ImportAsync(
        IEnumerable<JsonElement> entries,
        CancellationToken ct = default
    )
    {
        var list = entries?.ToList() ?? new List<JsonElement>();
        if (list.Count == 0)
            throw new NovamemException("import", "entries are required");
        return Call<ImportResult>(
            "import",
            HttpMethod.Post,
            "/v1/me/import",
            new Dictionary<string, object?> { ["entries"] = list },
            ct
        );
    }
}
