using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Xunit;
using Yomi.Api.Contracts;    // RegionKind
using Yomi.Api.Sidecar;      // SidecarUnavailableException
using Yomi.Api.Translation;  // TranslationResult, TranslationFailedException

namespace Yomi.Api.Tests;

/// <summary>
/// Tests for the frozen POST /v1/translate contract.
///
/// Naming convention: What_Condition_ExpectedResult. A failing test name should
/// tell you what broke without opening the file.
/// </summary>
public class TranslateContractTests : IClassFixture<YomiAppFactory>
{
    private readonly YomiAppFactory factory;

    // IClassFixture shares ONE factory across the class, so the app boots once
    // instead of per test. But xUnit constructs the TEST CLASS fresh for every
    // test, so this constructor is the per-test reset hook.
    //
    // The cache is NOT reset -- it lives inside the running app. That is why
    // every test below uses its own seriesId: same series + same image would be
    // a cache hit and the sidecar would never be called.
    public TranslateContractTests(YomiAppFactory factory)
    {
        this.factory = factory;
        factory.Sidecar.Reset();
        factory.Translator.Reset();
    }

    // A 1x1 PNG. Content does not matter -- the sidecar is faked -- but it must
    // be valid base64 or the endpoint rejects it before reaching the fake.
    private const string PixelPng =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk" +
        "YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    private static HttpContent Body(string seriesId, string lang = "en") =>
        JsonContent.Create(new { imageB64 = PixelPng, seriesId, targetLang = lang });

    // -- worked examples ----------------------------------------------------

    [Fact]
    public async Task Translate_MergesSidecarGeometryWithModelText()
    {
        // ARRANGE -- defaults from the fakes are fine here.
        var client = factory.CreateClient();

        // ACT
        var response = await client.PostAsync("/v1/translate", Body("merge-test"));

        // ASSERT
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        var regions = json.GetProperty("regions");
        Assert.Equal(2, regions.GetArrayLength());

        var first = regions[0];
        // Geometry and Japanese come from the sidecar...
        Assert.Equal("r0", first.GetProperty("id").GetString());
        Assert.Equal("こんにちは", first.GetProperty("japanese").GetString());
        Assert.Equal(4, first.GetProperty("polygon").GetArrayLength());
        // ...English and speaker come from the model.
        Assert.Equal("EN:こんにちは", first.GetProperty("english").GetString());
        Assert.Equal("speaker-a", first.GetProperty("speaker").GetString());
    }

    [Fact]
    public async Task Translate_SerialisesKindAsString()
    {
        // RegionKind is a C# enum and System.Text.Json emits enums as INTEGERS
        // by default. The frozen contract specifies strings. Without a
        // JsonStringEnumConverter this silently emits 0 and the extension breaks
        // months from now for a reason nobody remembers.
        var client = factory.CreateClient();

        var response = await client.PostAsync("/v1/translate", Body("kind-test"));
        var json = await response.Content.ReadFromJsonAsync<JsonElement>();

        var kind = json.GetProperty("regions")[0].GetProperty("kind");
        Assert.Equal(JsonValueKind.String, kind.ValueKind);
        Assert.Equal("bubble", kind.GetString());
    }

