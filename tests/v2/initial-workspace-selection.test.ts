import { describe, expect, it } from 'vitest'
import { selectPreferredBook } from '../../src/videobook/initial-workspace'

const books = [
  { bookId: 'newest', name: 'Newest' },
  { bookId: 'remembered', name: 'Remembered' },
]

describe('selectPreferredBook', () => {
  it('selects a remembered book when it remains available', () => {
    expect(selectPreferredBook(books, 'remembered')).toEqual(books[1])
  })

  it('falls back to the first already-sorted book for a missing preference', () => {
    expect(selectPreferredBook(books, 'missing')).toEqual(books[0])
  })

  it('falls back to the first book when no preference is recorded', () => {
    expect(selectPreferredBook(books, '')).toEqual(books[0])
  })

  it('returns null for an empty catalog', () => {
    expect(selectPreferredBook([], 'remembered')).toBeNull()
  })
})
