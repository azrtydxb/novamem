#nullable enable

using System.IO;
using System.Text.Json;
using Xunit;

namespace Novamem.Tests;

public class RouteTests
{
    // proved by: renaming Client.SessionRecapAsync fails this test (and the
    // generated dispatch table's compilation).
    [Fact]
    public void TestEveryRouteIsAccounted()
    {
        var routes = JsonDocument
            .Parse(File.ReadAllText(Path.Combine(ScenarioServer.Contract(), "routes.json")))
            .RootElement;
        foreach (var route in routes.EnumerateObject())
        {
            if (!route.Value.TryGetProperty("methods", out var ms))
                continue;
            foreach (var m in ms.EnumerateArray())
            {
                var parts = m.GetProperty("name").GetString()!.Split('.');
                var type = typeof(Client).Assembly.GetType("Novamem." + parts[0])!;
                Assert.True(
                    type.GetMethod(parts[1] + "Async") is not null,
                    $"{route.Name} {parts[0]}.{parts[1]}Async"
                );
                Assert.True(
                    Dispatch.Table.ContainsKey(m.GetProperty("name").GetString()!),
                    $"{route.Name}: no dispatch entry"
                );
            }
        }
    }
}
