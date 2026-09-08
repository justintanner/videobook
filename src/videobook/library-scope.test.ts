import { describe, expect, it } from 'vitest'
import {
  libraryGridAssets,
  libraryGridHeading,
  libraryScopeFromValue,
  mergeBookGridAssets,
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

describe('libraryGridAssets', () => {
  it('stamps the active book on every row in book scope', () => {
    const rows = libraryGridAssets({
      scope: 'book',
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

  it('lists every book in library scope, keeping in-flight local imports first', () => {
    const rows = libraryGridAssets({
      scope: 'library',
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
    expect(rows.map((row) => row.artifactId)).toEqual(['b', 'c', 'z', 'a'])
    expect(rows.map((row) => row.owningBookName))
      .toEqual(['catdance', 'catdance', 'dancing', 'catdance'])
  })

  it('never repeats an artifact that the library page already returned', () => {
    const rows = libraryGridAssets({
      scope: 'library',
      activeBook,
      bookAssets: [asset('a', '2026-09-01T00:00:00.000Z', 'processing')],
      browsedBookAssets: [],
      libraryAssets: [{ ...asset('a', '2026-09-01T00:00:00.000Z'), ...activeBook }],
    })
    expect(rows).toEqual([{ ...asset('a', '2026-09-01T00:00:00.000Z'), ...activeBook }])
  })

  it('keeps same-id artifacts from different books apart', () => {
    const rows = libraryGridAssets<TestAsset>({
      scope: 'library',
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
    expect(libraryGridHeading({ scope: 'book', shown: 4, total: 4, bookCount: 11, more: false }))
      .toBe('4 local artifacts')
    expect(libraryGridHeading({ scope: 'book', shown: 1, total: 1, bookCount: 11, more: false }))
      .toBe('1 local artifact')
  })

  it('says so while a book page is truncated', () => {
    expect(libraryGridHeading({ scope: 'book', shown: 202, total: 539, bookCount: 11, more: true }))
      .toBe('202 of 539 local artifacts')
  })

  it('drops the remainder once the last page lands', () => {
    // A book total counts notebooks the grid never lists, so the envelope —
    // not shown < total — decides whether a remainder is still out there.
    expect(libraryGridHeading({ scope: 'book', shown: 538, total: 539, bookCount: 11, more: false }))
      .toBe('538 local artifacts')
  })

  it('reports the loaded page against the library total', () => {
    expect(libraryGridHeading({ scope: 'library', shown: 100, total: 807, bookCount: 11, more: true }))
      .toBe('100 of 807 artifacts across 11 books')
    expect(libraryGridHeading({ scope: 'library', shown: 807, total: 807, bookCount: 11, more: false }))
      .toBe('807 artifacts across 11 books')
    expect(libraryGridHeading({ scope: 'library', shown: 1, total: 1, bookCount: 1, more: false }))
      .toBe('1 artifact across 1 book')
  })
})
