// Prompt assembly.
//
// Ported from backend/Yomi.Api/Translation/TranslationPrompt.cs, with the one
// change v0.4 forces: the model now TRANSCRIBES as well as translates. There is
// no local OCR any more, so `japanese` moves from something we send to
// something we receive.
//
// ORDER MATTERS. Everything stable goes first, everything per-page goes last,
// so a cache breakpoint can sit between them. From v0.4 the glossary joins the
// stable prefix and becomes the largest reusable block in the request; cached
// reads are ~10% of standard input on every provider we care about. Getting
// this order right now avoids restructuring later.
//
// Note the v0.4 request is much SMALLER on the text side than v0.3's -- the
// per-page suffix used to carry every OCR'd line and now carries a series id
// and a count. Cost does not fall proportionally, because input was always
// dominated by image tokens rather than text (~62% on a real page), and the
// image now has boxes drawn on it.

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
  bubble, so a shorter line that keeps the meaning beats a longer faithful one.
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
 * additionalProperties:false throughout; nullable fields are expressed as a
 * type union rather than by omission.
 *
 * Note what is absent: polygon and order. Those come from local detection and
 * are merged by id, per the standing rule that geometry never comes from the
 * model.
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
