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

export function libraryBrowseStatusFromValue(
  value: string | null | undefined,
): LibraryBrowseStatus {
  return value === 'processing' || value === 'error' || value === 'all'
    ? value
    : 'ready'
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

export function matchesLibraryBrowseStatus(
  status: string,
  browseStatus: LibraryBrowseStatus,
): boolean {
  if (browseStatus === 'all') return true
  if (browseStatus === 'ready') return status === 'ready'
  if (browseStatus === 'error') return status === 'error'
  return status !== 'ready' && status !== 'error'
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
 * Overlay the active book's live rows onto a status-filtered browse page.
 * Matching live rows replace or join the page; rows that no longer match the
 * selected status drop out. Switching views never mutates stored artifacts.
 */
export function overlayLiveLibraryAssets<Asset extends ScopedAsset>(input: {
  rows: ReadonlyArray<Asset & OwningBook>
  live: readonly Asset[]
  status: LibraryBrowseStatus
  activeBook: OwningBook
}): Array<Asset & OwningBook> {
  const rows = new Map(
    input.rows.map((asset) => [
      `${asset.owningBookId}:${asset.artifactId}`,
      asset,
    ]),
  )
  for (const asset of input.live) {
    const key = `${input.activeBook.owningBookId}:${asset.artifactId}`
    if (matchesLibraryBrowseStatus(asset.status, input.status)) {
      rows.set(key, { ...asset, ...input.activeBook })
    } else {
      rows.delete(key)
    }
  }
  return [...rows.values()].sort(newestFirst)
}

/**
 * Rows for the Library grid.
 *
 * Browse pages are already status-filtered on the server. Live notebook
 * assets overlay only when they still match the selected status, so Ready
 * never prepends in-flight or failed imports.
 */
export function libraryGridAssets<Asset extends ScopedAsset>(input: {
  scope: LibraryScope
  status: LibraryBrowseStatus
  activeBook: OwningBook
  bookAssets: readonly Asset[]
  browsedBookAssets: readonly Asset[]
  libraryAssets: ReadonlyArray<Asset & OwningBook>
}): Array<Asset & OwningBook> {
  const browsed = input.scope === 'book'
    ? assetsOwnedBy(
      mergeBookGridAssets([], input.browsedBookAssets),
      input.activeBook,
    )
    : [...input.libraryAssets]
  return overlayLiveLibraryAssets({
    rows: browsed,
    live: input.bookAssets,
    status: input.status,
    activeBook: input.activeBook,
  })
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
