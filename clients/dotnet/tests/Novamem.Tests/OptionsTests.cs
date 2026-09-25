using System;
using Xunit;

namespace Novamem.Tests;

public class OptionsTests
{
    const string Token = "nm_options_secret";

    // proved by: printing BaseUrl verbatim in NovamemOptions.ToString or
    // Base.ToString fails this test.
    [Fact]
    public void ATokenPastedIntoTheUrlIsRedactedWhenPrinted()
    {
        var o = new NovamemOptions { BaseUrl = $"https://h.example/{Token}", Token = Token };
        Assert.DoesNotContain(Token, o.ToString());
        Assert.DoesNotContain(Token, new Client(o).ToString());
        Assert.DoesNotContain(Token, new Management(o).ToString());
        Assert.DoesNotContain(Token, new Admin(o).ToString());
    }

    // proved by: dropping the query/fragment check in Transport fails this test.
    [Theory]
    [InlineData("https://h.example?tenant=1")]
    [InlineData("https://h.example/#frag")]
    public void ABaseUrlWithAQueryOrFragmentIsRejected(string url)
    {
        var e = Assert.Throws<ArgumentException>(() =>
            new Client(new NovamemOptions { BaseUrl = url, Token = Token })
        );
        Assert.Contains("query or fragment", e.Message);
    }
}
