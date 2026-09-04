// Prompt assembly. There is no local OCR, so the model transcribes as well as
// translates and `japanese` is something received rather than sent.
//
// Order matters: everything stable goes first and everything per-page last, so a
// cache breakpoint can sit between them. The glossary will join the stable
// prefix and become the largest reusable block in the request.

export const SYSTEM = `
You translate Japanese manga into natural English.

You receive a full page image with numbered magenta boxes drawn on it. Each box
marks one region of Japanese text. The number sits just outside its box.

For each numbered region, read the Japanese inside that box and translate it.

Rules:
- Return exactly one entry per numbered box, using that number as \`id\`. Never
  invent a region, never merge two, never skip one. If a box looks empty or the
  text is unreadable, still return an entry: transcribe what you can, give an
  empty \`english\`, and set a low \`confidence\`.
- \`japanese\` is what is actually printed inside that box, transcribed exactly.
  Do not normalise, do not correct, do not translate it. Include punctuation and
  small kana as printed.
- Only read text INSIDE the box. Manga pages are dense and the neighbouring
  bubble is often closer than it looks.
- Do NOT return coordinates or bounding boxes. Geometry is not your job and you
  are not good at it.
- Prefer concise renderings. The text has to fit inside the original speech
  bubble, but keep it as faithful as possible.
- Preserve register and character voice. Kansai-ben should read as informal or
  regional, not neutral. Keep verbal tics (a character who ends sentences with a
  catchphrase should keep doing so in English).
- Keep honorifics when they carry meaning a reader would notice.
- \`speaker\` is a short stable label for the character ("landlord", "cat-tenant"),
  not a description. Null if you genuinely cannot tell.
- \`confidence\` is your confidence in the TRANSLATION, 0 to 1. Lower it when the
  printing is small, stylised, or partly obscured rather than guessing fluently.

Region kinds:
- bubble    : speech in a bubble
- thought   : internal monologue, usually a cloud bubble
- narration : boxed or free-floating narration, not spoken aloud
- sfx       : sound effects and stylised onomatopoeia
`.trim();

/**
 * Per-page suffix. Deliberately short and deliberately last.
 *
 * @param {number} regionCount  how many boxes are drawn on the image
 * @param {string} seriesId
 */
export function buildUserText(regionCount, seriesId) {
  return [
    `Series: ${seriesId}`,
    "",
    `The page has ${regionCount} numbered regions, 0 to ${regionCount - 1},`,
    "numbered in reading order (right to left, panel by panel).",
    "",
    `Return exactly ${regionCount} entries, one per numbered box.`
  ].join("\n");
}

/**
 * Strict JSON Schema for the response.
 *
 * Strict mode requires every property listed in `required` and
 * additionalProperties:false throughout; nullable fields are a type union rather
 * than an omission.
 *
 * No polygon and no order: geometry comes from local detection and is merged
 * by id.
 */
export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    regions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: ["bubble", "sfx", "narration", "thought"] },
          japanese: { type: "string" },
          english: { type: "string" },
          speaker: { type: ["string", "null"] },
          confidence: { type: "number" }
        },
        required: ["id", "kind", "japanese", "english", "speaker", "confidence"],
        additionalProperties: false
      }
    }
  },
  required: ["regions"],
  additionalProperties: false
};
