using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Novamem;

/// <summary>One method makes every request, so failures are classified once.</summary>
internal sealed class Transport
{
    /// <summary>Responses larger than this are rejected rather than buffered.</summary>
    internal const int MaxResponseBytes = 8 << 20;

    readonly string _base;
    readonly string _token;
    readonly TimeSpan _timeout;
    readonly HttpClient _http;

    internal Transport(NovamemOptions o)
    {
        var baseUrl = (o.BaseUrl ?? "").Trim();
        while (baseUrl.EndsWith('/'))
            baseUrl = baseUrl[..^1];
        // Names the field, never the value: a token pasted into the wrong
        // option must not end up in a log line.
        if (
            !Uri.TryCreate(baseUrl, UriKind.Absolute, out var u)
            || (u.Scheme != "http" && u.Scheme != "https")
            || u.Host.Length == 0
        )
            throw new ArgumentException(
                "novamem: BaseUrl is not an absolute http(s) URL",
                nameof(o)
            );
        if (string.IsNullOrWhiteSpace(o.Token))
            throw new ArgumentException("novamem: Token is required", nameof(o));
        _base = baseUrl;
        _token = o.Token;
        _timeout = o.Timeout > TimeSpan.Zero ? o.Timeout : NovamemOptions.DefaultTimeout;
        _http =
            o.HttpClient
            ?? new HttpClient(
                new SocketsHttpHandler
                {
                    AllowAutoRedirect = false,
                    PooledConnectionLifetime = TimeSpan.FromMinutes(2),
                }
            )
            {
                Timeout = System.Threading.Timeout.InfiniteTimeSpan,
            };
    }

    internal string BaseUrl => _base;

    string Redact(string s) => s.Replace(_token, "[redacted]", StringComparison.Ordinal);

    /// <summary>Performs one request; returns its status and body bytes (null when none is expected).</summary>
    internal async Task<(int Status, byte[]? Body)> CallAsync(
        string op,
        HttpMethod method,
        string path,
        object? body,
        IReadOnlyDictionary<string, string?>? query,
        bool expectBody,
        CancellationToken ct
    )
    {
        var url = _base + path;
        var q = (query ?? new Dictionary<string, string?>())
            .Where(kv => !string.IsNullOrEmpty(kv.Value))
            .ToList();
        if (q.Count > 0)
            url +=
                "?"
                + string.Join(
                    "&",
                    q.Select(kv =>
                        Uri.EscapeDataString(kv.Key) + "=" + Uri.EscapeDataString(kv.Value!)
                    )
                );
        var payload = body is null
            ? null
            : JsonSerializer.Serialize(body, body.GetType(), Json.Options);

        // Every call is bounded, even one given no token. A cancel from the
        // caller surfaces as OperationCanceledException; the timeout means
        // "could not look".
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(_timeout);
        try
        {
            var (status, raw) = await ExchangeAsync(op, method, new Uri(url), payload, cts.Token)
                .ConfigureAwait(false);
            return (status, Decode(op, status, raw, expectBody));
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException)
        {
            throw new NovamemException(op, "timed out", unavailable: true, retryable: true);
        }
        catch (HttpRequestException e)
        {
            // Refused dial, DNS, reset, TLS: the host could not be consulted.
            throw new NovamemException(
                op,
                Redact("unreachable: " + e.Message),
                unavailable: true,
                retryable: true
            );
        }
        catch (IOException e)
        {
            throw new NovamemException(
                op,
                Redact("unreachable: " + e.Message),
                unavailable: true,
                retryable: true
            );
        }
    }

    /// <summary>
    /// Follows up to 5 redirects itself, so the bearer never reaches another
    /// origin (Go's http.Client drops it on a cross-origin hop; so does this).
    /// 303, and 301/302 after a POST, continue as a bodyless GET.
    /// </summary>
    async Task<(int, byte[])> ExchangeAsync(
        string op,
        HttpMethod method,
        Uri url,
        string? payload,
        CancellationToken ct
    )
    {
        var auth = true;
        for (var hop = 0; hop <= 5; hop++)
        {
            using var req = new HttpRequestMessage(method, url);
            req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            if (auth)
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
            if (payload is not null)
                req.Content = new StringContent(payload, Encoding.UTF8, "application/json");
            using var resp = await _http
                .SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct)
                .ConfigureAwait(false);
            var status = (int)resp.StatusCode;
            var location = resp.Headers.Location;
            if (status is >= 300 and < 400 && status != 304 && location is not null)
            {
                var next = location.IsAbsoluteUri ? location : new Uri(url, location);
                auth =
                    auth
                    && Uri.Compare(
                        next,
                        url,
                        UriComponents.SchemeAndServer,
                        UriFormat.Unescaped,
                        StringComparison.OrdinalIgnoreCase
                    ) == 0;
                if (
                    status == 303
                    || ((status == 301 || status == 302) && method == HttpMethod.Post)
                )
                {
                    method = HttpMethod.Get;
                    payload = null;
                }
                url = next;
                continue;
            }
            await using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            using var buf = new MemoryStream();
            var chunk = new byte[81920];
            int n;
            while ((n = await stream.ReadAsync(chunk, ct).ConfigureAwait(false)) > 0)
            {
                buf.Write(chunk, 0, n);
                if (buf.Length > MaxResponseBytes)
                    throw new NovamemException(
                        op,
                        "response body exceeds 8 MiB",
                        status,
                        unavailable: true
                    );
            }
            return (status, buf.ToArray());
        }
        throw new NovamemException(op, "too many redirects", unavailable: true);
    }

    byte[]? Decode(string op, int status, byte[] raw, bool expectBody)
    {
        if (status is < 200 or >= 300)
            throw HttpError(op, status, raw);
        if (!expectBody)
            return null;
        var text = Encoding.UTF8.GetString(raw);
        // A 2xx with no body is not the contract: decoding it into a default
        // would tell a forget caller the delete happened.
        if (text.Trim().Length == 0)
            throw new NovamemException(op, "empty response body", status, unavailable: true);
        try
        {
            using (JsonDocument.Parse(raw)) { }
        }
        catch (JsonException)
        {
            // In practice a proxy's HTML error page: we never reached a working
            // novamem. Not retryable — the same request parses the same way.
            throw new NovamemException(op, "malformed response body", status, unavailable: true);
        }
        return raw;
    }

    NovamemException HttpError(string op, int status, byte[] raw)
    {
        string message = "",
            code = "";
        try
        {
            using var doc = JsonDocument.Parse(raw);
            if (
                doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("error", out var e)
                && e.ValueKind == JsonValueKind.String
                && e.GetString()!.Length > 0
            )
            {
                message = e.GetString()!;
                if (
                    doc.RootElement.TryGetProperty("code", out var c)
                    && c.ValueKind == JsonValueKind.String
                )
                    code = c.GetString()!;
            }
        }
        catch (JsonException)
        {
            // not JSON: fall through to the raw text
        }
        if (message.Length == 0)
        {
            var text = Encoding.UTF8.GetString(raw).Trim();
            message = text.Length > 256 ? text[..256] + "…" : text;
        }
        // The server's message and code are quoted verbatim; a server echoing
        // the credential back would otherwise launder it into the logs.
        var unavailable = status >= 500 || status == 429;
        return new NovamemException(
            op,
            Redact(message),
            status,
            Redact(code),
            unavailable,
            unavailable
        );
    }
}
