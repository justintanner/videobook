import { orderedTags, type AssetTags } from '@/videobook/asset-tags'
import { filterTermFromTag, type TagFilterTerm } from '@/videobook/asset-tag-editing'

/**
 * The compact read of an asset's tags, for cards in a list.
 *
 * A card has room for a handful of terms, so this shows the first few in a
 * stable order and counts the rest instead of wrapping into a wall of
 * keywords — the failure mode the tag policy exists to avoid. When a filter
 * handler is supplied each chip becomes a way to narrow the list, which is
 * how someone gets from "this clip is interesting" to "show me the others
 * like it" without typing anything.
 */

type AssetTagSummaryProps = {
  tags: AssetTags | null
  limit?: number
  onFilter?: ((term: TagFilterTerm) => void) | undefined
  /** Terms already applied, so an active chip reads as pressed. */
  activeTerms?: readonly TagFilterTerm[]
}

export function AssetTagSummary({
  tags,
  limit = 4,
  onFilter,
  activeTerms = [],
}: AssetTagSummaryProps) {
  const effective = orderedTags(tags?.effective ?? [])
  if (effective.length === 0) return null
  const shown = effective.slice(0, limit)
  const remaining = effective.length - shown.length
  const active = new Set(activeTerms.map((term) => `${term.facet}/${term.key}`))

  return (
    <div className="asset-tag-summary" role="list" aria-label="Tags">
      {shown.map((tag) => {
        const identity = `${tag.facet}/${tag.key}`
        const isActive = active.has(identity)
        if (!onFilter) {
          return (
            <span className="asset-tag-summary-chip" key={identity} role="listitem">
              {tag.label}
            </span>
          )
        }
        return (
          <button
            type="button"
            key={identity}
            role="listitem"
            className="asset-tag-summary-chip asset-tag-summary-chip-action"
            aria-pressed={isActive}
            title={isActive ? `Remove filter ${tag.label}` : `Filter by ${tag.label}`}
            onClick={() => onFilter(filterTermFromTag(tag))}
          >
            {tag.label}
          </button>
        )
      })}
      {remaining > 0
        ? (
          <span className="asset-tag-summary-more" role="listitem">
            {`+${remaining}`}
          </span>
        )
        : null}
    </div>
  )
}
