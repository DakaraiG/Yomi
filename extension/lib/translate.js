// The provider call.
//
//   - Responses API, not Chat Completions: the model is a reasoning model, and
//     the structured-output shape differs between the two (Responses uses
//     text.format, Chat Completions response_format).
//   - The key goes in a header, never in the body, and is never logged.

import { SYSTEM, buildUserText, RESPONSE_SCHEMA } from "./prompt.js";

export const DEFAULTS = {
  model: "gpt-5.6-luna",
  providerBaseUrl: "https://api.openai.com",
  reasoningEffort: "low",
  maxOutputTokens: 8000,
  // Required: a fetch with no timeout does not fail, it waits forever with no
  // error and no log, and presents as an intermittent hang somewhere else.
  timeoutMs: 180_000
};

export class TranslationFailedError extends Error {}

/**
 * What a cached page's geometry was produced by. Bump whenever a change makes a
 * stored page mean something different from a fresh one:
 *
 *   1  PaddleOCR line boxes, no erase mask
 *   2  comic-text-detector, fused heads, mask restricted to region boxes
 *
 * A cached mask is an instruction to repaint specific pixels, and nothing about
 * a stale one looks stale: when the rule that built it changes, every cached
 * page goes on replaying the old instruction while new pages come out fixed.
 */
export const PIPELINE_VERSION = 2;

/**
 * Cache key for a page.
 *
 * Model id, prompt version and pipeline version are all in the key so that
 * changing any of them re-runs the page. Without that, evaluating two models
 * returns the first one's result twice and the comparison measures nothing.
 */
export function cacheKey({
  contentHash, seriesId, targetLang, model,
  promptVersion = 1, pipelineVersion = PIPELINE_VERSION
}) {
  return [contentHash, seriesId, targetLang, model,
          `p${promptVersion}`, `g${pipelineVersion}`].join("|");
}

function truncate(s, n = 400) {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/**
 * Pull the structured payload out of a Responses result.
 *
 * The output array interleaves reasoning items and the message, so the message
 * is found by type rather than by index -- ordering is not guaranteed.
 */
function parse(raw) {
  let text = null;

  for (const item of raw.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "output_text") text = part.text;
      // Structured Outputs can return a refusal instead of JSON, which is a
      // failure in its own right rather than a parse error.
      if (part.type === "refusal") {
        throw new TranslationFailedError(`Model refused: ${part.refusal}`);
      }
    }
  }

  if (!text) throw new TranslationFailedError("No output_text in provider response.");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TranslationFailedError(`Provider returned unparseable JSON: ${truncate(text)}`);
  }

  const usage = raw.usage ?? {};
  return {
    regions: parsed.regions ?? [],
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0
  };
}

/**
 * @param {object} opts
 * @param {string} opts.imageB64     the NUMBERED page render, bare base64
 * @param {number} opts.regionCount  how many boxes are drawn on it
 * @param {string} opts.seriesId
 * @param {string} opts.apiKey
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{regions: Array, inputTokens, outputTokens, reasoningTokens}>}
 */
export async function translatePage({
  imageB64,
  regionCount,
  seriesId,
  apiKey,
  signal,
  ...options
}) {
  const opt = { ...DEFAULTS, ...options };
  const dataUrl = imageB64.startsWith("data:")
    ? imageB64
    : `data:image/png;base64,${imageB64}`;

  const payload = {
    model: opt.model,
    input: [
      { role: "system", content: [{ type: "input_text", text: SYSTEM }] },
      {
        role: "user",
        content: [
          { type: "input_image", image_url: dataUrl },
          { type: "input_text", text: buildUserText(regionCount, seriesId) }
        ]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "translated_page",
        strict: true,
        schema: RESPONSE_SCHEMA
      }
    },
    reasoning: { effort: opt.reasoningEffort },
    max_output_tokens: opt.maxOutputTokens
  };

  // Caller's signal if given, plus the deadline, so cancelling works and the
  // deadline still applies when the caller never cancels.
  const deadline = AbortSignal.timeout(opt.timeoutMs);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;

  let response;
  try {
    response = await fetch(`${opt.providerBaseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal: abort
    });
  } catch (err) {
    if (err?.name === "TimeoutError" || deadline.aborted) {
      throw new TranslationFailedError(
        `Provider did not respond within ${opt.timeoutMs / 1000}s.`);
    }
    throw new TranslationFailedError(`Could not reach the provider: ${err.message}`);
  }

  const body = await response.text();
  if (!response.ok) {
    // The status and body, never the request: key material must not reach a log.
    throw new TranslationFailedError(
      `Provider returned ${response.status}. ${truncate(body)}`);
  }

  return parse(JSON.parse(body));
}

/**
 * Merge model output onto local geometry.
 *
 * Geometry and reading order come from detection, never the model. A region the
 * model drops still renders, empty, so the gap is visible; there is no local OCR
 * to fall back to.
 */
export function mergeRegions(regions, translated) {
  const byId = new Map(translated.map((t) => [String(t.id), t]));

  return regions.map((region, i) => {
    const t = byId.get(String(i));
    return {
      id: String(i),
      order: i,
      polygon: region.polygon,
      vertical: region.vertical ?? null,
      inBubble: region.inBubble === true,
      japanese: t?.japanese ?? "",
      english: t?.english ?? "",
      kind: t?.kind ?? "bubble",
      speaker: t?.speaker ?? null,
      confidence: t?.confidence ?? 0
    };
  });
}
