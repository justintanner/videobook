/** Short character names derived from image/char asset slugs (Google Flow display_name).
 *  Mirror of server/src/character-name.ts — keep rules in sync. */

const MIN_STEM_LEN = 3

/** Strip @ and normalize to bare asset id. */
export function bareAssetId(slug: string): string {
  return slug.startsWith('@') ? slug.slice(1) : slug
}

/**
 * Stem suitable for a short character name.
 * img-french-head → french-head
 * char-img-french-head → french-head
 * char-french-head → french-head
 * img-n → "" (degenerate)
 */
export function characterNameStem(slugOrId: string): string {
  let s = bareAssetId(slugOrId).trim()
  if (s.startsWith('char-')) s = s.slice('char-'.length)
  if (s.startsWith('img-')) s = s.slice('img-'.length)
  s = s.trim()
  return s.length >= MIN_STEM_LEN ? s : ''
}

export function parseCharacterMetadataObject(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  const trimmed = raw.trim()
  if (!trimmed) return {}
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return { notes: trimmed }
  }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // leave empty
  }
  return {}
}

/** Prefer saved display_name; else stem from asset id. */
export function resolveDisplayName(
  metadata: Record<string, unknown> | string | undefined,
  assetId: string,
): string {
  const meta = typeof metadata === 'string' ? parseCharacterMetadataObject(metadata) : (metadata ?? {})
  const saved = meta.display_name
  if (typeof saved === 'string' && saved.trim()) return saved.trim()
  return characterNameStem(assetId)
}
