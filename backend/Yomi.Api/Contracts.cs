using System.ComponentModel.DataAnnotations;

namespace Yomi.Api.Contracts;

/// <summary>
/// POST /v1/translate request body.
///
/// FROZEN as of v0.2. This is the seam between the extension and the backend,
/// and between Chrome and Safari. Additive header changes are fine (the API
/// key arrives that way in v0.6); body changes are not.
/// </summary>
public sealed class TranslateRequest
{
    /// <summary>Page image. Bare base64 or a data: URL; both accepted.</summary>
    [Required]
    public required string ImageB64 { get; init; }

    /// <summary>
    /// Client-computed SHA-256 of the image bytes, as "sha256:...".
    ///
    /// NOTE: this does not save the server any work -- the image is in the same
    /// request body, so the server hashes the bytes itself and uses that as the
    /// cache key. The field's real value is client-side (IndexedDB lookup before
    /// the request is ever made) plus a corruption check in transit. A mismatch
    /// is logged, not fatal.
    ///
    /// If round-trip cost ever matters, the fix is GET /v1/page/{hash} so the
    /// client can check the server cache without uploading the image at all.
    /// </summary>
    public string? ContentHash { get; init; }

    /// <summary>Stable per-series key. Drives the glossary from v0.4.</summary>
    [Required]
    public required string SeriesId { get; init; }

    /// <summary>Only "en" is supported in v0.2. Anything else returns 400.</summary>
    public string TargetLang { get; init; } = "en";
}

/// <summary>Region kind. Assigned by the vision model, which can see the page.</summary>
public enum RegionKind
{
    Bubble,
    Sfx,
    Narration,
    Thought
}

public sealed class TranslatedRegion
{
    public required string Id { get; init; }

    /// <summary>Reading-order index, 0-based. From the sidecar, never the model.</summary>
    public required int Order { get; init; }

    /// <summary>Normalised 0-1 against natural dimensions. From the detector.</summary>
    public required IReadOnlyList<IReadOnlyList<double>> Polygon { get; init; }

    public required RegionKind Kind { get; init; }
    public required bool Vertical { get; init; }
    public required string Japanese { get; init; }
    public required string English { get; init; }

    /// <summary>Nullable. The model infers this from the artwork.</summary>
    public string? Speaker { get; init; }

    /// <summary>
    /// The MODEL's confidence in the translation, 0-1 -- not the detector's
    /// confidence in the box.
    ///
    /// The spec's example showed a single `confidence` next to `english` and
    /// `speaker`, so it reads as translation confidence. Detector confidence
    /// stays internal: it is useful for tuning the sidecar and meaningless to
    /// the overlay, which has already decided to render the box.
    /// </summary>
    public required double Confidence { get; init; }
}

public sealed class TranslatedPage
{
    /// <summary>Server-computed, "sha256:...". Authoritative over the client's.</summary>
    public required string ContentHash { get; init; }

    public required int NaturalWidth { get; init; }
    public required int NaturalHeight { get; init; }
    public required IReadOnlyList<TranslatedRegion> Regions { get; init; }

    /// <summary>
    /// Always 0 until v0.4. The field is in the frozen shape, so it needs a
    /// defined value now rather than an invented one later.
    /// </summary>
    public required int GlossaryVersion { get; init; }
}

/// <summary>RFC 7807-ish error body. v0.6 requires failures be visible, never silent.</summary>
public sealed record ApiError(string Code, string Message);
