import { describe, expect, it } from 'vitest'
import { notebookGridTag } from 'videobook-engine/notebook-grid'
import {
  generationInputMentionRows,
  mentionMediaKind,
  mentionMenuRows,
  mentionThumbnailUrl,
  notebookAddressSuggestions,
  type AssetMentionCandidate,
} from './mention-suggestions'

// Rows run a–z, aa–az, ba–bl, so row "ad" is the fourth of the two-letter run.
const ROW_AD = 29

function tag(column: number): string {
  return notebookGridTag({ row: ROW_AD, column })
}

function candidate(
  column: number,
  overrides: Partial<AssetMentionCandidate> = {},
): AssetMentionCandidate {
  return {
    artifactId: `artifact-${column}`,
    type: 'video',
    mediaUrl: `https://example.invalid/${column}.mp4`,
    thumbnailUrl: `https://example.invalid/${column}.jpg`,
    width: 1440,
    height: 810,
    duration: 6,
    status: 'ready',
    cellAddress: tag(column).slice(1),
    ...overrides,
  }
}

describe('mentionMenuRows', () => {
  it('leads with the squares holding media and trails the empty ones', () => {
    const cells = [
      { slot: { row: ROW_AD, column: 2 }, type: 'generate_video', label: 'rooftop wide' },
      { slot: { row: ROW_AD, column: 4 }, type: 'generate_image', label: 'actress key light' },
    ]
    const assets = [candidate(2), candidate(4, { type: 'image', duration: null })]

    const rows = mentionMenuRows(assets, cells, 'dance from @ad')

    expect(rows.map((row) => row.value)).toEqual([
      tag(2),
      tag(4),
      tag(0),
      tag(1),
      tag(3),
      tag(5),
      tag(6),
      tag(7),
    ])
    expect(rows.slice(0, 2).every((row) => !row.empty)).toBe(true)
    expect(rows.slice(2).every((row) => row.empty)).toBe(true)
  })

  it('carries the poster frame, the cell label and the facts onto a media row', () => {
    const cells = [
      { slot: { row: ROW_AD, column: 2 }, type: 'generate_video', label: '  rooftop wide  ' },
    ]

    const [row] = mentionMenuRows([candidate(2)], cells, '@ad')

    expect(row).toMatchObject({
      value: tag(2),
      label: tag(2),
      caption: 'rooftop wide',
      thumbnailUrl: 'https://example.invalid/2.jpg',
      mediaKind: 'video',
      empty: false,
    })
    expect(row?.description).toBe('VIDEO · 1440×810 · 0:06')
  })

  it('says nothing about an empty square beyond its address', () => {
    const empty = mentionMenuRows([], [], '@ad').at(0)

    expect(empty).toMatchObject({
      value: tag(0),
      caption: null,
      thumbnailUrl: null,
      mediaKind: null,
      empty: true,
      description: 'Empty grid square',
    })
  })

  it('keeps a cell with no output as its own row, not an empty chip', () => {
    const cells = [{ slot: { row: ROW_AD, column: 2 }, type: 'generate_video' }]

    const rows = mentionMenuRows([], cells, '@ad')

    expect(rows[0]).toMatchObject({
      value: tag(2),
      empty: false,
      mediaKind: 'video',
      thumbnailUrl: null,
      description: 'GENERATE VIDEO cell',
    })
  })

  it('lists each address once when an asset and the grid both match it', () => {
    const cells = [{ slot: { row: ROW_AD, column: 2 }, type: 'generate_video' }]

    const values = mentionMenuRows([candidate(2)], cells, '@ad').map((row) => row.value)

    expect(values).toEqual([...new Set(values)])
    expect(values.filter((value) => value === tag(2))).toHaveLength(1)
  })

  it('caps the rows and the empty chips separately', () => {
    const cells = Array.from({ length: 8 }, (_unused, column) => ({
      slot: { row: ROW_AD, column },
      type: 'generate_video',
    }))
    const assets = Array.from({ length: 8 }, (_unused, column) => candidate(column))

    const capped = mentionMenuRows(assets, cells, '@ad', new Set(), { rows: 2, empties: 1 })

    expect(capped).toHaveLength(2)
    expect(capped.every((row) => !row.empty)).toBe(true)
  })

  it('drops the squares the caller excludes', () => {
    const rows = mentionMenuRows([], [], '@ad', new Set([tag(0), tag(1)]))

    expect(rows.map((row) => row.value)).not.toContain(tag(0))
    expect(rows.map((row) => row.value)).not.toContain(tag(1))
    expect(rows[0]?.value).toBe(tag(2))
  })

  it('returns nothing when the caret is not inside a mention', () => {
    expect(mentionMenuRows([candidate(2)], [], 'dance from the rooftop')).toEqual([])
  })
})

