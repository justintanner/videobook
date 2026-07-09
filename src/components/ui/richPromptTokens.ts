// Tokenizer for the transparent rich-prompt overlay. Prompts reference assets
// several ways: positional "[Image N]" tokens (produced by normalizeStoryboardVideoPrompt
// and rewriteVisualWithImageTokens), "@slug" mentions (only confirmed against the
// known asset slugs so stray "@foo" stays plain text), "@<handle>" character
// mentions (handles derived from the selected characters' display names), and
// literal Google Flow positional markers "@character_N", "@referenceImage_N",
// "@referenceAudio_N" (case-insensitive, matching the API's inline @-mention
// syntax). All render as inline micro-thumbs. Tokens are re-derived from the
// text every render (pattern-based, no stored positions), which keeps editing
// dead simple.
//
// Characters are user-facing as "@<handle>" (e.g. "@jane"); the positional
// "@character_N" form is produced at submit by rewriteCharacterMentions. The
// literal "@character_N" form is also tokenized when it appears in the text
// (pasted prompts, round-tripped content).

export type RichToken =
  | { kind: 'slug'; slug: string }
  | { kind: 'image-ref'; n: number }
  | { kind: 'character-ref'; handle: string }
  | { kind: 'character-slot'; n: number }
  | { kind: 'reference-image-slot'; n: number }
  | { kind: 'reference-audio-slot'; n: number };

export interface RichSegment {
  type: 'text' | 'token';
  value: string; // raw source text this segment covers
  token?: RichToken;
}

interface TokenMatch {
  start: number;
  end: number;
  token: RichToken;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Derive an @-mention handle from a character display name: lowercase, runs of
// non-word chars collapse to a single dash, trimmed. "@jane-doe" reads back as a
// chip and drives the "@<handle>" → "@character_N" rewrite at submit.
export function characterHandle(name: string): string {
  return name.trim().toLowerCase().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '');
}

// Rewrite user-facing "@<handle>" mentions to useapi's positional "@character_N"
// form, using the refs' character_refs order. Longest handles first so e.g.
// "jane-doe" wins over a hypothetical "jane". The boundary mirrors extractRichTokens
// so a typed mention rewrites exactly where it chips.
export function rewriteCharacterMentions(text: string, refs: { handle: string; n: number }[]): string {
  let out = text;
  const ordered = [...refs]
    .filter((r) => r.handle)
    .sort((a, b) => b.handle.length - a.handle.length);
  for (const { handle, n } of ordered) {
    out = out.replace(new RegExp(`@${escapeRe(handle)}(?![\\w-])`, 'g'), `@character_${n}`);
  }
  return out;
}

