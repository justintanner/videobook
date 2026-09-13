/**
 * Scope of the Library screen: one book, or every book in the library.
 *
 * The same control drives moment search and the Media grid, so the
 * grid can never claim "All books" while listing a single book's artifacts.
 */
export type LibraryScope = 'book' | 'library'

export type LibraryBrowseStatus = 'ready' | 'processing' | 'error' | 'all'

export const LIBRARY_BROWSE_STATUSES: readonly LibraryBrowseStatus[] = [
  'ready',
  'processing',
  'error',
  'all',
]

export const LIBRARY_SCOPE_STORAGE_KEY = 'videobook.library-scope'

/** Search spans the whole library by default; only an explicit choice narrows it. */
export function libraryScopeFromValue(value: string | null | undefined): LibraryScope {
  return value === 'book' ? 'book' : 'library'
}

export type OwningBook = {
  owningBookId: string
  owningBookName: string
}

/**
 * Heading under Media: how much of the selected status and scope is on screen.
 *
 * `more` comes from the server's page envelope rather than a count comparison.
 * When some books failed to load, the heading reports loaded rows without an
 * unverified exact total.
 */
export function libraryGridHeading(input: {
  scope: LibraryScope
  shown: number
  total: number
  bookCount: number
  more: boolean
  status: LibraryBrowseStatus
  booksFailed?: number
}): string {
  const count = input.more ? input.total : input.shown
  const noun = libraryStatusHeadingNoun(input.status, count)
  if ((input.booksFailed ?? 0) > 0) {
    if (input.scope === 'book') return `${input.shown} loaded ${noun}`
    return `${input.shown} loaded ${noun} · ${bookCountLabel(input.bookCount)}`
  }
  if (input.scope === 'book') {
    return input.more
      ? `${input.shown} of ${input.total} ${noun}`
      : `${input.shown} local ${noun}`
  }
  const books = bookCountLabel(input.bookCount)
  return input.more
    ? `${input.shown} of ${input.total} ${noun} · ${books}`
    : `${input.shown} ${noun} · ${books}`
}

function libraryStatusHeadingNoun(
  status: LibraryBrowseStatus,
  count: number,
): string {
  if (status === 'error') return count === 1 ? 'error' : 'errors'
  if (status === 'processing') {
    return count === 1 ? 'processing item' : 'processing items'
  }
  if (status === 'ready') return count === 1 ? 'ready item' : 'ready items'
  return count === 1 ? 'item' : 'items'
}

function bookCountLabel(bookCount: number): string {
  return `${bookCount} book${bookCount === 1 ? '' : 's'}`
}
