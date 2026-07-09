import { stripSlugPrefix } from '@/lib/slugs'
import type { ResolvedAsset } from '@/components/gen/types'

export interface SlotAsset {
  slug: string
  src: string
  thumbnailSrc?: string | null
  type: 'image' | 'video' | 'audio' | 'character'
}

/** Resolve a form/sidebar slug to a drop-slot asset with thumbnail when possible. */
export function resolveSlugToAsset(
  slug: string,
  resolvedAssets?: ResolvedAsset[],
  droppedAssets?: Map<string, ResolvedAsset>,
): SlotAsset | null {
  const raw = slug.trim()
  if (!raw) return null
  const clean = stripSlugPrefix(raw)
  const withAt = raw.startsWith('@') ? raw : `@${clean}`

  const fromDropped =
    droppedAssets?.get(raw)
    ?? droppedAssets?.get(withAt)
    ?? droppedAssets?.get(clean)
  if (fromDropped) {
    return {
      slug: fromDropped.slug || withAt,
      src: fromDropped.src || '',
      thumbnailSrc: fromDropped.thumbnailSrc,
      type: fromDropped.type === 'character' ? 'character' : 'image',
    }
  }

  const fromResolved = resolvedAssets?.find((a) => {
    const aClean = a.slug ? stripSlugPrefix(a.slug) : ''
    return a.slug === raw || a.slug === withAt || a.slug === clean || aClean === clean
  })
  if (fromResolved) {
    return {
      slug: fromResolved.slug || withAt,
      src: fromResolved.src || '',
      thumbnailSrc: fromResolved.thumbnailSrc,
      type: fromResolved.type === 'character' ? 'character' : 'image',
    }
  }

  return {
    slug: withAt,
    src: '',
    thumbnailSrc: null,
    type: 'image',
  }
}

/** Seed primary/alt forge slots from candidate slugs (fills only empty slots). */
export function seedSlotsFromCandidates(
  candidates: string[],
  resolvedAssets?: ResolvedAsset[],
  droppedAssets?: Map<string, ResolvedAsset>,
  existing?: { primary: SlotAsset | null; alt: SlotAsset | null },
): { primary: SlotAsset | null; alt: SlotAsset | null } {
  const primary = existing?.primary ?? null
  const alt = existing?.alt ?? null
  if (primary && alt) return { primary, alt }

  const unique = candidates.map((s) => s.trim()).filter(Boolean)
  let nextPrimary = primary
  let nextAlt = alt

  for (const slug of unique) {
    const asset = resolveSlugToAsset(slug, resolvedAssets, droppedAssets)
    if (!asset) continue
    if (!nextPrimary) {
      nextPrimary = asset
      continue
    }
    if (!nextAlt && stripSlugPrefix(asset.slug) !== stripSlugPrefix(nextPrimary.slug)) {
      nextAlt = asset
      break
    }
  }

  return { primary: nextPrimary, alt: nextAlt }
}

export function nameFromAsset(asset: SlotAsset | null): string {
  if (!asset) return ''
  return stripSlugPrefix(asset.slug).replace(/^img-/, '') || ''
}