describe('notebookAddressSuggestions', () => {
  it('flags emptiness and the cell type instead of leaving it to the prose', () => {
    const cells = [{ slot: { row: ROW_AD, column: 2 }, type: 'split_video' }]

    const suggestions = notebookAddressSuggestions(cells, '@ad')
    const occupied = suggestions.find((suggestion) => suggestion.value === tag(2))
    const vacant = suggestions.find((suggestion) => suggestion.value === tag(3))

    expect(occupied).toMatchObject({ empty: false, cellType: 'split_video' })
    expect(vacant).toMatchObject({ empty: true, cellType: null })
  })
})

describe('mentionThumbnailUrl', () => {
  it('prefers a real thumbnail', () => {
    expect(mentionThumbnailUrl({
      type: 'video',
      thumbnailUrl: 'https://example.invalid/poster.jpg',
      mediaUrl: 'https://example.invalid/clip.mp4',
    })).toBe('https://example.invalid/poster.jpg')
  })

  it('falls back to the media itself only for stills', () => {
    expect(mentionThumbnailUrl({
      type: 'image',
      thumbnailUrl: null,
      mediaUrl: 'https://example.invalid/still.png',
    })).toBe('https://example.invalid/still.png')
    expect(mentionThumbnailUrl({
      type: 'video',
      thumbnailUrl: null,
      mediaUrl: 'https://example.invalid/clip.mp4',
    })).toBeNull()
  })
})

describe('mentionMediaKind', () => {
  it('maps asset types and cell types onto the same glyph', () => {
    expect(mentionMediaKind('video')).toBe('video')
    expect(mentionMediaKind('generate_video')).toBe('video')
    expect(mentionMediaKind('final')).toBe('video')
    expect(mentionMediaKind('concat')).toBe('video')
    expect(mentionMediaKind('generate_image')).toBe('image')
    expect(mentionMediaKind('extract_audio')).toBe('audio')
    expect(mentionMediaKind('search')).toBe('other')
  })
})

describe('generationInputMentionRows', () => {
  it('offers only connected inputs, named by input slot', () => {
    const still = { slot: { row: ROW_AD, column: 4 }, type: 'image', label: 'actress key light' }
    const clip = { slot: { row: ROW_AD, column: 2 }, type: 'generate_video' }
    const inputs = [
      { token: 'image1', cell: still },
      { token: 'video1', cell: clip },
    ]
    const assets = [candidate(2), candidate(4, { type: 'image', duration: null })]

    expect(generationInputMentionRows(inputs, assets, 'portrait of @')).toEqual([
      {
        value: '@image1',
        label: '@image1',
        description: `${tag(4)} · IMAGE · 1440×810`,
        caption: 'actress key light',
        thumbnailUrl: 'https://example.invalid/4.jpg',
        mediaKind: 'image',
        empty: false,
      },
      {
        value: '@video1',
        label: '@video1',
        description: `${tag(2)} · VIDEO · 1440×810 · 0:06`,
        caption: null,
        thumbnailUrl: 'https://example.invalid/2.jpg',
        mediaKind: 'video',
        empty: false,
      },
    ])
    expect(generationInputMentionRows(inputs, assets, 'portrait of @vi')
      .map((row) => row.value)).toEqual(['@video1'])
    expect(generationInputMentionRows(inputs, assets, `portrait of ${tag(4)}`)).toEqual([])
    expect(generationInputMentionRows(inputs, assets, 'no mention')).toEqual([])
  })
})

