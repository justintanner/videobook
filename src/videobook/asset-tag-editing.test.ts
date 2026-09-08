import { describe, expect, it } from 'vitest'
import {
  applyTagEdit,
  filterTermFromTag,
  sameTagFilter,
  tagFilterArgs,
  tagOriginLabel,
  toggleTagFilter,
  visibleSuggestions,
  type TagFilterTerm,
} from './asset-tag-editing'
import type { AssetTag, AssetTags } from './asset-tags'

function tag(
  facet: AssetTag['facet'],
  label: string,
  origin: AssetTag['origin'] = 'manual',
): AssetTag {
  return { facet, key: label.toLowerCase(), label, origin, entityId: null }
}

function state(overrides: Partial<AssetTags> = {}): AssetTags {
  return {
    effective: [],
    manual: [],
    automatic: [],
    dismissed: [],
    analysis: null,
    fingerprint: 'abc',
    ...overrides,
  }
}

describe('optimistic tag edits', () => {
  it('shows an added tag as the user\'s own', () => {
    const next = applyTagEdit(state(), { facet: 'places', label: 'Kitchen' }, 'add')
    expect(next.effective.map((entry) => entry.key)).toEqual(['kitchen'])
    expect(next.effective[0]?.origin).toBe('manual')
    expect(next.manual).toHaveLength(1)
  })

  it('normalizes an added label into the identity the server will use', () => {
    const next = applyTagEdit(
      state(),
      { facet: 'editing', label: '  Close   Up  ' },
      'add',
    )
    expect(next.effective[0]?.key).toBe('close-up')
    expect(next.effective[0]?.label).toBe('close-up')
  })

  it('adding a tag back lifts its dismissal', () => {
    const current = state({
      dismissed: [{ facet: 'places', key: 'kitchen', label: 'Kitchen' }],
    })
    const next = applyTagEdit(current, { facet: 'places', label: 'Kitchen' }, 'add')
    expect(next.dismissed).toEqual([])
    expect(next.effective.map((entry) => entry.key)).toEqual(['kitchen'])
  })

  it('removing either origin records a dismissal', () => {
    const automatic = tag('places', 'Kitchen', 'automatic')
    const manual = tag('custom', 'Hero shot')
    const current = state({
      effective: [automatic, manual],
      manual: [manual],
      automatic: [automatic],
    })

    const withoutAutomatic = applyTagEdit(
      current,
      { facet: 'places', label: 'Kitchen' },
      'remove',
    )
    expect(withoutAutomatic.effective.map((entry) => entry.key)).toEqual(['hero shot'])
    expect(withoutAutomatic.dismissed.map((entry) => entry.key)).toEqual(['kitchen'])

    const withoutManual = applyTagEdit(
      current,
      { facet: 'custom', label: 'Hero shot' },
      'remove',
    )
    expect(withoutManual.effective.map((entry) => entry.key)).toEqual(['kitchen'])
    expect(withoutManual.dismissed.map((entry) => entry.key)).toEqual(['hero shot'])
  })

  it('restores a dismissed tag only when the analysis still carries it', () => {
    const automatic = tag('places', 'Kitchen', 'automatic')
    const carried = state({
      automatic: [automatic],
      dismissed: [{ facet: 'places', key: 'kitchen', label: 'Kitchen' }],
    })
    const restored = applyTagEdit(
      carried,
      { facet: 'places', label: 'Kitchen' },
      'restore',
    )
    expect(restored.dismissed).toEqual([])
    expect(restored.effective.map((entry) => entry.key)).toEqual(['kitchen'])

    // Dismissed, but no longer proposed: the dismissal lifts and nothing
    // reappears until an analysis proposes it again.
    const dropped = state({
      dismissed: [{ facet: 'people', key: 'crowd', label: 'Crowd' }],
    })
    const lifted = applyTagEdit(dropped, { facet: 'people', label: 'Crowd' }, 'restore')
    expect(lifted.dismissed).toEqual([])
    expect(lifted.effective).toEqual([])
  })

  it('returns the same object when an edit changes nothing', () => {
    const current = state({ effective: [tag('places', 'Kitchen')], manual: [tag('places', 'Kitchen')] })
    expect(applyTagEdit(current, { facet: 'places', label: 'Kitchen' }, 'add'))
      .toBe(current)
    expect(applyTagEdit(current, { facet: 'people', label: 'Crowd' }, 'remove'))
      .toBe(current)
    expect(applyTagEdit(current, { facet: 'places', label: '   ' }, 'add'))
      .toBe(current)
  })

  it('keeps facets apart when the same word appears in two of them', () => {
    const current = state({
      effective: [
        tag('people', 'Handheld', 'automatic'),
        tag('editing', 'Handheld', 'automatic'),
      ],
      automatic: [
        tag('people', 'Handheld', 'automatic'),
        tag('editing', 'Handheld', 'automatic'),
      ],
    })
    const next = applyTagEdit(current, { facet: 'people', label: 'Handheld' }, 'remove')
    expect(next.effective.map((entry) => entry.facet)).toEqual(['editing'])
  })

  it('describes origin without exposing model internals', () => {
    expect(tagOriginLabel(tag('places', 'Kitchen'))).toBe('Added by you')
    expect(tagOriginLabel(tag('places', 'Kitchen', 'automatic'))).toBe('From analysis')
  })
})

describe('tag filters', () => {
  const kitchen: TagFilterTerm = { facet: 'places', key: 'kitchen', label: 'Kitchen' }
  const street: TagFilterTerm = { facet: 'places', key: 'street', label: 'Street' }

  it('toggles a term on and off', () => {
    const applied = toggleTagFilter([], kitchen)
    expect(applied).toEqual([kitchen])
    expect(toggleTagFilter(applied, kitchen)).toEqual([])
    expect(toggleTagFilter(applied, street)).toEqual([kitchen, street])
  })

  it('sends nothing at all when no term is applied', () => {
    expect(tagFilterArgs([])).toEqual({})
    expect(tagFilterArgs([kitchen, street])).toEqual({
      tags_all: [
        { facet: 'places', label: 'Kitchen' },
        { facet: 'places', label: 'Street' },
      ],
    })
  })

  it('compares filters by identity, not order', () => {
    expect(sameTagFilter([kitchen, street], [street, kitchen])).toBe(true)
    expect(sameTagFilter([kitchen], [kitchen, street])).toBe(false)
    expect(sameTagFilter([], [])).toBe(true)
  })

  it('builds a term from a tag on a card', () => {
    expect(filterTermFromTag(tag('editing', 'Wide shot'))).toEqual({
      facet: 'editing',
      key: 'wide shot',
      label: 'Wide shot',
    })
  })

  it('does not suggest tags the asset already carries', () => {
    const suggestions = [
      { facet: 'places' as const, key: 'kitchen', label: 'Kitchen', assets: 4 },
      { facet: 'places' as const, key: 'street', label: 'Street', assets: 2 },
    ]
    expect(visibleSuggestions(suggestions, [tag('places', 'Kitchen')]))
      .toEqual([suggestions[1]])
    expect(visibleSuggestions(suggestions, [], 1)).toEqual([suggestions[0]])
  })
})
