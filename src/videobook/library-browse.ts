export type LibraryBrowsePage = {
  offset: number
  limit: number
  total: number
  hasMore: boolean
}

export type LibraryStatusCounts = {
  ready: number
  processing: number
  error: number
}

export type LibraryBrowseResult<Asset> = {
  assets: Asset[]
  receivedCount: number
  page: LibraryBrowsePage
  statusCounts: LibraryStatusCounts
  booksWithErrors: Array<{ bookId: string; message: string }>
}
