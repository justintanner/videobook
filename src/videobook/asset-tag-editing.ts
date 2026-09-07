import { tagCanonicalKey, type TagFacet } from 'videobook-engine/tag-values'
import {
  EMPTY_ASSET_TAGS,
  orderedTags,
  type AssetTag,
  type AssetTags,
  type DismissedAssetTag,
} from './asset-tags'

/**
 * Tag editing as the client sees it.
 *
 * Two jobs live here, both pure so the components stay about rendering. The
 * first is predicting what the server will say: an edit shows immediately and
 * is replaced by the canonical state when it lands, or rolled back if it does
 * not, so a chip never sits there greyed out waiting for a round trip.
 *
 * The prediction follows the engine's own rules — manual intent outranks
 * analysis, removing an automatic tag dismisses it rather than deleting it —
 * because a prediction that disagrees with the server produces a visible flick
 * when the real state arrives.
 *
 * The second is filter terms: identity is (facet, canonical key), never the
 * display label, so `places/kitchen` and a custom tag someone typed as
 * "Kitchen" stay distinct exactly as they do on the server.
 */

export type TagEditAction = 'add' | 'remove' | 'restore'

export type TagEdit = {
  facet: TagFacet
  label: string
}

export type TagFilterTerm = {
  facet: TagFacet
  key: string
  label: string
}

function identity(facet: TagFacet, key: string): string {
  return `${facet}/${key}`
}

/**
 * The engine's normalizer rejects a blank label by throwing, which is right
 * for a write and wrong for a keystroke: someone typing a space has not made
 * an edit yet. An unusable label yields no key instead.
 */
function canonicalKeyOf(label: string): string {
  return label.trim() ? tagCanonicalKey(label) : ''
}

export function tagIdentityOf(tag: {
  facet: TagFacet
  key: string
}): string {
  return identity(tag.facet, tag.key)
}

export function editIdentity(edit: TagEdit): string {
  return identity(edit.facet, canonicalKeyOf(edit.label))
}

export function sameTagIdentity(
  left: { facet: TagFacet; key: string },
  right: { facet: TagFacet; key: string },
): boolean {
  return tagIdentityOf(left) === tagIdentityOf(right)
}

/** "Added by you" or "From analysis" — never a model name or a score. */
export function tagOriginLabel(tag: AssetTag): string {
  return tag.origin === 'manual' ? 'Added by you' : 'From analysis'
}

function withoutIdentity<T extends { facet: TagFacet; key: string }>(
  tags: readonly T[],
  target: string,
): T[] {
  return tags.filter((tag) => tagIdentityOf(tag) !== target)
}

/**
 * What the asset will look like once the server agrees. Returns the same
 * object when an edit changes nothing, so React skips the render.
 */
export function applyTagEdit(
  tags: AssetTags | null,
  edit: TagEdit,
  action: TagEditAction,
): AssetTags {
  const current = tags ?? EMPTY_ASSET_TAGS
  const key = canonicalKeyOf(edit.label)
  if (!key) return current
  const target = identity(edit.facet, key)

  if (action === 'add') {
    if (current.effective.some((tag) => tagIdentityOf(tag) === target)) {
      return current
    }
    const added: AssetTag = {
      facet: edit.facet,
      key,
      label: edit.label.trim(),
      origin: 'manual',
      entityId: null,
    }
    return {
      ...current,
      // A tag someone adds back is no longer dismissed.
      dismissed: withoutIdentity(current.dismissed, target),
      manual: orderedTags([...current.manual, added]),
      effective: orderedTags([...current.effective, added]),
    }
  }

  if (action === 'remove') {
    const removed = current.effective.find(
      (tag) => tagIdentityOf(tag) === target,
    )
    if (!removed) return current
    // Removing an automatic tag records the user's intent so re-analysis
    // cannot bring it back; removing a manual one simply deletes it.
    const dismissal: DismissedAssetTag[] = removed.origin === 'automatic'
      ? [{ facet: removed.facet, key: removed.key, label: removed.label }]
      : []
    return {
      ...current,
      effective: withoutIdentity(current.effective, target),
      manual: withoutIdentity(current.manual, target),
      dismissed: [...withoutIdentity(current.dismissed, target), ...dismissal],
    }
  }

  const dismissed = current.dismissed.find(
    (tag) => tagIdentityOf(tag) === target,
  )
  if (!dismissed) return current
  const restored = current.automatic.find(
    (tag) => tagIdentityOf(tag) === target,
  )
  return {
    ...current,
    dismissed: withoutIdentity(current.dismissed, target),
    // Only a tag the current analysis still carries comes back; otherwise the
    // dismissal simply lifts and a future analysis may surface it again.
    effective: restored
      ? orderedTags([...current.effective, restored])
      : current.effective,
  }
}

/** Adds a term, or removes it when it is already applied. */
export function toggleTagFilter(
  terms: readonly TagFilterTerm[],
  term: TagFilterTerm,
): TagFilterTerm[] {
  const target = tagIdentityOf(term)
  const existing = terms.some((entry) => tagIdentityOf(entry) === target)
  return existing
    ? terms.filter((entry) => tagIdentityOf(entry) !== target)
    : [...terms, term]
}

export function filterTermFromTag(tag: {
  facet: TagFacet
  key: string
  label: string
}): TagFilterTerm {
  return { facet: tag.facet, key: tag.key, label: tag.label }
}

/**
 * Filter terms as the MCP tools take them. An empty filter sends nothing at
 * all rather than an empty array, so an unfiltered search stays the request it
 * always was.
 */
export function tagFilterArgs(
  terms: readonly TagFilterTerm[],
): { tags_all?: Array<{ facet: TagFacet; label: string }> } {
  if (terms.length === 0) return {}
  return {
    tags_all: terms.map((term) => ({ facet: term.facet, label: term.label })),
  }
}

/** True when the two filters would produce the same request. */
export function sameTagFilter(
  left: readonly TagFilterTerm[],
  right: readonly TagFilterTerm[],
): boolean {
  if (left.length !== right.length) return false
  const target = new Set(left.map(tagIdentityOf))
  return right.every((term) => target.has(tagIdentityOf(term)))
}

export type TagSuggestion = {
  facet: TagFacet
  key: string
  label: string
  assets: number
}

/**
 * Suggestions for what someone is typing: tags already on this asset are
 * dropped, because offering a tag that is already there is a dead end.
 */
export function visibleSuggestions(
  suggestions: readonly TagSuggestion[],
  applied: readonly { facet: TagFacet; key: string }[],
  limit = 8,
): TagSuggestion[] {
  const used = new Set(applied.map(tagIdentityOf))
  return suggestions
    .filter((suggestion) => !used.has(tagIdentityOf(suggestion)))
    .slice(0, limit)
}
