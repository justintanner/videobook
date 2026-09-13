import type { LibraryBrowseStatus } from './library-scope'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function libraryAssetKindLabel(type: string): string {
  if (type === 'video' || type === 'final') return 'Video'
  if (type === 'image') return 'Image'
  if (type === 'audio') return 'Audio'
  if (!type) return 'Media'
  return type.charAt(0).toUpperCase() + type.slice(1)
}

export function libraryAssetShortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8)
}

export function libraryAssetTitle(asset: {
  id: string
  label: string
  type: string
}): string {
  const label = asset.label.trim()
  if (label && label !== asset.id && !UUID_RE.test(label)) return label
  return `${libraryAssetKindLabel(asset.type)} · ${libraryAssetShortId(asset.id)}`
}

export function formatLibraryAssetDate(
  iso: string,
  locales?: Intl.LocalesArgument,
): string {
  const date = Date.parse(iso)
  if (!Number.isFinite(date)) return ''
  return new Intl.DateTimeFormat(locales, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

export function formatLibraryAssetDateTime(
  iso: string,
  locales?: Intl.LocalesArgument,
): string {
  const date = Date.parse(iso)
  if (!Number.isFinite(date)) return ''
  return new Intl.DateTimeFormat(locales, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

export function libraryStatusNoun(
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

export function libraryEmptyCopy(status: LibraryBrowseStatus): {
  title: string
  body: string
} {
  if (status === 'ready') {
    return {
      title: 'No ready media',
      body: 'Import files or generate from the notebook. Processing and errors stay behind the Status control.',
    }
  }
  if (status === 'processing') {
    return {
      title: 'Nothing is processing',
      body: 'In-flight imports and jobs will appear here.',
    }
  }
  if (status === 'error') {
    return {
      title: 'No errors',
      body: 'Failed imports stay here so you can retry them. Ready media is in the Ready view.',
    }
  }
  return {
    title: 'No media yet',
    body: 'Upload media or generate an image or video from the notebook.',
  }
}

export function libraryLoadingCopy(
  status: LibraryBrowseStatus,
  scope: 'book' | 'library',
  loadingMore: boolean,
): string {
  if (loadingMore) return 'Loading more…'
  const noun = libraryStatusNoun(status, 2)
  return scope === 'library'
    ? `Loading ${noun} across books…`
    : `Loading ${noun}…`
}

export function libraryStatusLabel(status: LibraryBrowseStatus): string {
  if (status === 'error') return 'Errors'
  if (status === 'processing') return 'Processing'
  if (status === 'ready') return 'Ready'
  return 'All'
}

export function libraryCardLayout(
  status: LibraryBrowseStatus,
): 'grid' | 'row' {
  return status === 'processing' || status === 'error' ? 'row' : 'grid'
}
