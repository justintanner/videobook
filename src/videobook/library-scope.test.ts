import { describe, expect, it } from 'vitest'
import { libraryGridHeading, libraryScopeFromValue } from './library-scope'

describe('libraryScopeFromValue', () => {
  it('keeps the library-wide default until a book scope is stored', () => {
    expect(libraryScopeFromValue(null)).toBe('library')
    expect(libraryScopeFromValue('')).toBe('library')
    expect(libraryScopeFromValue('library')).toBe('library')
    expect(libraryScopeFromValue('nonsense')).toBe('library')
    expect(libraryScopeFromValue('book')).toBe('book')
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