    [Theory]
    [InlineData("fr")]
    [InlineData("ja")]
    [InlineData("")]
    public async Task Translate_RejectsUnsupportedTargetLang(string lang)
    {
        // [Theory] runs the body once per input and reports each separately, so
        // a failure tells you which case broke.
        var client = factory.CreateClient();

        var response = await client.PostAsync("/v1/translate", Body("lang-test", lang));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // -- caching ------------------------------------------------------------

    [Fact]
    public async Task Translate_SecondIdenticalRequest_IsServedFromCache()
    {
        var client = factory.CreateClient();

        var r1 = await client.PostAsync("/v1/translate", Body("cache-test"));
        var r2 = await client.PostAsync("/v1/translate", Body("cache-test"));

        Assert.Equal(HttpStatusCode.OK, r1.StatusCode);
        Assert.Equal(HttpStatusCode.OK, r2.StatusCode);

        // The point of the test: the work did NOT happen a second time. Ask the
        // fake, not the response -- the response looks identical either way.
        Assert.Equal(1, factory.Sidecar.Calls);
    }

    [Fact]
    public async Task Translate_DifferentSeriesId_MissesCache()
    {
        var client = factory.CreateClient();

        await client.PostAsync("/v1/translate", Body("series-1"));
        await client.PostAsync("/v1/translate", Body("series-2"));

        // Same image, different series -> different cache key -> real work twice.
        Assert.Equal(2, factory.Sidecar.Calls);
    }

    // -- degraded but not broken --------------------------------------------

    [Fact]
    public async Task Translate_RegionDroppedByModel_StillRendersWithJapanese()
    {
        var client = factory.CreateClient();

        // ARRANGE: the model answers r0 only, silently omitting r1.
        factory.Translator.Next =
        [
            new TranslationResult("r0", RegionKind.Bubble, "EN:こんにちは", "speaker-a", 0.95)
        ];

        var response = await client.PostAsync("/v1/translate", Body("drop-test"));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        var regions = json.GetProperty("regions");
        Assert.Equal(2, regions.GetArrayLength());   // nothing vanished

        var second = regions[1];
        Assert.Equal("r1", second.GetProperty("id").GetString());
        Assert.Equal("", second.GetProperty("english").GetString());
        Assert.Equal("またね", second.GetProperty("japanese").GetString());
    }

    // -- failure paths ------------------------------------------------------

    [Fact]
    public async Task Translate_RejectsInvalidBase64()
    {
        var client = factory.CreateClient();

        var body = JsonContent.Create(new
        {
            imageB64 = "not_valid_base64!!",
            seriesId = "bad-base64-test"
        });
        var response = await client.PostAsync("/v1/translate", body);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Translate_SidecarDown_Returns503()
    {
        var client = factory.CreateClient();
        factory.Sidecar.ThrowThis = new SidecarUnavailableException("down");

        var response = await client.PostAsync("/v1/translate", Body("sidecar-down-test"));

        // Infrastructure failure must not surface as a 500.
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);

        // And it must not have reached the paid call. This assertion is worth
        // money: it proves a sidecar outage cannot bill you.
        Assert.Equal(0, factory.Translator.Calls);
    }

    [Fact]
    public async Task Translate_TranslationFails_Returns502()
    {
        var client = factory.CreateClient();
        factory.Translator.ThrowThis = new TranslationFailedException("boom");

        var response = await client.PostAsync("/v1/translate", Body("translation-fail-test"));

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
    }

    // -- invariants the extension will rely on -------------------------------

    [Fact]
    public async Task Translate_RegionsAreInContiguousReadingOrder()
    {
        var client = factory.CreateClient();

        var response = await client.PostAsync("/v1/translate", Body("order-test"));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var json = await response.Content.ReadFromJsonAsync<JsonElement>();

        var expected = 0;
        foreach (var region in json.GetProperty("regions").EnumerateArray())
        {
            Assert.Equal(expected, region.GetProperty("order").GetInt32());
            expected++;
        }
    }

    [Fact]
    public async Task Translate_PolygonsAreNormalised()
    {
        var client = factory.CreateClient();

        var response = await client.PostAsync("/v1/translate", Body("polygon-test"));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var json = await response.Content.ReadFromJsonAsync<JsonElement>();

        foreach (var region in json.GetProperty("regions").EnumerateArray())
        {
            foreach (var point in region.GetProperty("polygon").EnumerateArray())
            {
                Assert.InRange(point[0].GetDouble(), 0d, 1d);
                Assert.InRange(point[1].GetDouble(), 0d, 1d);
            }
        }
    }
}