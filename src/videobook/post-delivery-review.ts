import type { NotebookCell } from 'videobook-engine'
import { notebookGridAddress } from 'videobook-engine/notebook-grid'
import type { PostView } from '../../server/src/posts/post-contract'
import { defaultPostFolderName, icloudFolderError } from '../../server/src/posts/post-folder'
import type { ConfirmValidation } from './confirm-validation'
import { copyCaption, copyLimitNotice, type PostCopyState } from './post-copy-review'
import { PLATFORM_NAMES } from '../../server/src/posts/post-copy-format'

export type DeliveryDestination = 'icloud' | 'dropbox'

export type DropboxConnection = {
  connected: boolean
  pending: boolean
  hasCredentials: boolean
  error: string | null
}

export type ICloudStatus = {
  available: boolean
  root: string
  shared: boolean | null
  role: 'owner' | 'participant' | null
  reason: string | null
}

export type ICloudSyncPhase = 'uploaded' | 'uploading' | 'error' | 'not-icloud'

export type ICloudSyncView = {
  phase: ICloudSyncPhase
  error: string | null
}

export type PostDeliveryReview = {
  bookId: string
  notebookId: string
  postId: string
  entry: DeliveryDestination
  destination: DeliveryDestination
  pinnedDestination: boolean
  copy: PostCopyState
  icloudFolder: string
  dropboxFolder: string
  connection: DropboxConnection | null
  connecting: boolean
  icloud: ICloudStatus | null
  receipt: string | null
  sync: ICloudSyncView | null
}

type DeliveryCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>

const BLOCKING_STATUSES: ReadonlySet<PostView['runtime']['status']> = new Set(['posting', 'needs_reconciliation', 'scheduled'])
export const POST_CAPTION_LIMIT = 25_000
const ICLOUD_UNAVAILABLE = "iCloud Drive isn't available on this Mac."

function matchesPost(post: PostView, cells: readonly NotebookCell[], reference: string): boolean {
  const normalized = reference.replace(/^@/u, '').toLowerCase()
  if (post.id.toLowerCase() === normalized) return true
  if (post.address.replace(/^@/u, '').toLowerCase() === normalized) return true
  const cell = cells.find(item => item.id === post.id)
  const artifacts = [cell?.outputArtifactId, post.definition.source?.snapshotArtifactId, post.runtime.outbound?.artifactId]
  return artifacts.some(id => id?.toLowerCase() === normalized)
}

export function resolveDeliveryPost(
  posts: readonly PostView[],
  cells: readonly NotebookCell[],
  reference: string | undefined,
  selectedCellId: string | null,
): PostView | null {
  const trimmed = reference?.trim()
  if (trimmed) return posts.find(post => matchesPost(post, cells, trimmed)) ?? null
  return posts.find(post => post.id === selectedCellId) ?? null
}

const DELIVERABLE_SOURCE_TYPES: ReadonlySet<string> = new Set(['image', 'video', 'generate_image', 'generate_video', 'concat', 'splice', 'split_video'])

export function resolveDeliverySource(cells: readonly NotebookCell[], reference: string): NotebookCell | null {
  const normalized = reference.trim().replace(/^@/u, '').toLowerCase()
  return cells.find(cell => cell.type !== 'post'
    && Boolean(cell.outputArtifactId)
    && DELIVERABLE_SOURCE_TYPES.has(cell.type)
    && [cell.id, cell.outputArtifactId, notebookGridAddress(cell.slot)].some(id => id?.toLowerCase() === normalized)) ?? null
}

export function latestPostForSource(posts: readonly PostView[], sourceCellId: string): PostView | null {
  return posts
    .filter(post => post.definition.source?.cellId === sourceCellId)
    .reduce<PostView | null>((latest, post) => !latest || post.definition.createdAt > latest.definition.createdAt ? post : latest, null)
}

export function defaultIcloudFolder(post: PostView, bookName: string): string {
  return post.runtime.icloud?.folder ?? defaultPostFolderName(bookName, post.address, post.id)
}

export function defaultDropboxFolder(post: PostView, bookName: string): string {
  if (post.runtime.dropbox?.folder) return post.runtime.dropbox.folder
  return `/Videobook/${defaultPostFolderName(bookName, post.address, post.id)}`
}

export function deliveryDestinationForEntry(entry: DeliveryDestination, status: ICloudStatus | null): DeliveryDestination {
  if (entry === 'dropbox') return 'dropbox'
  if (status && !status.available) return 'dropbox'
  return 'icloud'
}

