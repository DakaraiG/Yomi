using Microsoft.Extensions.Caching.Memory;
using Yomi.Api.Contracts;

namespace Yomi.Api.Caching;

public interface IPageCache
{
    bool TryGet(string key, out TranslatedPage page);
    void Set(string key, TranslatedPage page);

    /// <summary>
    /// Cache key.
    ///
    /// The model id MUST be part of it. Without that, evaluating two models on
    /// the same page returns the first one's result for both, and the comparison
    /// silently measures nothing. Same for targetLang and seriesId, since the
    /// glossary will make output series-dependent from v0.4.
    /// </summary>
    static string Key(string contentHash, string seriesId, string lang, string model)
        => $"{contentHash}|{seriesId}|{lang}|{model}";
}

public sealed class MemoryPageCache(IMemoryCache cache, TimeSpan ttl) : IPageCache
{
    // In-memory is explicitly enough for v0.2. Persistence lands in v0.4, where
    // "re-reads cost nothing" becomes an exit criterion.
    //
    // Note for whenever this is shared: entries are keyed by image hash, not by
    // API key. Fine for personal use. If two people ever pointed clients at one
    // backend, user B would be served translations user A paid for.
    public bool TryGet(string key, out TranslatedPage page)
        => cache.TryGetValue(key, out page!);

    public void Set(string key, TranslatedPage page)
        => cache.Set(key, page, ttl);
}
