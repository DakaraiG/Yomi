using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Yomi.Api.Contracts;
using Yomi.Api.Keys;
using Yomi.Api.Options;
using Yomi.Api.Sidecar;

namespace Yomi.Api.Translation;

/// <summary>
/// OpenAI Responses API.
///
/// Responses rather than Chat Completions because Luna is a reasoning model and
/// reasoning models are better supported there. The structured-output shape
/// differs between the two: Responses uses text.format, Chat Completions uses
/// response_format. Do not mix them up.
/// </summary>
public sealed class OpenAiTranslationClient(
    HttpClient http,
    IApiKeyProvider keys,
    IOptions<YomiOptions> options,
    ILogger<OpenAiTranslationClient> log) : ITranslationClient
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly YomiOptions _opt = options.Value;

    public string ModelId => _opt.Model;

    public async Task<TranslationOutcome> TranslateAsync(
        string imageB64,
        IReadOnlyList<DetectedRegion> regions,
        string seriesId,
        CancellationToken ct)
    {
        var dataUrl = imageB64.StartsWith("data:", StringComparison.Ordinal)
            ? imageB64
            : $"data:image/png;base64,{imageB64}";

        var payload = new
        {
            model = _opt.Model,
            input = new object[]
            {
                new
                {
                    role = "system",
                    content = new object[]
                    {
                        new { type = "input_text", text = TranslationPrompt.System }
                    }
                },
                new
                {
                    role = "user",
                    content = new object[]
                    {
                        new { type = "input_image", image_url = dataUrl },
                        new
                        {
                            type = "input_text",
                            text = TranslationPrompt.BuildUserText(regions, seriesId)
                        }
                    }
                }
            },
            text = new
            {
                format = new
                {
                    type = "json_schema",
                    name = "translated_page",
                    strict = true,
                    schema = TranslationPrompt.ResponseSchema
                }
            },
            // Luna is a reasoning model; thinking tokens bill at output rates.
            // Configurable because "does low effort keep the accuracy?" is an
            // open experiment that decides the v0.5 prefetch design.
            reasoning = new { effort = _opt.ReasoningEffort },
            max_output_tokens = _opt.MaxOutputTokens
        };

        using var request = new HttpRequestMessage(HttpMethod.Post, "/v1/responses")
        {
            Content = JsonContent.Create(payload, options: Json)
        };
        request.Headers.Authorization =
            new AuthenticationHeaderValue("Bearer", await keys.GetKeyAsync(ct));

        using var response = await http.SendAsync(request, ct);
        var raw = await response.Content.ReadAsStringAsync(ct);

        if (!response.IsSuccessStatusCode)
        {
            // Deliberately does not log `raw` at Error with the request attached;
            // keep key material out of logs by never logging the request object.
            log.LogError("Translation provider returned {Status}", (int)response.StatusCode);
            throw new TranslationFailedException(
                $"Translation provider returned {(int)response.StatusCode}. {Truncate(raw)}");
        }

        return Parse(raw, regions);
    }

    private TranslationOutcome Parse(string raw, IReadOnlyList<DetectedRegion> regions)
    {
        using var doc = JsonDocument.Parse(raw);
        var root = doc.RootElement;

        // The output array interleaves reasoning items and the message. Find the
        // message by type rather than by index -- ordering is not guaranteed.
        string? text = null;
        if (root.TryGetProperty("output", out var output))
        {
            foreach (var item in output.EnumerateArray())
            {
                if (item.GetProperty("type").GetString() != "message") continue;
                foreach (var part in item.GetProperty("content").EnumerateArray())
                {
                    if (part.GetProperty("type").GetString() == "output_text")
                        text = part.GetProperty("text").GetString();
                    // Structured Outputs can return a refusal instead of JSON.
                    // Treat it as a first-class failure, not a parse error.
                    if (part.GetProperty("type").GetString() == "refusal")
                        throw new TranslationFailedException(
                            "Model refused: " + part.GetProperty("refusal").GetString());
                }
            }
        }

        if (string.IsNullOrWhiteSpace(text))
            throw new TranslationFailedException("No output_text in provider response.");

        var (inTok, outTok, reasonTok) = ReadUsage(root);

        using var parsed = JsonDocument.Parse(text);
        var results = new List<TranslationResult>();
        foreach (var r in parsed.RootElement.GetProperty("regions").EnumerateArray())
        {
            results.Add(new TranslationResult(
                Id: r.GetProperty("id").GetString()!,
                Kind: ParseKind(r.GetProperty("kind").GetString()),
                English: r.GetProperty("english").GetString() ?? "",
                Speaker: r.GetProperty("speaker").ValueKind == JsonValueKind.Null
                    ? null
                    : r.GetProperty("speaker").GetString(),
                Confidence: r.GetProperty("confidence").GetDouble()));
        }

        // Strict schema guarantees shape, not that the model honoured "one entry
        // per id". Check, because a silently dropped region renders as an
        // untranslated bubble and looks like an OCR failure.
        var expected = regions.Select(r => r.Id).ToHashSet();
        var got = results.Select(r => r.Id).ToHashSet();
        if (!expected.SetEquals(got))
        {
            log.LogWarning(
                "Region id mismatch: expected {Expected}, got {Got}. Missing: {Missing}",
                expected.Count, got.Count, string.Join(",", expected.Except(got)));
        }

        log.LogInformation(
            "Translated {Count} regions with {Model}: in={In} out={Out} reasoning={Reason}",
            results.Count, _opt.Model, inTok, outTok, reasonTok);

        return new TranslationOutcome(results, inTok, outTok, reasonTok);
    }

    private static (int, int, int) ReadUsage(JsonElement root)
    {
        if (!root.TryGetProperty("usage", out var u)) return (0, 0, 0);
        var inTok = u.TryGetProperty("input_tokens", out var i) ? i.GetInt32() : 0;
        var outTok = u.TryGetProperty("output_tokens", out var o) ? o.GetInt32() : 0;
        var reason = 0;
        if (u.TryGetProperty("output_tokens_details", out var d) &&
            d.TryGetProperty("reasoning_tokens", out var rt))
            reason = rt.GetInt32();
        return (inTok, outTok, reason);
    }

    private static RegionKind ParseKind(string? s) => s switch
    {
        "sfx" => RegionKind.Sfx,
        "narration" => RegionKind.Narration,
        "thought" => RegionKind.Thought,
        _ => RegionKind.Bubble
    };

    private static string Truncate(string s) => s.Length <= 400 ? s : s[..400] + "…";
}
