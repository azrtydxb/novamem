using System;

namespace Novamem;

/// <summary>
/// Every failure of a call. Never contains the bearer token.
/// </summary>
/// <remarks>
/// The one question every caller must be able to answer is "could the store be
/// consulted?" — <see cref="IsUnavailable"/>. It is true for a refused dial, a
/// timeout, a 5xx, a 429, or a body that is not the JSON the API promises. Any
/// other NovamemException is a real answer that was not success: a rejected
/// token, a bad request, an id that is not in your scope (<see cref="IsNotFound"/>).
/// An empty result with no exception is the only thing this SDK presents as
/// "nothing is stored". Cancelling the caller's token throws
/// OperationCanceledException, as usual.
/// </remarks>
public sealed class NovamemException : Exception
{
    internal NovamemException(
        string op,
        string detail,
        int statusCode = 0,
        string code = "",
        bool unavailable = false,
        bool retryable = false
    )
        : base(Render(op, detail, statusCode, code))
    {
        Op = op;
        Detail = detail;
        StatusCode = statusCode;
        Code = code;
        IsUnavailable = unavailable;
        IsRetryable = retryable;
    }

    /// <summary>The client method that failed ("search", "remove-member", …).</summary>
    public string Op { get; }

    /// <summary>The server's message, or a description of the transport failure.</summary>
    public string Detail { get; }

    /// <summary>The HTTP status, or 0 when no response was received.</summary>
    public int StatusCode { get; }

    /// <summary>The server's machine-readable error code, when it sent one.</summary>
    public string Code { get; }

    /// <summary>The store could not be consulted. Say so; do not claim ignorance.</summary>
    public bool IsUnavailable { get; }

    /// <summary>Calling again could plausibly succeed. The SDK never retries for you.</summary>
    public bool IsRetryable { get; }

    /// <summary>The store answered: that id is not in your scope.</summary>
    public bool IsNotFound => StatusCode == 404;

    static string Render(string op, string detail, int status, string code)
    {
        var s = $"novamem {op}";
        if (status != 0)
            s += $": {status}";
        if (code.Length > 0)
            s += $" [{code}]";
        if (detail.Length > 0)
            s += $": {detail}";
        return s;
    }
}
