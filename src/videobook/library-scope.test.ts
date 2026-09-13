import { describe, expect, it } from 'vitest'
import {
  libraryBrowseStatusFromValue,
  libraryGridAssets,
  libraryGridHeading,
  libraryScopeFromValue,
  matchesLibraryBrowseStatus,
  mergeBookGridAssets,
  overlayLiveLibraryAssets,
  type OwningBook,
} from './library-scope'

type TestAsset = {
  artifactId: string
  status: string
  createdAt: string
}

const activeBook: OwningBook = {
  owningBookId: 'book-active',
  owningBookName: 'catdance',
}

function asset(artifactId: string, createdAt: string, status = 'ready'): TestAsset {
  return { artifactId, status, createdAt }
}

function foreign(artifactId: string, createdAt: string, bookId: string, bookName: string) {
  return {
    ...asset(artifactId, createdAt),
    owningBookId: bookId,
    owningBookName: bookName,
  }
}

describe('libraryScopeFromValue', () => {
  it('keeps the library-wide default until a book scope is stored', () => {
    expect(libraryScopeFromValue(null)).toBe('library')
    expect(libraryScopeFromValue('')).toBe('library')
    expect(libraryScopeFromValue('library')).toBe('library')
    expect(libraryScopeFromValue('nonsense')).toBe('library')
    expect(libraryScopeFromValue('book')).toBe('book')
  })
})

describe('libraryBrowseStatusFromValue', () => {
  it('defaults to Ready for missing or unknown values', () => {
    expect(libraryBrowseStatusFromValue(null)).toBe('ready')
    expect(libraryBrowseStatusFromValue('')).toBe('ready')
    expect(libraryBrowseStatusFromValue('ready')).toBe('ready')
    expect(libraryBrowseStatusFromValue('processing')).toBe('processing')
    expect(libraryBrowseStatusFromValue('error')).toBe('error')
    expect(libraryBrowseStatusFromValue('all')).toBe('all')
    expect(libraryBrowseStatusFromValue('failed')).toBe('ready')
  })
})

describe('matchesLibraryBrowseStatus', () => {
  it('treats engine active statuses as processing', () => {
    expect(matchesLibraryBrowseStatus('ready', 'ready')).toBe(true)
    expect(matchesLibraryBrowseStatus('error', 'ready')).toBe(false)
    expect(matchesLibraryBrowseStatus('uploading', 'processing')).toBe(true)
    expect(matchesLibraryBrowseStatus('generating', 'processing')).toBe(true)
    expect(matchesLibraryBrowseStatus('ready', 'processing')).toBe(false)
    expect(matchesLibraryBrowseStatus('error', 'error')).toBe(true)
    expect(matchesLibraryBrowseStatus('ready', 'all')).toBe(true)
    expect(matchesLibraryBrowseStatus('error', 'all')).toBe(true)
  })
})

describe('mergeBookGridAssets', () => {
  it('orders the live page and the browsed pages newest first', () => {
    const rows = mergeBookGridAssets(
      [asset('c', '2026-09-03T00:00:00.000Z'), asset('a', '2026-09-01T00:00:00.000Z')],
      [asset('b', '2026-09-02T00:00:00.000Z'), asset('z', '2026-08-01T00:00:00.000Z')],
    )
    expect(rows.map((row) => row.artifactId)).toEqual(['c', 'b', 'a', 'z'])
  })

  it('prefers the live row, which carries the current status', () => {
    const rows = mergeBookGridAssets(
      [asset('a', '2026-09-01T00:00:00.000Z', 'processing')],
      [asset('a', '2026-09-01T00:00:00.000Z', 'ready')],
    )
    expect(rows).toEqual([asset('a', '2026-09-01T00:00:00.000Z', 'processing')])
  })

  it('breaks timestamp ties on artifact id', () => {
    const stamp = '2026-09-01T00:00:00.000Z'
    const rows = mergeBookGridAssets([asset('b', stamp), asset('a', stamp)], [])
    expect(rows.map((row) => row.artifactId)).toEqual(['b', 'a'])
  })
})

describe('overlayLiveLibraryAssets', () => {
  it('drops live rows that no longer match the selected status', () => {
    const rows = overlayLiveLibraryAssets({
      rows: [{ ...asset('a', '2026-09-01T00:00:00.000Z', 'error'), ...activeBook }],
      live: [asset('a', '2026-09-01T00:00:00.000Z', 'ready')],
      status: 'error',
      activeBook,
    })
    expect(rows).toEqual([])
  })

  it('upserts a live row that still matches, without duplicating it', () => {
    const rows = overlayLiveLibraryAssets({
      rows: [{ ...asset('a', '2026-09-01T00:00:00.000Z', 'error'), ...activeBook }],
      live: [asset('a', '2026-09-01T00:00:00.000Z', 'error')],
      status: 'error',
      activeBook,
    })
    expect(rows).toEqual([{ ...asset('a', '2026-09-01T00:00:00.000Z', 'error'), ...activeBook }])
  })
})

