namespace Yomi.Api.Options;

public sealed class YomiOptions
{
    public const string Section = "Yomi";

    /// <summary>Never put this in appsettings.json. Use user-secrets.</summary>
    public string? ApiKey { get; set; }

    /// <summary>
    /// Provider model id. Verify the exact string against the provider's model
    /// list before first run -- it is the one value here most likely to be wrong.
    /// </summary>
    public string Model { get; set; } = "gpt-5.6-luna";

    public string ProviderBaseUrl { get; set; } = "https://api.openai.com";

    /// <summary>none | minimal | low | medium | high | xhigh.</summary>
    public string ReasoningEffort { get; set; } = "low";

    /// <summary>Must cover reasoning tokens as well as the JSON payload.</summary>
    public int MaxOutputTokens { get; set; } = 8000;

    public string SidecarBaseUrl { get; set; } = "http://127.0.0.1:8001";

    public int SidecarTimeoutSeconds { get; set; } = 120;
    public int ProviderTimeoutSeconds { get; set; } = 180;

    public int CacheHours { get; set; } = 24;
}
