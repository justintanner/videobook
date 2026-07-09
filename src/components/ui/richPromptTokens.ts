// Tokenizer for the transparent rich-prompt overlay. Prompts reference assets
// two ways: positional "[Image N]" tokens (produced by normalizeStoryboardVideoPrompt
// and rewriteVisualWithImageTokens) and "@slug" mentions (only confirmed against
// the known asset slugs so stray "@foo" stays plain text). Both render as inline
// micro-thumbs. Tokens are re-derived from the text every render (pattern-based,
// no stored positions), which keeps editing dead simple — there is no token state
// to keep in sync with the caret.

export type RichToken =
  | { kind: 'slug'; slug: string }
  | { kind: 'image-ref'; n: number }
  | { kind: 'character-ref'; n: number };

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

// Positional image refs come in three flavours across the formulas: "[Image N]"
// (storyboard, normalizeStoryboardVideoPrompt), "@ImageN" (char_swap video,
// rewriteVisualWithImageTokens), and bare "Image N" (char_swap swap prompt,
// defaultSwapPrompt). All three resolve to the same image-ref token; the matched
// substring (brackets/@ included) defines the chip's character width. The bare
// form's lookbehind keeps it from re-matching inside the bracket/@ forms.
const IMAGE_REF_RE = /\[Image\s*(\d+)\]|@Image\s*(\d+)|(?<![@[\w])Image\s*(\d+)\b/gi;

// Positional character refs mirror image refs: useapi's Google Flow prompt accepts
// inline "@character_1".."@character_7" that bind to the character_1..7 body params
// videocity already sends from character_refs. Bracketed "[Character N]" and bare
// "character N" forms resolve to the same token; the bare lookbehind keeps it from
// re-matching inside the bracket/@ forms.
const CHARACTER_REF_RE = /\[Character\s*(\d+)\]|@character[_\s]*(\d+)|(?<![@[\w])character[_\s]*(\d+)\b/gi;

// Find every image ref, character ref and @slug occurrence. @slug only matches a
// slug we know about (longest-first so e.g. "@vid-intro" wins over a hypothetical "@vid").
export function extractRichTokens(text: string, assetSlugs: string[]): TokenMatch[] {
  const matches: TokenMatch[] = [];

  for (const m of text.matchAll(IMAGE_REF_RE)) {
    const start = m.index ?? 0;
    matches.push({
      start,
      end: start + m[0].length,
      token: { kind: 'image-ref', n: Number(m[1] ?? m[2] ?? m[3]) },
    });
  }

  for (const m of text.matchAll(CHARACTER_REF_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (matches.some((x) => start < x.end && end > x.start)) continue; // overlap → skip
    matches.push({
      start,
      end,
      token: { kind: 'character-ref', n: Number(m[1] ?? m[2] ?? m[3]) },
    });
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
