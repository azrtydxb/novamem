using System.Collections.Generic;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Novamem;

/// <summary>Shared by Client, Management and Admin. Safe to share across threads.</summary>
public abstract class Base
{
    private protected readonly Transport T;

    private protected Base(NovamemOptions options)
    {
        T = new Transport(options);
    }

    /// <inheritdoc />
    public override string ToString() =>
        $"{GetType().Name} {{ BaseUrl = {T.BaseUrl}, Token = [redacted] }}";

    private protected static bool Blank(string? s) => string.IsNullOrWhiteSpace(s);

    private protected static string Seg(string s) => System.Uri.EscapeDataString(s);

    /// <summary>An object of the given fields, leaving out unset and empty ones.</summary>
    private protected static Dictionary<string, object?> Fields(
        params (string Key, object? Value)[] pairs
    )
    {
        var o = new Dictionary<string, object?>();
        foreach (var (k, v) in pairs)
            if (v is not null && !(v is string s && s.Length == 0))
                o[k] = v;
        return o;
    }

    private protected async Task<TOut> Call<TOut>(
        string op,
        HttpMethod method,
        string path,
        object? body,
        CancellationToken ct,
        IReadOnlyDictionary<string, string?>? query = null,
        bool degradedCheck = false
    )
    {
        var (status, raw) = await T.CallAsync(op, method, path, body, query, true, ct)
            .ConfigureAwait(false);
        if (degradedCheck)
            DegradedEmpty(op, raw!);
        return Decode<TOut>(op, status, raw!);
    }

    private protected static TOut Decode<TOut>(string op, int status, byte[] raw)
    {
        try
        {
            return JsonSerializer.Deserialize<TOut>(raw, Json.Options)!;
        }
        catch (JsonException)
        {
            // Valid JSON of the wrong shape: the store did not answer as the API promises.
            throw new NovamemException(op, "malformed response body", status, unavailable: true);
        }
    }

    /// <summary>
    /// A degraded answer with no results is an outage wearing the costume of
    /// an empty result set. A degraded answer WITH results is real data.
    /// </summary>
    static void DegradedEmpty(string op, byte[] raw)
    {
        using var doc = JsonDocument.Parse(raw);
        var r = doc.RootElement;
        if (r.ValueKind != JsonValueKind.Object)
            return;
        var degraded = r.TryGetProperty("degraded", out var d) && d.ValueKind == JsonValueKind.True;
        var empty =
            !r.TryGetProperty("results", out var res)
            || res.ValueKind != JsonValueKind.Array
            || res.GetArrayLength() == 0;
        if (degraded && empty)
            throw new NovamemException(
                op,
                "store answered degraded with no results, so this is not evidence of absence",
                200,
                unavailable: true,
                retryable: true
            );
    }
}
