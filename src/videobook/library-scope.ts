/**
 * Scope of the Library screen: one book, or every book in the library.
 *
 * The same control drives moment search and the SOURCE ARTIFACTS grid, so the
 * grid can never claim "All books" while listing a single book's artifacts.
 */
export type LibraryScope = 'book' | 'library'

export const LIBRARY_SCOPE_STORAGE_KEY = 'videobook.library-scope'

/** Search spans the whole library by default; only an explicit choice narrows it. */
export function libraryScopeFromValue(value: string | null | undefined): LibraryScope {
  return value === 'book' ? 'book' : 'library'
}

export type OwningBook = {
  owningBookId: string
  owningBookName: string
}

type ScopedAsset = {
  artifactId: string
  status: string
}

function assetsOwnedBy<Asset extends ScopedAsset>(
  assets: readonly Asset[],
  book: OwningBook,
): Array<Asset & OwningBook> {
  return assets.map((asset) => ({ ...asset, ...book }))
}

/**
 * Rows for the Library grid.
 *
 * Library scope is served by `search_library_assets`, which only returns ready
 * media. The active book's in-flight and failed imports are prepended so an
 * import stays visible (with its retry affordance) while the scope is wide.
 */
export function libraryGridAssets<Asset extends ScopedAsset>(input: {
  scope: LibraryScope
  activeBook: OwningBook
  bookAssets: readonly Asset[]
  libraryAssets: ReadonlyArray<Asset & OwningBook>
}): Array<Asset & OwningBook> {
  if (input.scope === 'book') {
    return assetsOwnedBy(input.bookAssets, input.activeBook)
  }
  const pending = assetsOwnedBy(
    input.bookAssets.filter((asset) => asset.status !== 'ready'),
    input.activeBook,
  )
  const rows = new Map(
    [...pending, ...input.libraryAssets].map((asset) => [
      `${asset.owningBookId}:${asset.artifactId}`,
      asset,
    ]),
  )
  return [...rows.values()]
}

/** Heading under SOURCE ARTIFACTS: how much of the scope is on screen. */
export function libraryGridHeading(input: {
  scope: LibraryScope
  shown: number
  total: number
  bookCount: number
}): string {
  if (input.scope === 'book') {
    const label = `local artifact${input.total === 1 ? '' : 's'}`
    return input.shown < input.total
      ? `${input.shown} of ${input.total} ${label}`
      : `${input.shown} ${label}`
  }
  const books = `${input.bookCount} book${input.bookCount === 1 ? '' : 's'}`
  return input.shown < input.total
    ? `${input.shown} of ${input.total} artifacts across ${books}`
    : `${input.total} artifact${input.total === 1 ? '' : 's'} across ${books}`
}
