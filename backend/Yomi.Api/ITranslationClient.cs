using Yomi.Api.Contracts;
using Yomi.Api.Sidecar;

namespace Yomi.Api.Translation;

/// <summary>What the model is asked to return, per region. Deliberately no geometry.</summary>
public sealed record TranslationResult(
    string Id,
    RegionKind Kind,
    string English,
    string? Speaker,
    double Confidence);

public sealed record TranslationOutcome(
    IReadOnlyList<TranslationResult> Regions,
    int InputTokens,
    int OutputTokens,
    int ReasoningTokens);

/// <summary>
/// The provider seam.
///
/// Two reasons this exists rather than calling OpenAI directly. §10 of the plan
/// requires evaluating 2-3 models on the same pages, and BYO-key means a user
/// may hold a key for a provider we didn't pick. Structured output works
/// differently on each (OpenAI json_schema, Anthropic tool use, Gemini
/// responseSchema), so the difference has to live somewhere -- here.
/// </summary>
public interface ITranslationClient
{
    /// <summary>Identifies the model in cache keys and logs. Must be stable.</summary>
    string ModelId { get; }

    Task<TranslationOutcome> TranslateAsync(
        string imageB64,
        IReadOnlyList<DetectedRegion> regions,
        string seriesId,
        CancellationToken ct);
}

public sealed class TranslationFailedException(string message, Exception? inner = null)
    : Exception(message, inner);
