/** Detect local asset slugs (@img-*, @vid-*, @aud-*) remaining in a provider
 *  payload so the notebook JSON preview can tell wire-form text (prompt) apart
 *  from URL-field placeholders (uploads resolve those at submit). */

const ASSET_SLUG_RE = /@(img|vid|aud)-[\w-]+/g

const URL_FIELD_KEYS = new Set([
  'image_urls',
  'image_url',
  'reference_image',
  'reference_image_urls',
  'reference_images',
  'reference_video_urls',
  'reference_audio_urls',
  'video_url',
  'video_urls',
  'first_frame_url',
  'last_frame_url',
  'first_frame',
  'last_frame',
  'audio_url',
  'audio_urls',
  'character_image_urls',
  'motion_video_urls',
  'driving_audio_url',
  'start_image',
  'end_image',
])

function collectSlugMentions(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(ASSET_SLUG_RE)) {
    if (!found.includes(match[0])) found.push(match[0])
  }
  return found
}

function isUrlishKey(key: string): boolean {
  if (URL_FIELD_KEYS.has(key)) return true
  if (key.endsWith('_url') || key.endsWith('_urls')) return true
  if (key === 'image' || key === 'images' || key === 'video' || key === 'videos') return true
  return false
}

function walk(
  value: unknown,
  pathKey: string | null,
  into: { promptSlugs: string[]; urlSlugs: string[] },
): void {
  if (typeof value === 'string') {
    const mentions = collectSlugMentions(value)
    if (mentions.length === 0) return
    if (pathKey === 'prompt' || pathKey === 'negative_prompt') {
      for (const m of mentions) {
        if (!into.promptSlugs.includes(m)) into.promptSlugs.push(m)
      }
      return
    }
    if (pathKey !== null && isUrlishKey(pathKey)) {
      for (const m of mentions) {
        if (!into.urlSlugs.includes(m)) into.urlSlugs.push(m)
      }
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, pathKey, into)
    return
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walk(v, k, into)
    }
  }
}

export interface ProviderPayloadSlugHints {
  /** Local asset slugs still present in prompt text — should be empty after server rewrite. */
  promptSlugs: string[]
  /** Local asset slugs standing in for upload URLs — expected until submit. */
  urlSlugs: string[]
}

export function inspectProviderPayloadSlugs(payload: unknown): ProviderPayloadSlugHints {
  const into: ProviderPayloadSlugHints = { promptSlugs: [], urlSlugs: [] }
  walk(payload, null, into)
  return into
}
