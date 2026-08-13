using System.Text;
using Yomi.Api.Sidecar;

namespace Yomi.Api.Translation;

/// <summary>
/// Prompt assembly.
///
/// ORDER MATTERS. Everything stable goes first, everything per-page goes last,
/// so a cache breakpoint can sit between them. From v0.4 the glossary joins the
/// stable prefix and becomes the largest reusable block in the request; cached
/// reads are ~10% of standard input on every provider we care about. Getting
/// this order right now avoids restructuring later.
/// </summary>
public static class TranslationPrompt
{
    // --- stable prefix -----------------------------------------------------

    public const string System = """
        You translate Japanese manga into natural English.

        You receive a full page image and the Japanese text already extracted
        from it by OCR, in reading order, each with a region id. The image is
        there so you can see who is speaking, read body language and tone, and
        catch verbal tics. Use it.

        Rules:
        - Translate each region. Return one entry per region id you were given,
          and no others. Never invent, merge, or drop regions.
        - Do NOT return coordinates or bounding boxes. Geometry is not your job
          and you are not good at it.
        - Prefer concise renderings. The text has to fit inside the original
          speech bubble, so a shorter line that keeps the meaning beats a longer
          faithful one.
        - Preserve register and character voice. Kansai-ben should read as
          informal or regional, not neutral. Keep verbal tics (a character who
          ends sentences with a catchphrase should keep doing so in English).
        - Keep honorifics when they carry meaning a reader would notice.
        - OCR is imperfect. If a line is garbled, translate your best reading and
          lower your confidence rather than inventing plausible dialogue.
        - `speaker` is a short stable label for the character ("landlord",
          "cat-tenant"), not a description. Null if you genuinely cannot tell.
        - `confidence` is your confidence in the TRANSLATION, 0 to 1.

        Region kinds:
        - bubble    : speech in a bubble
        - thought   : internal monologue, usually a cloud bubble
        - narration : boxed or free-floating narration, not spoken aloud
        - sfx       : sound effects and stylised onomatopoeia
        """;

    // --- per-page suffix ---------------------------------------------------

    public static string BuildUserText(
        IReadOnlyList<DetectedRegion> regions,
        string seriesId)
    {
        var sb = new StringBuilder();
        sb.Append("Series: ").AppendLine(seriesId);
        sb.AppendLine();
        sb.AppendLine("Regions in reading order (right-to-left, panel by panel):");
        foreach (var r in regions)
        {
            sb.Append('[').Append(r.Id).Append("] ")
              .Append(r.Vertical ? "vertical" : "horizontal").Append(" — ")
              .AppendLine(r.Japanese);
        }
        sb.AppendLine();
        sb.Append("Return exactly ").Append(regions.Count)
          .AppendLine(" entries, one per region id above.");
        return sb.ToString();
    }

    /// <summary>
    /// Strict JSON Schema for the response.
    ///
    /// Strict mode requires every property listed in `required` and
    /// additionalProperties:false throughout; nullable fields are expressed as a
    /// type union rather than by omission.
    ///
    /// Note what is absent: polygon, order, japanese, vertical. Those come from
    /// the sidecar and are merged server-side. Asking the model for them would
    /// contradict the plan's rule against LLM-supplied bounding boxes.
    /// </summary>
    public static object ResponseSchema { get; } = new
    {
        type = "object",
        properties = new
        {
            regions = new
            {
                type = "array",
                items = new
                {
                    type = "object",
                    properties = new
                    {
                        id = new { type = "string" },
                        kind = new
                        {
                            type = "string",
                            @enum = new[] { "bubble", "sfx", "narration", "thought" }
                        },
                        english = new { type = "string" },
                        speaker = new { type = new[] { "string", "null" } },
                        confidence = new { type = "number" }
                    },
                    required = new[] { "id", "kind", "english", "speaker", "confidence" },
                    additionalProperties = false
                }
            }
        },
        required = new[] { "regions" },
        additionalProperties = false
    };
}
