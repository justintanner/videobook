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
  createdAt: string
}

function assetsOwnedBy<Asset extends ScopedAsset>(
  assets: readonly Asset[],
  book: OwningBook,
): Array<Asset & OwningBook> {
  return assets.map((asset) => ({ ...asset, ...book }))
}

function newestFirst(left: ScopedAsset, right: ScopedAsset): number {
  const created = Date.parse(right.createdAt) - Date.parse(left.createdAt)
  if (created !== 0 && Number.isFinite(created)) return created
  return left.artifactId < right.artifactId ? 1 : -1
}

/**
 * Book scope reads two lists: the live one the rest of the app shares (newest
 * page, plus whatever the notebook references) and the older pages the grid
 * asked for on its own. The live row wins on overlap — it carries the current
 * status — and the result is one newest-first list.
 */
export function mergeBookGridAssets<Asset extends ScopedAsset>(
  live: readonly Asset[],
  browsed: readonly Asset[],
): Asset[] {
  const rows = new Map(
    [...browsed, ...live].map((asset) => [asset.artifactId, asset]),
  )
  return [...rows.values()].sort(newestFirst)
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
  browsedBookAssets: readonly Asset[]
  libraryAssets: ReadonlyArray<Asset & OwningBook>
}): Array<Asset & OwningBook> {
  if (input.scope === 'book') {
    return assetsOwnedBy(
      mergeBookGridAssets(input.bookAssets, input.browsedBookAssets),
      input.activeBook,
    )
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

/**
 * Heading under SOURCE ARTIFACTS: how much of the scope is on screen.
 *
 * `more` comes from the server's page envelope rather than a count comparison:
 * a book total includes artifacts the grid never lists (notebooks), so
 * `shown < total` would leave the heading claiming a remainder forever.
 */
export function libraryGridHeading(input: {
  scope: LibraryScope
  shown: number
  total: number
  bookCount: number
  more: boolean
}): string {
  if (input.scope === 'book') {
    return input.more
      ? `${input.shown} of ${input.total} local artifacts`
      : `${input.shown} local artifact${input.shown === 1 ? '' : 's'}`
  }
  const books = `${input.bookCount} book${input.bookCount === 1 ? '' : 's'}`
  return input.more
    ? `${input.shown} of ${input.total} artifacts across ${books}`
    : `${input.shown} artifact${input.shown === 1 ? '' : 's'} across ${books}`
}
