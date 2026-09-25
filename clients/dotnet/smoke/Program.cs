// Live round trip against a real server, for the sdk-smoke CI job.
//
//   NOVAMEM_SMOKE_URL=… NOVAMEM_SMOKE_TOKEN=… dotnet run --project smoke -- up|down
//
// up:   capture → search finds it → forget deletes it → search no longer finds it.
// down: the server has been stopped; search must report unavailable, not an
//       empty result. Every failure prints "dotnet <step>: <detail>" and exits 1.
using System;
using System.Linq;
using System.Threading.Tasks;
using Novamem;

static void Fail(string step, string detail)
{
    Console.WriteLine($"dotnet {step}: {detail}");
    Environment.Exit(1);
}

static async Task<T> Step<T>(string name, Func<Task<T>> f)
{
    try
    {
        return await f();
    }
    catch (Exception e)
    {
        Fail(name, e.Message);
        throw;
    }
}

Client c = null!;
await Step(
    "connect",
    () =>
        Task.FromResult(
            c = new Client(
                new NovamemOptions
                {
                    BaseUrl = Environment.GetEnvironmentVariable("NOVAMEM_SMOKE_URL") ?? "",
                    Token = Environment.GetEnvironmentVariable("NOVAMEM_SMOKE_TOKEN") ?? "",
                }
            )
        )
);

if (args.FirstOrDefault() == "down")
{
    try
    {
        await c.SearchAsync(new SearchRequest { Query = "anything" });
        Fail("down", "search succeeded against a stopped server");
    }
    catch (NovamemException e) when (e.IsUnavailable)
    {
        Console.WriteLine("PASS dotnet down");
        return;
    }
    catch (Exception e)
    {
        Fail("down", $"want unavailable, got {e.Message}");
    }
}

var marker = Guid.NewGuid().ToString("N");
var query = new SearchRequest { Query = marker, Namespace = "sdk-smoke" };
var cap = await Step(
    "capture",
    () =>
        c.CaptureAsync(
            new CaptureRequest
            {
                Content = $"sdk-smoke dotnet {marker}",
                Namespace = "sdk-smoke",
                Force = true,
            }
        )
);
if (string.IsNullOrEmpty(cap.Id))
    Fail("capture", "not saved");
var hits = await Step("search", () => c.SearchAsync(query));
if (!hits.Results.Any(r => r.Id == cap.Id))
    Fail("search", $"captured {cap.Id} not found");
var gone = await Step("forget", () => c.ForgetAsync(new ForgetRequest { Id = cap.Id! }));
if (!gone.Deleted)
    Fail("forget", "not deleted");
var after = await Step("search-after-forget", () => c.SearchAsync(query));
if (after.Results.Any(r => r.Id == cap.Id))
    Fail("search-after-forget", $"{cap.Id} still returned");
Console.WriteLine("PASS dotnet up");
