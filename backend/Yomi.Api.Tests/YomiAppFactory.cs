using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Yomi.Api.Sidecar;
using Yomi.Api.Translation;
using Yomi.Api.Contracts;

namespace Yomi.Api.Tests;

/// <summary>
/// Starts the real API in memory.
///
/// This is NOT a mock of the API -- it is the actual application, with real
/// routing, real JSON serialisation, real merge logic and real caching. The only
/// things replaced are the two boundaries that would otherwise do network I/O.
///
/// That is the whole trick: swap the edges, keep everything in between honest.
/// </summary>
public sealed class YomiAppFactory : WebApplicationFactory<Program>
{
    public FakeSidecar Sidecar { get; } = new();
    public FakeTranslator Translator { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");

        // ConfigureServices here runs AFTER Program.cs has registered everything,
        // so we remove the real registrations and put ours in their place.
        builder.ConfigureServices(services =>
        {
            services.RemoveAll<ISidecarClient>();
            services.AddSingleton<ISidecarClient>(Sidecar);

            services.RemoveAll<ITranslationClient>();
            services.AddSingleton<ITranslationClient>(Translator);
        });
    }
}

/// <summary>
/// A FAKE, not a mock.
///
/// A fake is a real working implementation with its behaviour simplified. A mock
/// is an object a framework configures to expect specific calls. Fakes are
/// usually clearer for boundaries like this, they need no extra dependency, and
/// they don't break every time you reorder a method call.
///
/// It records call counts, which is how the cache tests know whether the
/// pipeline actually ran or was served from memory.
/// </summary>
public sealed class FakeSidecar : ISidecarClient
{
    public int Calls { get; private set; }
    public Exception? ThrowThis { get; set; }

    public DetectResponse Next { get; set; } = new(
        NaturalWidth: 1000,
        NaturalHeight: 1500,
        Regions:
        [
            new DetectedRegion("r0", 0, [[0.5, 0.1], [0.9, 0.1], [0.9, 0.3], [0.5, 0.3]],
                Vertical: true, Japanese: "こんにちは", DetConfidence: 0.91),
            new DetectedRegion("r1", 1, [[0.1, 0.4], [0.4, 0.4], [0.4, 0.6], [0.1, 0.6]],
                Vertical: true, Japanese: "またね", DetConfidence: 0.88)
        ]);

    public Task<DetectResponse> DetectAsync(string imageB64, CancellationToken ct)
    {
        Calls++;
        if (ThrowThis is not null) throw ThrowThis;
        return Task.FromResult(Next);
    }

    /// <summary>
    /// Called from the test class constructor, which xUnit runs before EVERY
    /// test. Without this, one test's ThrowThis poisons the next, and call
    /// counts accumulate so you can't assert on them directly.
    /// </summary>
    public void Reset()
    {
        Calls = 0;
        ThrowThis = null;
    }
}

public sealed class FakeTranslator : ITranslationClient
{
    public int Calls { get; private set; }
    public Exception? ThrowThis { get; set; }
    public string ModelId { get; set; } = "fake-model";

    /// <summary>Null means "answer every region the sidecar found".</summary>
    public IReadOnlyList<TranslationResult>? Next { get; set; }

    public Task<TranslationOutcome> TranslateAsync(
        string imageB64,
        IReadOnlyList<DetectedRegion> regions,
        string seriesId,
        CancellationToken ct)
    {
        Calls++;
        if (ThrowThis is not null) throw ThrowThis;

        var results = Next ?? regions
            .Select(r => new TranslationResult(
                r.Id, RegionKind.Bubble, $"EN:{r.Japanese}", "speaker-a", 0.95))
            .ToList();

        return Task.FromResult(new TranslationOutcome(results, 3100, 700, 120));
    }

    public void Reset()
    {
        Calls = 0;
        ThrowThis = null;
        Next = null;
    }
}