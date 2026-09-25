using System;
using System.Net.Http;

namespace Novamem;

/// <summary>Everything a client needs, all of it injected: nothing is read from the environment.</summary>
public sealed class NovamemOptions
{
    /// <summary>Bounds a call when no timeout is given.</summary>
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(15);

    /// <summary>The service root, e.g. "https://novamem.example.com".</summary>
    public string BaseUrl { get; init; } = "";

    /// <summary>The user's nm_ bearer. Never included in an error or in ToString.</summary>
    public string Token { get; init; } = "";

    /// <summary>Bounds each call, even one given no CancellationToken.</summary>
    public TimeSpan Timeout { get; init; } = DefaultTimeout;

    /// <summary>
    /// An injected client. It must not follow redirects itself
    /// (AllowAutoRedirect = false), or the SDK cannot keep the bearer on its own origin.
    /// </summary>
    public HttpClient? HttpClient { get; init; }

    /// <inheritdoc />
    /// <remarks>A token pasted into the URL by mistake is redacted there too.</remarks>
    public override string ToString() =>
        $"NovamemOptions {{ BaseUrl = {(string.IsNullOrEmpty(Token) ? BaseUrl : BaseUrl.Replace(Token, "[redacted]", StringComparison.Ordinal))}, Token = [redacted] }}";
}
