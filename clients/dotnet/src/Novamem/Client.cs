using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace Novamem;

/// <summary>
/// The data-plane operations an agent needs. Project and token administration
/// live on Management and Admin, so an agent holding a Client cannot perform
/// them by accident.
/// </summary>
public sealed class Client : Base
{
    /// <summary>Validates the options: a bad BaseUrl or blank Token fails here, not on every call.</summary>
    public Client(NovamemOptions options)
        : base(options) { }

    /// <summary>Durable write with semantic dedup. A declined worthiness gate is not an error: check Id.</summary>
    public Task<CaptureResult> CaptureAsync(CaptureRequest request, CancellationToken ct = default)
    {
        if (Blank(request.Content))
            throw new NovamemException("capture", "content is required");
        return Call<CaptureResult>("capture", HttpMethod.Post, "/v1/capture", request, ct);
    }

    public Task<SearchResult> SearchAsync(SearchRequest request, CancellationToken ct = default)
    {
        if (Blank(request.Query))
            throw new NovamemException("search", "query is required");
        return Call<SearchResult>(
            "search",
            HttpMethod.Post,
            "/v1/search",
            request,
            ct,
            degradedCheck: true
        );
    }

    public Task<EntryList> RecentAsync(
        RecentRequest? request = null,
        CancellationToken ct = default
    ) =>
        Call<EntryList>(
            "recent",
            HttpMethod.Post,
            "/v1/recent",
            request ?? new RecentRequest(),
            ct,
            degradedCheck: true
        );

    /// <summary>RecentAsync over the last 24 hours.</summary>
    public Task<EntryList> TodayAsync(
        RecentRequest? request = null,
        CancellationToken ct = default
    ) =>
        RecentAsync(
            (request ?? new RecentRequest()) with
            {
                Since = DateTimeOffset
                    .UtcNow.AddHours(-24)
                    .ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
            },
            ct
        );

    public Task<SearchResult> NeighborsAsync(
        NeighborsRequest request,
        CancellationToken ct = default
    )
    {
        if (Blank(request.Id))
            throw new NovamemException("neighbors", "id is required");
        return Call<SearchResult>(
            "neighbors",
            HttpMethod.Post,
            "/v1/neighbors",
            request,
            ct,
            degradedCheck: true
        );
    }

    /// <summary>Rewrite an entry in place, preserving its id, hits and edges.</summary>
    public async Task<UpdateResult> UpdateAsync(
        string id,
        UpdateRequest? request = null,
        CancellationToken ct = default
    )
    {
        if (Blank(id))
            throw new NovamemException("update", "id is required");
        var r = await Call<UpdateResult>(
                "update",
                HttpMethod.Put,
                "/v1/memories/" + Seg(id.Trim()),
                request ?? new UpdateRequest(),
                ct
            )
            .ConfigureAwait(false);
        return string.IsNullOrEmpty(r.Id) ? r with { Id = id.Trim() } : r;
    }

    /// <summary>
    /// Never reports success on a failed delete. An id that is not in your
    /// scope comes back Deleted = false with no error.
    /// </summary>
    public async Task<ForgetResult> ForgetAsync(
        ForgetRequest request,
        CancellationToken ct = default
    )
    {
        if (Blank(request.Id))
            throw new NovamemException("forget", "id is required");
        try
        {
            return await Call<ForgetResult>("forget", HttpMethod.Post, "/v1/forget", request, ct)
                .ConfigureAwait(false);
        }
        catch (NovamemException e) when (e.IsNotFound)
        {
            return new ForgetResult { Deleted = false, ColdDeleteOk = true };
        }
    }

    /// <summary>Unconditional store: no worthiness gate, no dedup pass.</summary>
    public Task<RememberResult> RememberAsync(
        CaptureRequest request,
        CancellationToken ct = default
    )
    {
        if (Blank(request.Content))
            throw new NovamemException("remember", "content is required");
        return Call<RememberResult>("remember", HttpMethod.Post, "/v1/remember", request, ct);
    }

    public Task<SearchResult> ContextAsync(ContextRequest request, CancellationToken ct = default)
    {
        if (Blank(request.Message))
            throw new NovamemException("context", "message is required");
        return Call<SearchResult>("context", HttpMethod.Post, "/v1/context", request, ct);
    }

    public Task<SessionRecapResult> SessionRecapAsync(
        SessionRecapRequest request,
        CancellationToken ct = default
    ) =>
        Call<SessionRecapResult>(
            "session-recap",
            HttpMethod.Post,
            "/v1/session-recap",
            request,
            ct
        );

    /// <summary>A not-found exception here means the server's observer is disabled.</summary>
    public Task<ContextPrefix> ContextPrefixAsync(
        string? project = null,
        CancellationToken ct = default
    ) =>
        Call<ContextPrefix>(
            "context-prefix",
            HttpMethod.Get,
            "/v1/context-prefix",
            null,
            ct,
            new Dictionary<string, string?> { ["project"] = project }
        );

    public Task<Stats> StatsAsync(CancellationToken ct = default) =>
        Call<Stats>("stats", HttpMethod.Get, "/v1/stats", null, ct);

    /// <summary>A served {"ok": false} — including /health's own 503 — is an answer ("not healthy"), not an outage.</summary>
    public async Task<bool> HealthAsync(CancellationToken ct = default)
    {
        try
        {
            return (
                await Call<Health>("health", HttpMethod.Get, "/health", null, ct)
                    .ConfigureAwait(false)
            ).Ok;
        }
        catch (NovamemException e) when (e.StatusCode == 503)
        {
            return false;
        }
    }
}