export function reviewWithIcloudStatus(review: PostDeliveryReview, status: ICloudStatus): PostDeliveryReview {
  return {
    ...review,
    icloud: status,
    destination: review.pinnedDestination ? review.destination : deliveryDestinationForEntry(review.entry, status),
  }
}

export function deliveryCaptionLocked(post: PostView): boolean {
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

function postBlocking(post: PostView | null, caption: string): string | null {
  if (!post) return 'This Post is no longer on the canvas.'
  if (!post.definition.source?.snapshotArtifactId) return `${post.address} has no saved source clip. Choose one in the Post panel.`
  if (BLOCKING_STATUSES.has(post.runtime.status)) return `Resolve or cancel ${post.address}'s current publication first.`
  if (caption.length > POST_CAPTION_LIMIT) return `Shorten the caption to ${POST_CAPTION_LIMIT.toLocaleString()} characters.`
  return null
}

export function icloudShareHint(status: ICloudStatus | null): string | null {
  if (!status?.available) return null
  if (status.shared === true) return 'Shared with your iPhones'
  if (status.shared === false) return 'Share iCloud Drive › Videobook with your phones first'
  return null
}

function copyBlocking(post: PostView | null, review: PostDeliveryReview): string | null {
  if (!post || deliveryCaptionLocked(post)) return null
  if (review.copy.drafting) return 'Astra is writing the caption…'
  return null
}

function copyNotice(post: PostView | null, review: PostDeliveryReview): string | null {
  return post && !deliveryCaptionLocked(post) ? copyLimitNotice(review.copy) : null
}

export function postDeliveryValidation(post: PostView | null, review: PostDeliveryReview): ConfirmValidation {
  const common = postBlocking(post, copyCaption(review.copy)) ?? copyBlocking(post, review)
  if (review.destination === 'dropbox') {
    const blocking = common ?? dropboxFolderError(review.dropboxFolder) ?? connectionError(review.connection, review.connecting)
    const notice = post?.runtime.dropbox && !post.runtime.dropbox.completedAt && post.runtime.dropbox.folder === review.dropboxFolder.trim()
      ? 'A previous upload to this folder stopped early. Uploading resumes where it left off.'
      : copyNotice(post, review)
    return { blocking, notice: blocking ? null : notice }
  }
  const availability = !review.icloud
    ? 'Checking iCloud Drive…'
    : review.icloud.available ? null : (review.icloud.reason ?? ICLOUD_UNAVAILABLE)
  const blocking = common ?? availability ?? icloudFolderError(review.icloudFolder)
  return { blocking, notice: blocking ? null : copyNotice(post, review) }
}

export function postDeliveryArgs(post: PostView, review: PostDeliveryReview): Record<string, unknown> {
  const folder = (review.destination === 'icloud' ? review.icloudFolder : review.dropboxFolder).trim().replace(/\/+$/u, '')
  return {
    book_id: review.bookId,
    post_cell_id: post.id,
    folder,
    ...(!deliveryCaptionLocked(post) && copyCaption(review.copy) !== post.definition.caption ? { caption: copyCaption(review.copy) } : {}),
  }
}

export function postPlatformArgs(post: PostView, review: PostDeliveryReview): Record<string, unknown> | null {
  if (deliveryCaptionLocked(post) || review.copy.platform === post.definition.platform) return null
  return { book_id: review.bookId, post_cell_id: post.id, platform: review.copy.platform }
}

export function postReviewDraftArgs(post: PostView, review: PostDeliveryReview): Record<string, unknown> | null {
  if (deliveryCaptionLocked(post)) return null
  const caption = copyCaption(review.copy)
  const patch = {
    ...(review.copy.platform !== post.definition.platform ? { platform: review.copy.platform } : {}),
    ...(caption !== post.definition.caption ? { caption } : {}),
  }
  return Object.keys(patch).length > 0 ? { book_id: review.bookId, post_cell_id: post.id, ...patch } : null
}

export function postDeliveryTool(destination: DeliveryDestination): 'save_post_to_icloud' | 'upload_post_to_dropbox' {
  return destination === 'icloud' ? 'save_post_to_icloud' : 'upload_post_to_dropbox'
}

export function postDeliveryBadges(post: PostView): Array<'iPhone' | 'Dropbox'> {
  const badges: Array<'iPhone' | 'Dropbox'> = []
  if (post.runtime.icloud?.completedAt) badges.push('iPhone')
  if (post.runtime.dropbox?.completedAt) badges.push('Dropbox')
  return badges
}

export function postAwaitingLink(post: PostView): boolean {
  return !post.runtime.url && postDeliveryBadges(post).length > 0
}

export function postLinkPrompt(post: PostView): string {
  const platform = post.definition.platform
  return platform === 'other' ? 'Posted it? Paste the link' : `Posted on ${PLATFORM_NAMES[platform]}? Paste the link`
}

export type PostTileMetric = { label: 'views' | 'impressions' | 'likes'; value: string }

export function postPlatformName(post: PostView): string {
  return PLATFORM_NAMES[post.definition.platform]
}

export function postTileStatus(post: PostView): string {
  return postAwaitingLink(post) ? 'needs_link' : post.runtime.status
}

export function postTileNextStep(post: PostView): string | null {
  if (post.runtime.postedAt || post.runtime.url) return null
  if (postAwaitingLink(post)) return post.definition.platform === 'other' ? 'Paste the published link' : `Paste ${postPlatformName(post)} link`
  return post.definition.platform === 'other' ? 'Save to iPhone or paste link' : `Save to iPhone or paste ${postPlatformName(post)} link`
}

export function postTilePostedOn(post: PostView): string | null {
  if (!post.runtime.postedAt) return null
  return new Date(post.runtime.postedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function postTileMetrics(post: PostView): PostTileMetric[] {
  const values = post.runtime.metrics.at(-1)?.values
  if (!values) return []
  const reach: PostTileMetric['label'] = values.views != null ? 'views' : 'impressions'
  return ([reach, 'likes'] as const)
    .filter(label => values[label] != null)
    .map(label => ({ label, value: compactCount(values[label]!) }))
}

function compactCount(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

export function icloudPhoneReceipt(folder: string): string {
  return `On iPhone · iCloud Drive › Videobook › ${folder}`
}

export function postDeliveryReceipt(post: PostView, destination: DeliveryDestination): string {
  if (destination === 'icloud') {
    const folder = post.runtime.icloud?.folder
    return folder ? `Saved ${post.address} to iCloud · Videobook/${folder}` : `Saved ${post.address} to iCloud`
  }
  const folder = post.runtime.dropbox?.folder
  return folder ? `Uploaded ${post.address} to Dropbox · ${folder}` : `Uploaded ${post.address} to Dropbox`
}

export function icloudProgressLabel(phase: ICloudSyncPhase | null, error?: string | null): string | null {
  if (phase === 'uploading') return 'Uploading to iCloud…'
  if (phase === 'uploaded') return 'On iCloud'
  if (phase === 'error') return error?.trim() || 'iCloud upload failed'
  return null
}

export function icloudSyncShouldPoll(phase: ICloudSyncPhase | null): boolean {
  return phase === null || phase === 'uploading'
}

export function icloudSyncFromTool(value: unknown): ICloudSyncView {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const phase = record.phase
  const known = phase === 'uploaded' || phase === 'uploading' || phase === 'error' || phase === 'not-icloud'
  return { phase: known ? phase : 'not-icloud', error: typeof record.error === 'string' && record.error ? record.error : null }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export async function fetchDropboxConnection(call: DeliveryCall): Promise<DropboxConnection> {
  const status = record(await call('service_status', { service: 'dropbox' }))
  return {
    connected: status.connected === true,
    pending: status.pending === true,
    hasCredentials: status.has_credentials !== false,
    error: typeof status.error === 'string' && status.error ? status.error : null,
  }
}

export async function fetchIcloudStatus(call: DeliveryCall): Promise<ICloudStatus> {
  const status = record(await call('service_status', { service: 'icloud' }))
  const role = status.role === 'owner' || status.role === 'participant' ? status.role : null
  return {
    available: status.available === true,
    root: typeof status.root === 'string' ? status.root : '',
    shared: typeof status.shared === 'boolean' ? status.shared : null,
    role,
    reason: typeof status.reason === 'string' && status.reason ? status.reason : null,
  }
}

export async function startDropboxConnection(call: DeliveryCall): Promise<string> {
  const result = record(await call('connect_service', { service: 'dropbox' }))
  if (typeof result.authorize_url !== 'string') throw new Error('Dropbox did not return an authorization link.')
  return result.authorize_url
}

export async function waitForDropboxConnection(
  call: DeliveryCall,
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
