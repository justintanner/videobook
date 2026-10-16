/**
 * Optional generation settings the request never asked for.
 *
 * The routing prompt already carries the rule — "Omit optional parameters
 * unless the user explicitly requests them so the tool can apply its defaults"
 * (chat-router.ts) — and nothing enforced it. A spoken "make a Seedance video
 * of the kittens in @a1 dancing like @a2" came back carrying duration 22 and
 * generate_audio false: neither was in the request, neither is derivable from
 * the asset context the router sees, and generate_audio false is the opposite
 * of the provider's own default.
 *
 * So the rule moves out of the prompt and into code. A setting the router
 * emitted survives only when the request shows evidence for it, and dropping
 * one is safe by construction: the tool then applies the default the guideline
 * wanted in the first place. Settings with no entry in the evidence table are
 * left alone, so this narrows what the router can invent without becoming a
 * second guess at what it meant.
 */

export type GenerationSettingsFilter = {
  /** The user's request, as routed — the only evidence that counts. */
  query: string;
  /** Params as the router returned them. */
  params: Record<string, unknown>;
  /** Params the tool schema marks required; kept whatever the query says. */
  requiredParams: readonly string[];
};

export type GenerationSettingsResult = {
  params: Record<string, unknown>;
  /** Setting names removed, in the order they appeared. */
  dropped: string[];
};

// The audio toggle is spelled four ways across providers, but what a person
// says to ask for it is the same either way.
const AUDIO_EVIDENCE =
  /\b(?:audio|sound|sounds|sfx|music|musical|soundtrack|score|silent|silence|mute|muted|voice|voices|vocal|vocals|dialogue|dialog|narration|noise)\b/iu;

const RESOLUTION_EVIDENCE =
  /\b(?:480p|720p|1080p|1440p|2k|4k|8k|hd|uhd|resolution|sharper|crisper)\b/iu;

const SAFETY_EVIDENCE =
  /\b(?:nsfw|safety|safe|filter|filtered|explicit|censor|censored|uncensored|spicy)\b/iu;

// What counts as asking for a setting. Deliberately generous about phrasing and
// strict about shape: a missed cue costs the provider default, an over-eager
// match keeps a value the router invented. Enum-valued settings match their own
// vocabulary (720p, 16:9) rather than a bare number, so a timestamp or a shot
// count never reads as a resolution or a ratio.
const SETTING_EVIDENCE: Record<string, RegExp> = {
  duration: /\b\d+(?:\.\d+)?\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes)\b|\b(?:duration|length|long|longer|short|shorter|brief)\b/iu,
  resolution: RESOLUTION_EVIDENCE,
  output_resolution: RESOLUTION_EVIDENCE,
  aspect_ratio: /\b(?:1:1|4:3|3:4|16:9|9:16|21:9)\b|\b(?:aspect|ratio|square|portrait|landscape|vertical|horizontal|widescreen)\b/iu,
  output_format: /\b(?:mp4|mov|webm|gif|format)\b/iu,
  generate_audio: AUDIO_EVIDENCE,
  audio: AUDIO_EVIDENCE,
  sound: AUDIO_EVIDENCE,
  audio_setting: AUDIO_EVIDENCE,
  return_last_frame: /\b(?:last|final|closing|ending)\s+frame\b/iu,
  web_search: /\bweb\s*search\b|\bsearch\s+the\s+web\b|\blook\s+(?:it|this|that)\s+up\b|\bresearch\b/iu,
  nsfw_checker: SAFETY_EVIDENCE,
  enable_safety_checker: SAFETY_EVIDENCE,
  seed: /\bseed(?:ed|s)?\b/iu,
  watermark: /\bwatermark(?:ed|s)?\b/iu,
};

/** Whether the request asks for this setting at all. A setting with no evidence
 *  rule is always treated as requested, so only reviewed names can be dropped. */
export function settingIsRequested(name: string, query: string): boolean {
  const evidence = SETTING_EVIDENCE[name];
  return evidence === undefined || evidence.test(query);
}

/**
 * Drop the optional settings a generation request never asked for, so the tool
 * applies its own defaults instead of values the router filled in.
 */
function requestedEntries(
  entries: Record<string, unknown>,
  query: string,
  required: ReadonlySet<string>,
  dropped: string[],
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(entries)) {
    if (required.has(name) || settingIsRequested(name, query)) {
      kept[name] = value;
      continue;
    }
    dropped.push(name);
  }
  return kept;
}

function optionsRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function withoutUnrequestedSettings(
  input: GenerationSettingsFilter,
): GenerationSettingsResult {
  const required = new Set(input.requiredParams);
  const dropped: string[] = [];
  const params = requestedEntries(input.params, input.query, required, dropped);
  const options = optionsRecord(params.options);
  if (options) params.options = requestedEntries(options, input.query, new Set(), dropped);
  return { params, dropped };
}