describe('libraryGridAssets', () => {
  it('stamps the active book on every row in book scope', () => {
    const rows = libraryGridAssets({
      scope: 'book',
      status: 'all',
      activeBook,
      bookAssets: [asset('a', '2026-09-02T00:00:00.000Z')],
      browsedBookAssets: [asset('b', '2026-09-01T00:00:00.000Z')],
      libraryAssets: [foreign('z', '2026-09-03T00:00:00.000Z', 'book-other', 'dancing')],
    })
    expect(rows).toEqual([
      { ...asset('a', '2026-09-02T00:00:00.000Z'), ...activeBook },
      { ...asset('b', '2026-09-01T00:00:00.000Z'), ...activeBook },
    ])
  })

  it('does not prepend active-book non-ready rows onto a Ready library page', () => {
    const rows = libraryGridAssets({
      scope: 'library',
      status: 'ready',
      activeBook,
      bookAssets: [
        asset('a', '2026-09-03T00:00:00.000Z'),
        asset('b', '2026-09-02T00:00:00.000Z', 'processing'),
        asset('c', '2026-09-01T00:00:00.000Z', 'error'),
      ],
      browsedBookAssets: [],
      libraryAssets: [
        foreign('z', '2026-09-04T00:00:00.000Z', 'book-other', 'dancing'),
        { ...asset('a', '2026-09-03T00:00:00.000Z'), ...activeBook },
      ],
    })
    expect(rows.map((row) => row.artifactId)).toEqual(['z', 'a'])
    expect(rows.every((row) => row.status === 'ready')).toBe(true)
  })

  it('never repeats an artifact that the library page already returned', () => {
    const rows = libraryGridAssets({
      scope: 'library',
      status: 'ready',
      activeBook,
      bookAssets: [asset('a', '2026-09-01T00:00:00.000Z')],
      browsedBookAssets: [],
      libraryAssets: [{ ...asset('a', '2026-09-01T00:00:00.000Z'), ...activeBook }],
    })
    expect(rows).toEqual([{ ...asset('a', '2026-09-01T00:00:00.000Z'), ...activeBook }])
  })

  it('keeps same-id artifacts from different books apart', () => {
    const rows = libraryGridAssets<TestAsset>({
      scope: 'library',
      status: 'ready',
      activeBook,
      bookAssets: [],
      browsedBookAssets: [],
      libraryAssets: [
        foreign('shared', '2026-09-01T00:00:00.000Z', 'book-one', 'one'),
        foreign('shared', '2026-09-01T00:00:00.000Z', 'book-two', 'two'),
      ],
    })
    expect(rows).toHaveLength(2)
  })
})

describe('libraryGridHeading', () => {
  it('counts one book in book scope', () => {
    expect(libraryGridHeading({
      scope: 'book', shown: 4, total: 4, bookCount: 11, more: false, status: 'all',
    })).toBe('4 local items')
    expect(libraryGridHeading({
      scope: 'book', shown: 1, total: 1, bookCount: 11, more: false, status: 'ready',
    })).toBe('1 local ready item')
  })

  it('says so while a book page is truncated', () => {
    expect(libraryGridHeading({
      scope: 'book', shown: 202, total: 539, bookCount: 11, more: true, status: 'ready',
    })).toBe('202 of 539 ready items')
  })

  it('drops the remainder once the last page lands', () => {
    expect(libraryGridHeading({
      scope: 'book', shown: 538, total: 539, bookCount: 11, more: false, status: 'all',
    })).toBe('538 local items')
  })

  it('reports the loaded page against the filtered library total', () => {
    expect(libraryGridHeading({
      scope: 'library', shown: 100, total: 320, bookCount: 8, more: true, status: 'ready',
    })).toBe('100 of 320 ready items · 8 books')
    expect(libraryGridHeading({
      scope: 'library', shown: 807, total: 807, bookCount: 11, more: false, status: 'all',
    })).toBe('807 items · 11 books')
    expect(libraryGridHeading({
      scope: 'library', shown: 1, total: 1, bookCount: 1, more: false, status: 'error',
    })).toBe('1 error · 1 book')
  })

  it('avoids an unverified total when some books failed to load', () => {
    expect(libraryGridHeading({
      scope: 'library',
      shown: 100,
      total: 320,
      bookCount: 8,
      more: true,
      status: 'ready',
      booksFailed: 1,
    })).toBe('100 loaded ready items · 8 books')
  })
})
