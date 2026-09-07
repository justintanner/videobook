import { TAG_FACETS, type TagFacet } from 'videobook-engine/tag-values'

/**
 * Client-side reading of the tag state an asset payload carries.
 *
 * The server sends canonical identities the engine produced; nothing here
 * re-derives a key from a label. Parsing is defensive because an older server
 * simply omits the field, and a UI that shows tags must not break on one.
 */

type AssetTagOrigin = 'manual' | 'automatic'

export type AssetTag = {
  facet: TagFacet
  key: string
  label: string
  origin: AssetTagOrigin
  entityId: string | null
}

export type DismissedAssetTag = {
  facet: TagFacet
  key: string
  label: string
}

type AssetTagAnalysis = {
  sourceHash: string
  generator: string
  model: string | null
  extractorVersion: string
  tagCount: number
  analyzedAt: number
  /** The analyzed bytes are no longer the asset's content. */
  stale: boolean
}

export type AssetTags = {
  /** Manual tags plus live, undismissed automatic tags. */
  effective: AssetTag[]
  manual: AssetTag[]
  automatic: AssetTag[]
  dismissed: DismissedAssetTag[]
  analysis: AssetTagAnalysis | null
  /** Changes only when the effective set or a dismissal changes. */
  fingerprint: string
}

export const EMPTY_ASSET_TAGS: AssetTags = {
  effective: [],
  manual: [],
  automatic: [],
  dismissed: [],
  analysis: null,
  fingerprint: '',
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function facet(value: unknown): TagFacet | null {
  return typeof value === 'string'
    && (TAG_FACETS as readonly string[]).includes(value)
    ? (value as TagFacet)
    : null
}

function tag(value: unknown): AssetTag | null {
  const entry = record(value)
  const parsedFacet = facet(entry?.facet)
  const key = text(entry?.key)
  const label = text(entry?.label)
  if (!entry || !parsedFacet || !key || !label) return null
  return {
    facet: parsedFacet,
    key,
    label,
    origin: entry.origin === 'automatic' ? 'automatic' : 'manual',
    entityId: text(entry.entity_id ?? entry.entityId),
  }
}

function dismissed(value: unknown): DismissedAssetTag | null {
  const parsed = tag(value)
  return parsed
    ? { facet: parsed.facet, key: parsed.key, label: parsed.label }
    : null
}

function list<T>(value: unknown, parse: (entry: unknown) => T | null): T[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const parsed = parse(entry)
        return parsed ? [parsed] : []
      })
    : []
}

function analysis(value: unknown): AssetTagAnalysis | null {
  const entry = record(value)
  const sourceHash = text(entry?.source_hash ?? entry?.sourceHash)
  const generator = text(entry?.generator)
  const extractorVersion = text(
    entry?.extractor_version ?? entry?.extractorVersion,
  )
  if (!entry || !sourceHash || !generator || !extractorVersion) return null
  const tagCount = Number(entry.tag_count ?? entry.tagCount)
  const analyzedAt = Number(entry.analyzed_at ?? entry.analyzedAt)
  return {
    sourceHash,
    generator,
    model: text(entry.model),
    extractorVersion,
    tagCount: Number.isFinite(tagCount) ? tagCount : 0,
    analyzedAt: Number.isFinite(analyzedAt) ? analyzedAt : 0,
    stale: entry.stale === true,
  }
}

/** Null for rows that carry no tag state at all, such as notebook rows. */
export function parseAssetTags(value: unknown): AssetTags | null {
  const entry = record(value)
  if (!entry) return null
  return {
    effective: list(entry.effective, tag),
    manual: list(entry.manual, tag),
    automatic: list(entry.automatic, tag),
    dismissed: list(entry.dismissed, dismissed),
    analysis: analysis(entry.analysis),
    fingerprint: text(entry.fingerprint) ?? '',
  }
}

/** Stable display order: facet first, then label, so chips never jump. */
export function orderedTags(tags: readonly AssetTag[]): AssetTag[] {
  const facetRank = new Map(TAG_FACETS.map((name, index) => [name, index]))
  return [...tags].sort((left, right) =>
    (facetRank.get(left.facet) ?? 0) - (facetRank.get(right.facet) ?? 0)
    || left.label.localeCompare(right.label))
}
