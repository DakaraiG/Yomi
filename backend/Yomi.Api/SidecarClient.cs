using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Yomi.Api.Sidecar;

/// <summary>Mirrors the sidecar's DetectResponse. Not the public contract.</summary>
public sealed record DetectedRegion(
    string Id,
    int Order,
    IReadOnlyList<IReadOnlyList<double>> Polygon,
    bool Vertical,
    string Japanese,
    [property: JsonPropertyName("detConfidence")] double? DetConfidence);

public sealed record DetectResponse(
    int NaturalWidth,
    int NaturalHeight,
    IReadOnlyList<DetectedRegion> Regions);

public interface ISidecarClient
{
    Task<DetectResponse> DetectAsync(string imageB64, CancellationToken ct);
}

public sealed class SidecarUnavailableException(string message, Exception? inner = null)
    : Exception(message, inner);

public sealed class SidecarClient(HttpClient http, ILogger<SidecarClient> log) : ISidecarClient
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public async Task<DetectResponse> DetectAsync(string imageB64, CancellationToken ct)
    {
        HttpResponseMessage response;
        try
        {
            response = await http.PostAsJsonAsync("/detect", new { imageB64 }, Json, ct);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            // The sidecar is a separate process the user has to start. Being
            // explicit here saves a confusing 500 later.
            throw new SidecarUnavailableException(
                $"Could not reach the detection sidecar at {http.BaseAddress}. " +
                "Is it running? See the sidecar README, or use run.sh.", ex);
        }

        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(ct);
            log.LogError("Sidecar returned {Status}: {Body}", (int)response.StatusCode, body);
            throw new SidecarUnavailableException(
                $"Sidecar returned {(int)response.StatusCode}.");
        }

        return await response.Content.ReadFromJsonAsync<DetectResponse>(Json, ct)
               ?? throw new SidecarUnavailableException("Sidecar returned an empty body.");
    }
}
