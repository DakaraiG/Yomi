// Derive a stable series identifier from a reader URL.
//
// The glossary is keyed on this, so it has one job: the same string across every
// chapter of one series, a different string for two series on the same host.
// Both failures are silent -- collapsing two series fills one glossary with
// contradictory terms, and splitting a series' chapters means none of them
// accumulates anything.
//
// The naive rule (hostname plus first path segment) fails both ways at once:
// mangafire puts every series under /read/, while namicomi leads with a locale
// and gives each chapter its own uuid. So: a per-site rule where the URLs are
// known, a conservative structural guess where they are not.

/**
 * Site rules. Each returns the series key, or null to fall through.
 *
 * A stable opaque id is preferred over a slug: slugs get renamed when a title's
 * translation changes, and a renamed slug silently forks the glossary.
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
 * chapter-shaped, and falls back to the first non-locale segment.
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

  // Nothing in the URL identifies the series, so the page title is the last
  // signal left. Still better than a constant, which would put every series on
  // the host into one glossary.
  const titled = fromTitle(title);
  if (titled) return `${host}/${titled}`;

  return `${host}/unknown`;
}
