export type ReverseSearchMode = 'image-reverse' | 'video-reverse'
type SearchReferenceKind = 'image' | 'video'

export interface SearchReferenceDescriptor {
  referenceId: string
  kind: SearchReferenceKind
  name: string
  durationMs?: number
  expiresAt: number
  previewUrl?: string
  localPreview?: boolean
}

type SearchReferenceToolCall = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>

type ExistingSearchReferenceInput = {
  sourceBookId: string
  sourceArtifactId: string
  mode: ReverseSearchMode
  previewUrl?: string | null
  sourceRange?: { startSeconds: number; durationSeconds: number }
}

export function referenceKind(mode: ReverseSearchMode): SearchReferenceKind {
  return mode === 'image-reverse' ? 'image' : 'video'
}

export async function prepareExistingSearchReference(
  call: SearchReferenceToolCall,
  {
    sourceBookId,
    sourceArtifactId,
    mode,
    previewUrl,
    sourceRange,
  }: ExistingSearchReferenceInput,
): Promise<SearchReferenceDescriptor> {
  const value = await call('prepare_search_reference', {
    source_book_id: sourceBookId,
    source_artifact_id: sourceArtifactId,
    kind: referenceKind(mode),
    ...(sourceRange
      ? {
          source_start_seconds: sourceRange.startSeconds,
          source_duration_seconds: sourceRange.durationSeconds,
        }
      : {}),
  })
  return asSearchReferenceDescriptor(value, previewUrl)
}

export function compatibleReferenceFile(
  file: File,
  kind: SearchReferenceKind,
): boolean {
  if (file.type.startsWith(`${kind}/`)) return true
  const extension = file.name.split('.').at(-1)?.toLowerCase() ?? ''
  return kind === 'image'
    ? ['jpg', 'jpeg', 'png', 'webp'].includes(extension)
    : ['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(extension)
}

export function searchReferenceRange(
  startValue: string,
  durationValue: string,
  reference: SearchReferenceDescriptor,
): { start_seconds: number; duration_seconds?: number } | undefined {
  const start = Number(startValue || '0')
  if (!Number.isFinite(start) || start < 0) {
    throw new Error('Reference start must be a non-negative number')
  }
  const duration = durationValue.trim() ? Number(durationValue) : undefined
  if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0)) {
    throw new Error('Reference duration must be a positive number')
  }
  const available = reference.durationMs === undefined
    ? undefined
    : reference.durationMs / 1_000
  if (available !== undefined && start >= available) {
    throw new Error('Reference start must fall within the video')
  }
  if (available !== undefined && duration !== undefined && start + duration > available) {
    throw new Error('Reference range extends past the end of the video')
  }
  if (start === 0 && duration === undefined) return undefined
  return {
    start_seconds: start,
    ...(duration === undefined ? {} : { duration_seconds: duration }),
  }
}

export async function uploadSearchReference(
  file: File,
  bookId: string,
  kind: SearchReferenceKind,
): Promise<SearchReferenceDescriptor> {
  if (!compatibleReferenceFile(file, kind)) {
    throw new Error(`Choose a compatible ${kind} file`)
  }
  const filename = file.name.trim()
    || `${kind}-reference.${kind === 'image' ? 'png' : 'mp4'}`
  const query = new URLSearchParams({
    filename,
    bookId,
    kind,
  })
  const response = await fetch(`/api/search-references?${query}`, {
    method: 'POST',
    headers: file.type ? { 'Content-Type': file.type } : {},
    body: file,
  })
  const value = await response.json() as unknown
  if (!response.ok) {
    throw new Error(readString(value, 'error') ?? 'Could not prepare search reference')
  }
  const descriptor = asSearchReferenceDescriptor(value)
  return {
    ...descriptor,
    previewUrl: URL.createObjectURL(file),
    localPreview: true,
  }
}

export async function releaseSearchReference(
  descriptor: SearchReferenceDescriptor | null,
): Promise<void> {
  if (!descriptor) return
  if (descriptor.localPreview && descriptor.previewUrl) {
    URL.revokeObjectURL(descriptor.previewUrl)
  }
  await fetch(
    `/api/search-references/${encodeURIComponent(descriptor.referenceId)}`,
    { method: 'DELETE' },
  ).catch(() => undefined)
}

export function asSearchReferenceDescriptor(
  value: unknown,
  previewUrl?: string | null,
): SearchReferenceDescriptor {
  const referenceId = readString(value, 'reference_id')
  const kind = readString(value, 'kind')
  const name = readString(value, 'name')
  const expiresAt = readNumber(value, 'expires_at')
  if (
    !referenceId
    || (kind !== 'image' && kind !== 'video')
    || !name
    || expiresAt === null
  ) {
    throw new Error('The server returned an invalid search reference')
  }
  const durationMs = readNumber(value, 'duration_ms')
  return {
    referenceId,
    kind,
    name,
    expiresAt,
    ...(durationMs === null ? {} : { durationMs }),
    ...(previewUrl ? { previewUrl } : {}),
  }
}

function readString(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'string' ? candidate : null
}

function readNumber(value: unknown, key: string): number | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'number' && Number.isFinite(candidate)
    ? candidate
    : null
}
