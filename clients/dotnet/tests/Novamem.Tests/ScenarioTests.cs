// The shared behaviour suite (clients/contract/scenarios.json, ADR 0009).
#nullable enable

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Novamem.Tests;

public sealed class ScenarioServer : IDisposable
{
    public readonly string Url;
    public readonly string Closed;
    readonly Process _p;

    public static string Contract(
        [System.Runtime.CompilerServices.CallerFilePath] string here = ""
    ) => Path.GetFullPath(Path.Combine(Path.GetDirectoryName(here)!, "../../../contract"));

    public ScenarioServer()
    {
        _p = Process.Start(
            new ProcessStartInfo("sh", "scenario-server.sh -scenarios scenarios.json")
            {
                WorkingDirectory = Contract(),
                RedirectStandardOutput = true,
            }
        )!;
        var parts = _p.StandardOutput.ReadLine()!.Split(' ');
        Url = parts[1];
        Closed = parts[2].Split('=')[1];
    }

    public void Dispose() => _p.Kill(true);
}

public sealed class ScenarioTests(ScenarioServer srv) : IClassFixture<ScenarioServer>
{
    static readonly JsonElement Scen = JsonDocument
        .Parse(File.ReadAllText(Path.Combine(ScenarioServer.Contract(), "scenarios.json")))
        .RootElement;
    static string Token => Scen.GetProperty("token").GetString()!;

    public static IEnumerable<object[]> Ids() =>
        Scen.GetProperty("scenarios")
            .EnumerateArray()
            .Select(s => new object[] { s.GetProperty("id").GetString()! });

    static bool IsEmpty(JsonElement r) =>
        (r.ValueKind == JsonValueKind.Array && r.GetArrayLength() == 0)
        || (
            r.ValueKind == JsonValueKind.Object
            && r.TryGetProperty("results", out var res)
            && res.ValueKind == JsonValueKind.Array
            && res.GetArrayLength() == 0
        );

    static string Subset(JsonElement want, JsonElement? got, string path = "$")
    {
        if (want.ValueKind == JsonValueKind.Object)
        {
            if (got is not { ValueKind: JsonValueKind.Object } g)
                return $"{path}: want an object, got {got}";
            foreach (var p in want.EnumerateObject())
            {
                var d = Subset(
                    p.Value,
                    g.TryGetProperty(p.Name, out var v) ? v : null,
                    $"{path}.{p.Name}"
                );
                if (d.Length > 0)
                    return d;
            }
            return "";
        }
        // Raw-text comparison: JsonElement.DeepEquals is .NET 9+, and these
        // expectations are small scalars written the way the SDK writes them.
        return got is { } x && x.GetRawText() == want.GetRawText()
            ? ""
            : $"{path}: got {got}, want {want}";
    }

    // proved by: removing the degraded-empty check in Client.SearchAsync fails
    // search-degraded-empty-is-unavailable; removing the redaction fails
    // token-echoed-in-401-is-redacted.
    [Theory]
    [MemberData(nameof(Ids))]
    public async Task TestScenarios(string id)
    {
        var s = Scen.GetProperty("scenarios")
            .EnumerateArray()
            .First(x => x.GetProperty("id").GetString() == id);
        var call = s.GetProperty("call");
        JsonElement? result = null;
        Exception? err = null;
        if (call.GetProperty("class").GetString() == "ctor")
        {
            var a = call.GetProperty("args");
            try
            {
                _ = new Client(
                    new NovamemOptions
                    {
                        BaseUrl = a.GetProperty("baseUrl")
                            .GetString()!
                            .Replace("<server>", srv.Url),
                        Token = a.GetProperty("token").GetString()!,
                    }
                );
            }
            catch (Exception e)
            {
                err = e;
            }
        }
        else
        {
            var baseUrl =
                s.TryGetProperty("respond", out var rsp) && rsp.GetRawText().Contains("\"refused\"")
                    ? $"http://127.0.0.1:{srv.Closed}/s/{id}"
                    : $"{srv.Url}/s/{id}";
            var o = new NovamemOptions
            {
                BaseUrl = baseUrl,
                Token = Token,
                Timeout = TimeSpan.FromMilliseconds(Scen.GetProperty("timeoutMs").GetInt32()),
            };
            var clients = new Clients(new Client(o), new Management(o), new Admin(o));
            using var cts = new CancellationTokenSource();
            if (call.TryGetProperty("cancelAfterMs", out var c))
                cts.CancelAfter(c.GetInt32());
            try
            {
                var r = await Dispatch.Table[call.GetProperty("method").GetString()!](
                    clients,
                    call.GetProperty("args"),
                    cts.Token
                );
                result = JsonSerializer.SerializeToElement(
                    r,
                    r?.GetType() ?? typeof(object),
                    Json.Options
                );
            }
            catch (Exception e)
            {
                err = e;
            }
        }
        var outcome = err switch
        {
            null => result is { } j && IsEmpty(j) ? "empty" : "ok",
            OperationCanceledException => "canceled",
            NovamemException { IsUnavailable: true } => "unavailable",
            NovamemException { IsNotFound: true } => "not_found",
            _ => "error",
        };
        var exp = s.GetProperty("expect");
        Assert.True(
            exp.GetProperty("outcome").GetString() == outcome,
            $"{id}: outcome {outcome} ({err}), want {exp.GetProperty("outcome")}"
        );
        if (err is not null)
        {
            Assert.DoesNotContain(Token, err.ToString());
            if (err is NovamemException ne)
            {
                if (exp.TryGetProperty("retryable", out var r))
                    Assert.Equal(r.GetBoolean(), ne.IsRetryable);
                if (exp.TryGetProperty("statusCode", out var sc))
                    Assert.Equal(sc.GetInt32(), ne.StatusCode);
                if (exp.TryGetProperty("code", out var code))
                    Assert.Equal(code.GetString(), ne.Code);
            }
            if (exp.TryGetProperty("messageContains", out var mc))
                Assert.Contains(mc.GetString()!, err.Message, StringComparison.OrdinalIgnoreCase);
        }
        if (exp.TryGetProperty("result", out var want))
            Assert.Equal("", Subset(want, result));
        if (call.GetProperty("class").GetString() == "ctor")
            return;
        using var http = new HttpClient();
        var v = await http.GetFromJsonAsync<JsonElement>($"{srv.Url}/_verdict/{id}");
        Assert.True(
            v.GetProperty("mismatches").GetArrayLength() == 0,
            $"{id}: mismatches {v.GetProperty("mismatches")}"
        );
        if (
            s.TryGetProperty("expectRequest", out var er)
            && er.ValueKind == JsonValueKind.Array
            && er.GetArrayLength() == 0
        )
            Assert.Equal(0, v.GetProperty("requests").GetInt32());
    }
}
