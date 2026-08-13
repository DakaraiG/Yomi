using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using Yomi.Api.Caching;
using Yomi.Api.Contracts;
using Yomi.Api.Keys;
using Yomi.Api.Options;
using Yomi.Api.Sidecar;
using Yomi.Api.Translation;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOptions<YomiOptions>()
    .Bind(builder.Configuration.GetSection(YomiOptions.Section))
    .ValidateOnStart();

// RegionKind is an enum, and System.Text.Json serialises enums as integers by
// default -- the frozen contract requires "bubble" | "sfx" | "narration" |
// "thought". CamelCase because the enum members are PascalCase (Sfx -> "sfx").
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.Converters.Add(
        new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
});

builder.Services.AddMemoryCache();
builder.Services.AddSingleton<IApiKeyProvider, ConfigApiKeyProvider>();
builder.Services.AddSingleton<IPageCache>(sp =>
{
    var opt = sp.GetRequiredService<IOptions<YomiOptions>>().Value;
    return new MemoryPageCache(
        sp.GetRequiredService<Microsoft.Extensions.Caching.Memory.IMemoryCache>(),
        TimeSpan.FromHours(opt.CacheHours));
});

builder.Services.AddHttpClient<ISidecarClient, SidecarClient>((sp, c) =>
{
    var opt = sp.GetRequiredService<IOptions<YomiOptions>>().Value;
    c.BaseAddress = new Uri(opt.SidecarBaseUrl);
    c.Timeout = TimeSpan.FromSeconds(opt.SidecarTimeoutSeconds);
});

builder.Services.AddHttpClient<ITranslationClient, OpenAiTranslationClient>((sp, c) =>
{
    var opt = sp.GetRequiredService<IOptions<YomiOptions>>().Value;
    c.BaseAddress = new Uri(opt.ProviderBaseUrl);
    c.Timeout = TimeSpan.FromSeconds(opt.ProviderTimeoutSeconds);
});

var app = builder.Build();

app.MapGet("/health", (IOptions<YomiOptions> o, IApiKeyProvider keys) =>
{
    var hasKey = true;
    try { keys.GetKeyAsync(CancellationToken.None).GetAwaiter().GetResult(); }
    catch (MissingApiKeyException) { hasKey = false; }

    return Results.Ok(new
    {
        status = "ok",
        model = o.Value.Model,
        reasoningEffort = o.Value.ReasoningEffort,
        sidecar = o.Value.SidecarBaseUrl,
        apiKeyConfigured = hasKey    // never the key itself, not even a prefix
    });
});

app.MapPost("/v1/translate", async (
    [FromBody] TranslateRequest req,
    ISidecarClient sidecar,
    ITranslationClient translator,
    IPageCache cache,
    ILogger<Program> log,
    CancellationToken ct) =>
{
    if (!string.Equals(req.TargetLang, "en", StringComparison.OrdinalIgnoreCase))
        return Results.BadRequest(new ApiError(
            "unsupported_target_lang",
            $"Only 'en' is supported in v0.2; got '{req.TargetLang}'."));

    byte[] bytes;
    try
    {
        var b64 = req.ImageB64.StartsWith("data:", StringComparison.Ordinal)
            ? req.ImageB64[(req.ImageB64.IndexOf(',') + 1)..]
            : req.ImageB64;
        bytes = Convert.FromBase64String(b64);
    }
    catch (FormatException)
    {
        return Results.BadRequest(new ApiError("bad_image", "imageB64 is not valid base64."));
    }

    // Server-computed hash is authoritative. The client's is a transit check.
    var contentHash = "sha256:" + Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    if (!string.IsNullOrEmpty(req.ContentHash) &&
        !string.Equals(req.ContentHash, contentHash, StringComparison.OrdinalIgnoreCase))
    {
        log.LogWarning("Client contentHash disagrees with server hash; using server's.");
    }

    var key = IPageCache.Key(contentHash, req.SeriesId, "en", translator.ModelId);
    if (cache.TryGet(key, out var hit))
    {
        log.LogInformation("Cache hit for {Hash}", contentHash[..16]);
        return Results.Ok(hit);
    }

    try
    {
        var detected = await sidecar.DetectAsync(req.ImageB64, ct);

        if (detected.Regions.Count == 0)
        {
            // Not an error. A page with no text is a legitimate outcome, and the
            // overlay needs to be able to say "nothing here" rather than hang.
            var empty = new TranslatedPage
            {
                ContentHash = contentHash,
                NaturalWidth = detected.NaturalWidth,
                NaturalHeight = detected.NaturalHeight,
                Regions = [],
                GlossaryVersion = 0
            };
            cache.Set(key, empty);
            return Results.Ok(empty);
        }

        var outcome = await translator.TranslateAsync(
            req.ImageB64, detected.Regions, req.SeriesId, ct);

        var byId = outcome.Regions.ToDictionary(r => r.Id);

        // Geometry and reading order come from the sidecar; only the language
        // fields come from the model. A region the model dropped still renders,
        // with the Japanese showing -- visible failure, per v0.6.
        var merged = detected.Regions.Select(d =>
        {
            byId.TryGetValue(d.Id, out var t);
            return new TranslatedRegion
            {
                Id = d.Id,
                Order = d.Order,
                Polygon = d.Polygon,
                Vertical = d.Vertical,
                Japanese = d.Japanese,
                Kind = t?.Kind ?? RegionKind.Bubble,
                English = t?.English ?? "",
                Speaker = t?.Speaker,
                Confidence = t?.Confidence ?? 0d
            };
        }).OrderBy(r => r.Order).ToList();

        var page = new TranslatedPage
        {
            ContentHash = contentHash,
            NaturalWidth = detected.NaturalWidth,
            NaturalHeight = detected.NaturalHeight,
            Regions = merged,
            GlossaryVersion = 0
        };

        cache.Set(key, page);
        return Results.Ok(page);
    }
    catch (MissingApiKeyException ex)
    {
        return Results.Problem(ex.Message, statusCode: 500, title: "api_key_missing");
    }
    catch (SidecarUnavailableException ex)
    {
        return Results.Problem(ex.Message, statusCode: 503, title: "sidecar_unavailable");
    }
    catch (TranslationFailedException ex)
    {
        return Results.Problem(ex.Message, statusCode: 502, title: "translation_failed");
    }
});

app.Run();