// Positional image refs come in three flavours across the formulas: "[Image N]"
// (storyboard, normalizeStoryboardVideoPrompt), "@ImageN" (char_swap video,
// rewriteVisualWithImageTokens), and bare "Image N" (char_swap swap prompt,
// defaultSwapPrompt). All three resolve to the same image-ref token; the matched
// substring (brackets/@ included) defines the chip's character width. The bare
// form's lookbehind keeps it from re-matching inside the bracket/@ forms.
const IMAGE_REF_RE = /\[Image\s*(\d+)\]|@Image\s*(\d+)|(?<![@[\w])Image\s*(\d+)\b/gi;

// Google Flow positional @-mention markers (case-insensitive per API docs).
// These are grounding hints — they tell the model WHERE in the prompt to place
// each reference. Body params (character_N, referenceImage_N, referenceAudio_N)
// are still required and built server-side from array positions. The regexes
// match any digit; the resolver decides whether the slot is valid (N in range).
const CHARACTER_SLOT_RE = /@character_(\d+)\b/gi;
const REFERENCE_IMAGE_SLOT_RE = /@referenceImage_(\d+)\b/gi;
const REFERENCE_AUDIO_SLOT_RE = /@referenceAudio_(\d+)\b/gi;

// Find every image ref, @character-handle and @slug occurrence. Handles and slugs
// only match known values (longest-first so e.g. "@vid-intro" wins over a
// hypothetical "@vid"); character handles take precedence over slugs when both
// could match the same span.
export function extractRichTokens(text: string, assetSlugs: string[], characterHandles: string[] = []): TokenMatch[] {
  const matches: TokenMatch[] = [];

  for (const m of text.matchAll(IMAGE_REF_RE)) {
    const start = m.index ?? 0;
    matches.push({
      start,
      end: start + m[0].length,
      token: { kind: 'image-ref', n: Number(m[1] ?? m[2] ?? m[3]) },
    });
  }

  const handles = [...new Set(characterHandles)].sort((a, b) => b.length - a.length);
  for (const handle of handles) {
    if (!handle) continue;
    const re = new RegExp(`@${escapeRe(handle)}(?![\\w-])`, 'g');
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (matches.some((x) => start < x.end && end > x.start)) continue; // overlap → skip
      matches.push({ start, end, token: { kind: 'character-ref', handle } });
    }
  }

  // Literal positional markers: @character_N, @referenceImage_N, @referenceAudio_N.
  // These don't collide with @<handle> because the handle regex uses (?![\w-])
  // lookahead — "_1" after "character" is \w, so @character_1 never matches as a
  // handle. Order: character → image → audio (all checked before slugs so a slug
  // named "referenceimage" can't shadow the positional form).
  for (const m of text.matchAll(CHARACTER_SLOT_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (matches.some((x) => start < x.end && end > x.start)) continue;
    matches.push({ start, end, token: { kind: 'character-slot', n: Number(m[1]) } });
  }
  for (const m of text.matchAll(REFERENCE_IMAGE_SLOT_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (matches.some((x) => start < x.end && end > x.start)) continue;
    matches.push({ start, end, token: { kind: 'reference-image-slot', n: Number(m[1]) } });
  }
  for (const m of text.matchAll(REFERENCE_AUDIO_SLOT_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (matches.some((x) => start < x.end && end > x.start)) continue;
    matches.push({ start, end, token: { kind: 'reference-audio-slot', n: Number(m[1]) } });
  }

  const slugs = [...new Set(assetSlugs)].sort((a, b) => b.length - a.length);
  for (const slug of slugs) {
    // @slug bounded by a non-word/non-dash char (or string end) so partial typing
    // mid-word doesn't light up.
    const re = new RegExp(`@${escapeRe(slug)}(?![\\w-])`, 'g');
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (matches.some((x) => start < x.end && end > x.start)) continue; // overlap → skip
      matches.push({ start, end, token: { kind: 'slug', slug } });
    }
  }

  return matches.sort((a, b) => a.start - b.start);
}

// Split text into interleaved text/token segments. Overlapping matches are
// resolved by keeping the earliest (a [Image N] can't sit inside an @slug).
export function parseRichSegments(text: string, matches: TokenMatch[]): RichSegment[] {
  if (matches.length === 0) return [{ type: 'text', value: text }];

  const ordered: TokenMatch[] = [];
  for (const m of matches) {
    const prev = ordered[ordered.length - 1];
    if (prev && m.start < prev.end) continue;
    ordered.push(m);
  }

  const segments: RichSegment[] = [];
  let cursor = 0;
  for (const m of ordered) {
    if (m.start > cursor) segments.push({ type: 'text', value: text.slice(cursor, m.start) });
    segments.push({ type: 'token', value: text.slice(m.start, m.end), token: m.token });
    cursor = m.end;
  }
  if (cursor < text.length) segments.push({ type: 'text', value: text.slice(cursor) });
  return segments;
}

// Remove positional @-mention markers that have no matching body slot (N out of
// range). Called at submit AFTER rewriteCharacterMentions so both @<handle>-derived
// and literal @character_N forms are covered. Markers within range are preserved.
// Case-insensitive to match the API's marker syntax.
export function stripOrphanedReferenceMarkers(
  text: string,
  counts: { character: number; referenceImage: number; referenceAudio: number },
): string {
  const stripKind = (input: string, re: RegExp, max: number): string =>
    input.replace(re, (full, digits: string) => {
      const n = Number(digits);
      return n < 1 || n > max ? '' : full;
    });

  let out = stripKind(text, CHARACTER_SLOT_RE, counts.character);
  out = stripKind(out, REFERENCE_IMAGE_SLOT_RE, counts.referenceImage);
  out = stripKind(out, REFERENCE_AUDIO_SLOT_RE, counts.referenceAudio);
  return out;
}

// Renumber @referenceImage_N markers after the slot at `removedN` (1-based) is
// removed: the removed marker is deleted, and every marker with N greater than
// removedN is decremented so it still points at the same image. Case-insensitive
// (reuses REFERENCE_IMAGE_SLOT_RE); output is normalized to the canonical
// lowercase form. Lower/other markers are left untouched.
export function renumberReferenceImageMarkers(text: string, removedN: number): string {
  return text.replace(REFERENCE_IMAGE_SLOT_RE, (_full, digits: string) => {
    const n = Number(digits);
    if (n === removedN) return '';
    if (n > removedN) return `@referenceImage_${n - 1}`;
    return `@referenceImage_${n}`;
  });
}
