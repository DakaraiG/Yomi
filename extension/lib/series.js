// Derive a stable series identifier from a reader URL.
//
// The glossary is keyed on this, so it has exactly one job: be the SAME string
// across every chapter of one series, and a DIFFERENT string for two series on
// the same host. v0.3's rule -- hostname plus the first path segment -- fails
// both ways at once, and the failures are silent:
//
//   mangafire.to/read/one-piece.abc/en/chapter-1   -> mangafire.to/read
//   mangafire.to/read/berserk.xyz/en/chapter-1     -> mangafire.to/read
//     Every series on the host collapses together. The glossary fills up with
//     terms from unrelated works and starts contradicting itself.
//
//   namicomi.com/en/title/<uuid>/slug/chapter/<chapter-uuid>
//     The first segment is a locale, and further down the chapter carries its
//     own uuid, so no two chapters ever agree. No series accumulates anything.
//
// The shape that works is a per-site rule where the site's URLs are known, and
// a conservative structural guess where they are not.

/**
 * Site rules. Each returns the series key, or null to fall through.
 *
 * Keys deliberately exclude anything chapter-specific. Where a site gives a
 * stable opaque id (a uuid, a numeric id) that is preferred over the slug --
 * slugs get renamed when a title's translation changes, and a renamed slug
 * silently forks the glossary.
 */
const RULES = [
  {
    match: /(^|\.)mangadex\.org$/,
    // /title/<uuid>/<slug>, /chapter/<uuid> -- the chapter form carries no
    // series id at all, so it falls through to the content-based key.
    series: (segments) => {
      const i = segments.indexOf("title");
      return i !== -1 && segments[i + 1] ? segments[i + 1] : null;
    }
  },
  {
    match: /(^|\.)namicomi\.(com|to)$/,
    // /<locale>/title/<uuid>/<slug>/chapter/<chapter-uuid>
    series: (segments) => {
      const i = segments.indexOf("title");
      return i !== -1 && segments[i + 1] ? segments[i + 1] : null;
    }
  },
  {
    match: /(^|\.)mangafire\.(to|net)$/,
    // /manga/<slug>.<id> and /read/<slug>.<id>/<lang>/chapter-<n>
    // The trailing .<id> is the stable part; the slug in front of it is not.
    series: (segments) => {
      const i = segments.findIndex((s) => s === "manga" || s === "read");
      const slug = i !== -1 ? segments[i + 1] : null;
      if (!slug) return null;
      const dot = slug.lastIndexOf(".");
      return dot > 0 ? slug.slice(dot + 1) : slug;
    }
  }
];

// Segments that introduce a series identifier on many readers. Ordered, because
// a URL can contain more than one and the earliest is the series-level one.
const SERIES_MARKERS = ["title", "manga", "series", "comic", "read", "book"];

// Anything from here on is chapter-level and must not enter the key.
const CHAPTER_MARKERS = /^(chapter|ch|c|episode|ep|vol|volume|page|p)([-_.]?\d|$)/i;

const LOCALES = /^([a-z]{2}|[a-z]{2}-[a-z]{2})$/i;

/** Strip a trailing chapter component from a slug: "berserk-chapter-12". */
function stripChapterSuffix(slug) {
  return slug.replace(/[-_](chapter|ch|episode|ep|vol|volume)[-_]?\d[\d.\-_]*$/i, "");
}

/**
 * Structural guess for a site with no rule.
 *
 * Takes the segment after the first series marker, stopping before anything
 * chapter-shaped. Falls back to the first non-locale segment, which is what
 * v0.3 did -- but only after the better options are exhausted, and never
 * including a chapter segment.
 */
function structuralKey(segments) {
  const usable = [];
  for (const segment of segments) {
    if (CHAPTER_MARKERS.test(segment)) break;
    usable.push(segment);
  }

  for (const marker of SERIES_MARKERS) {
    const i = usable.indexOf(marker);
    if (i !== -1 && usable[i + 1]) return stripChapterSuffix(usable[i + 1]);
  }

  const first = usable.find((s) => !LOCALES.test(s));
  return first ? stripChapterSuffix(first) : null;
}

/** Normalise a page title into a key: the series name, minus chapter noise. */
function fromTitle(title) {
  if (!title) return null;
  const cleaned = title
    .split(/[|–—]|(?: - )/)[0]                                  // site name after a separator
    .replace(/\b(chapter|ch\.?|episode|ep\.?|vol\.?|volume)\s*\d[\d.]*\b/gi, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return cleaned.length >= 2 ? cleaned : null;
}

/**
 * @param {string} pageUrl
 * @param {object} [context]
 * @param {string} [context.title]  document.title, used when the URL carries no
 *   series identity at all (chapter-uuid-only readers).
 * @returns {string} `host/key`, stable across chapters of one series.
 */
export function deriveSeriesId(pageUrl, { title = null } = {}) {
  let url;
  try {
    url = new URL(pageUrl);
  } catch {
    return "unknown";
  }

  const host = url.hostname.replace(/^www\./, "");
  const segments = url.pathname.split("/").filter(Boolean);

  for (const rule of RULES) {
    if (!rule.match.test(host)) continue;
    const key = rule.series(segments);
    if (key) return `${host}/${key}`;
  }

  const structural = structuralKey(segments);
  if (structural) return `${host}/${structural}`;

  // Nothing in the URL identifies the series. The page's own title is the last
  // signal available, and it is better than a constant -- a constant would put
  // every series on the host into one glossary, which is the v0.3 failure.
  const titled = fromTitle(title);
  if (titled) return `${host}/${titled}`;

  return `${host}/unknown`;
}
