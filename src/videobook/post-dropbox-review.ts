import type { NotebookCell } from 'videobook-engine'
import type { PostView } from '../../server/src/posts/post-contract'
import type { ConfirmValidation } from './confirm-validation'

export type DropboxConnection = {
  connected: boolean
  pending: boolean
  hasCredentials: boolean
  error: string | null
}

export type PostDropboxReview = {
  bookId: string
  notebookId: string
  postId: string
  caption: string
  folder: string
  connection: DropboxConnection | null
  connecting: boolean
}

type DropboxCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>

const BLOCKING_STATUSES: ReadonlySet<PostView['runtime']['status']> = new Set(['posting', 'needs_reconciliation', 'scheduled'])
export const POST_CAPTION_LIMIT = 25_000

function matchesPost(post: PostView, cells: readonly NotebookCell[], reference: string): boolean {
  const normalized = reference.replace(/^@/u, '').toLowerCase()
  if (post.id.toLowerCase() === normalized) return true
  if (post.address.replace(/^@/u, '').toLowerCase() === normalized) return true
  const cell = cells.find(item => item.id === post.id)
  const artifacts = [cell?.outputArtifactId, post.definition.source?.snapshotArtifactId, post.runtime.outbound?.artifactId]
  return artifacts.some(id => id?.toLowerCase() === normalized)
}

export function resolveDropboxPost(
  posts: readonly PostView[],
  cells: readonly NotebookCell[],
  reference: string | undefined,
  selectedCellId: string | null,
): PostView | null {
  const trimmed = reference?.trim()
  if (trimmed) return posts.find(post => matchesPost(post, cells, trimmed)) ?? null
  return posts.find(post => post.id === selectedCellId) ?? null
}

function folderSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'book'
}

export function defaultDropboxFolder(post: PostView, bookName: string): string {
  if (post.runtime.dropbox?.folder) return post.runtime.dropbox.folder
  const address = post.address.replace(/^@/u, '')
  return `/Videobook/${folderSegment(bookName)}/post-${address}-${post.id.slice(-6)}`
}

export function dropboxCaptionLocked(post: PostView): boolean {
  return Boolean(post.runtime.outbound)
}

export function dropboxFolderError(folder: string): string | null {
  const trimmed = folder.trim()
  if (!trimmed) return 'Choose a Dropbox folder.'
  if (!trimmed.startsWith('/')) return 'Start the Dropbox folder with /, like /Videobook/clips.'
  if (trimmed.split('/').includes('..') || [...trimmed].some(character => character.charCodeAt(0) < 32)) {
    return 'Use a Dropbox folder without .. segments or control characters.'
  }
  return null
}

function connectionError(connection: DropboxConnection | null, connecting: boolean): string | null {
  if (connecting) return 'Finish connecting Dropbox in the other tab.'
  if (!connection) return 'Checking the Dropbox connection…'
  if (connection.connected) return null
  if (!connection.hasCredentials) return 'Dropbox delivery is not configured. Set DROPBOX_CLIENT_ID on the server.'
  return 'Connect Dropbox to upload.'
}

export function postDropboxValidation(post: PostView | null, review: PostDropboxReview): ConfirmValidation {
  const blocking = !post
    ? 'This Post is no longer on the canvas.'
    : !post.definition.source?.snapshotArtifactId
      ? `${post.address} has no saved source clip. Choose one in the Post panel.`
      : BLOCKING_STATUSES.has(post.runtime.status)
        ? `Resolve or cancel ${post.address}'s current publication first.`
        : review.caption.length > POST_CAPTION_LIMIT
          ? `Shorten the caption to ${POST_CAPTION_LIMIT.toLocaleString()} characters.`
          : dropboxFolderError(review.folder) ?? connectionError(review.connection, review.connecting)
  const notice = post?.runtime.dropbox && !post.runtime.dropbox.completedAt && post.runtime.dropbox.folder === review.folder.trim()
    ? 'A previous upload to this folder stopped early. Uploading resumes where it left off.'
    : null
  return { blocking, notice: blocking ? null : notice }
}

export function postDropboxArgs(post: PostView, review: PostDropboxReview): Record<string, unknown> {
  return {
    book_id: review.bookId,
    post_cell_id: post.id,
    folder: review.folder.trim().replace(/\/+$/u, ''),
    ...(!dropboxCaptionLocked(post) && review.caption !== post.definition.caption ? { caption: review.caption } : {}),
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export async function fetchDropboxConnection(call: DropboxCall): Promise<DropboxConnection> {
  const status = record(await call('dropbox_connect_status', {}))
  return {
    connected: status.connected === true,
    pending: status.pending === true,
    hasCredentials: status.has_credentials !== false,
    error: typeof status.error === 'string' && status.error ? status.error : null,
  }
}

export async function startDropboxConnection(call: DropboxCall): Promise<string> {
  const result = record(await call('dropbox_connect_start', {}))
  if (typeof result.authorize_url !== 'string') throw new Error('Dropbox did not return an authorization link.')
  return result.authorize_url
}

export function postDropboxReceipt(post: PostView): string {
  const folder = post.runtime.dropbox?.folder
  return folder ? `Uploaded ${post.address} to Dropbox · ${folder}` : `Uploaded ${post.address} to Dropbox`
}

export async function waitForDropboxConnection(
  call: DropboxCall,
  sleep: (ms: number) => Promise<void>,
  isCurrent: () => boolean,
): Promise<DropboxConnection> {
  let status = await fetchDropboxConnection(call)
  for (let attempt = 0; attempt < 90 && status.pending && !status.connected && isCurrent(); attempt += 1) {
    await sleep(2000)
    status = await fetchDropboxConnection(call)
  }
  return status
}
