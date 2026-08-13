using Microsoft.Extensions.Options;
using Yomi.Api.Options;

namespace Yomi.Api.Keys;

/// <summary>
/// Where the LLM API key comes from.
///
/// v0.2 reads it from configuration -- use `dotnet user-secrets`, never
/// appsettings.json, which is committed. Because the backend runs on the user's
/// own machine, config IS bring-your-own-key for a single-user deployment; the
/// key never leaves their machine either way.
///
/// v0.6 adds a provider that prefers a request header and falls back to config.
/// That is additive: the key belongs in a HEADER, not the request body, so the
/// frozen POST /v1/translate contract is unaffected.
/// </summary>
public interface IApiKeyProvider
{
    Task<string> GetKeyAsync(CancellationToken ct);
}

public sealed class MissingApiKeyException(string message) : Exception(message);

public sealed class ConfigApiKeyProvider(IOptions<YomiOptions> options) : IApiKeyProvider
{
    public Task<string> GetKeyAsync(CancellationToken ct)
    {
        var key = options.Value.ApiKey;
        if (string.IsNullOrWhiteSpace(key))
            throw new MissingApiKeyException(
                "No LLM API key configured. Set it with:\n" +
                "  dotnet user-secrets set \"Yomi:ApiKey\" \"sk-...\"");
        return Task.FromResult(key);
    }
}
