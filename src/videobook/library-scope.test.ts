import { describe, expect, it } from 'vitest'
import {
  libraryGridAssets,
  libraryGridHeading,
  libraryScopeFromValue,
  type OwningBook,
} from './library-scope'

type TestAsset = {
  artifactId: string
  status: string
}

const activeBook: OwningBook = {
  owningBookId: 'book-active',
  owningBookName: 'catdance',
}

function asset(artifactId: string, status = 'ready'): TestAsset {
  return { artifactId, status }
}

function foreign(artifactId: string, bookId: string, bookName: string) {
  return {
    ...asset(artifactId),
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

describe('libraryGridAssets', () => {
  it('stamps the active book on every row in book scope', () => {
    const rows = libraryGridAssets({
      scope: 'book',
      activeBook,
      bookAssets: [asset('a'), asset('b', 'processing')],
      libraryAssets: [foreign('z', 'book-other', 'dancing')],
    })
    expect(rows).toEqual([
      { artifactId: 'a', status: 'ready', ...activeBook },
      { artifactId: 'b', status: 'processing', ...activeBook },
    ])
  })

  it('lists every book in library scope, keeping in-flight local imports first', () => {
    const rows = libraryGridAssets({
      scope: 'library',
      activeBook,
      bookAssets: [asset('a'), asset('b', 'processing'), asset('c', 'error')],
      libraryAssets: [
        foreign('z', 'book-other', 'dancing'),
        { ...asset('a'), ...activeBook },
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
      bookAssets: [asset('a', 'processing')],
      libraryAssets: [{ ...asset('a'), ...activeBook }],
    })
    expect(rows).toEqual([{ artifactId: 'a', status: 'ready', ...activeBook }])
  })

  it('keeps same-id artifacts from different books apart', () => {
    const rows = libraryGridAssets<TestAsset>({
      scope: 'library',
      activeBook,
      bookAssets: [],
      libraryAssets: [
        foreign('shared', 'book-one', 'one'),
        foreign('shared', 'book-two', 'two'),
      ],
    })
    expect(rows).toHaveLength(2)
  })
})

describe('libraryGridHeading', () => {
  it('counts one book in book scope', () => {
    expect(libraryGridHeading({ scope: 'book', shown: 4, total: 4, bookCount: 11 }))
      .toBe('4 local artifacts')
    expect(libraryGridHeading({ scope: 'book', shown: 1, total: 1, bookCount: 11 }))
      .toBe('1 local artifact')
  })

  it('says so when the book page is truncated', () => {
    expect(libraryGridHeading({ scope: 'book', shown: 202, total: 538, bookCount: 11 }))
      .toBe('202 of 538 local artifacts')
  })

  it('reports the loaded page against the library total', () => {
    expect(libraryGridHeading({ scope: 'library', shown: 100, total: 807, bookCount: 11 }))
      .toBe('100 of 807 artifacts across 11 books')
    expect(libraryGridHeading({ scope: 'library', shown: 807, total: 807, bookCount: 11 }))
      .toBe('807 artifacts across 11 books')
    expect(libraryGridHeading({ scope: 'library', shown: 1, total: 1, bookCount: 1 }))
      .toBe('1 artifact across 1 book')
  })
})
