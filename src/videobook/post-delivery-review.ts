import type { NotebookCell } from 'videobook-engine'
import { notebookGridAddress } from 'videobook-engine/notebook-grid'
import type { PostView } from '../../server/src/posts/post-contract'
import { defaultPostFolderName, icloudFolderError, postDownloadLinks, type PostDownload } from '../../server/src/posts/post-folder'
import type { ConfirmValidation } from './confirm-validation'
import { captionLanguage, copyCaption, copyLimitNotice, editCopyVersion, initialCopyState, type PostCopyState } from './post-copy-review'
import { PLATFORM_NAMES } from '../../server/src/posts/post-copy-format'

export type DeliveryDestination = 'icloud' | 'download'

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
  icloud: ICloudStatus | null
  receipt: string | null
  sync: ICloudSyncView | null
  download: PostDownload | null
}

export type DeliveredPost = {
  post: PostView
  download: PostDownload | null
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

export function postDownloadFor(post: PostView, book: { bookId: string; name: string }): PostDownload | null {
  return post.runtime.outbound ? postDownloadLinks(book, post, post.runtime.outbound) : null
}

export function deliveryDestinationForEntry(entry: DeliveryDestination, status: ICloudStatus | null): DeliveryDestination {
  if (entry === 'download') return 'download'
  if (status && !status.available) return 'download'
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

export function postFrozen(post: PostView): boolean {
  return Boolean(post.runtime.outbound || post.runtime.url || post.runtime.status === 'scheduled')
}

export function copyWithCaption(post: PostView, caption: string | undefined): PostCopyState {
  const copy = initialCopyState(post)
  const text = caption?.trim()
  if (!text || deliveryCaptionLocked(post)) return copy
  return editCopyVersion({ ...copy, language: captionLanguage(text) }, { body: text })
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
  if (review.destination === 'download') return { blocking: common, notice: common ? null : copyNotice(post, review) }
  const availability = !review.icloud
    ? 'Checking iCloud Drive…'
    : review.icloud.available ? null : (review.icloud.reason ?? ICLOUD_UNAVAILABLE)
  const blocking = common ?? availability ?? icloudFolderError(review.icloudFolder)
  return { blocking, notice: blocking ? null : copyNotice(post, review) }
}

export function postReviewDraftArgs(post: PostView, review: PostDeliveryReview): Record<string, unknown> {
  if (deliveryCaptionLocked(post)) return {}
  const caption = copyCaption(review.copy)
  return {
    ...(review.copy.platform !== post.definition.platform ? { platform: review.copy.platform } : {}),
    ...(caption !== post.definition.caption ? { caption } : {}),
  }
}

export function postDeliveryArgs(post: PostView, review: PostDeliveryReview): Record<string, unknown> {
  const { caption, ...draft } = postReviewDraftArgs(post, review)
  return {
    book_id: review.bookId,
    to: review.destination,
    post_cell_id: post.id,
    ...(review.destination === 'icloud' ? { folder: review.icloudFolder.trim().replace(/\/+$/u, '') } : {}),
    ...draft,
    ...(caption === undefined ? {} : { text: caption }),
  }
}

function stringField(value: Record<string, unknown>, name: string): string | null {
  return typeof value[name] === 'string' ? value[name] : null
}

function downloadFromTool(value: unknown): PostDownload | null {
  const download = record(value)
  const clipUrl = stringField(download, 'clip_url')
  const captionUrl = stringField(download, 'caption_url')
  const filename = stringField(download, 'filename')
  if (!clipUrl || !captionUrl || !filename) return null
  return { clip_url: clipUrl, caption_url: captionUrl, filename, caption: stringField(download, 'caption') ?? '' }
}

export function deliveredPostFromTool(value: unknown): DeliveredPost {
  const result = record(value)
  return { post: result.post as PostView, download: downloadFromTool(result.download) }
}

export function postDeliveryBadges(post: PostView): Array<'iPhone' | 'Downloaded'> {
  const badges: Array<'iPhone' | 'Downloaded'> = []
  if (post.runtime.icloud?.completedAt) badges.push('iPhone')
  if (post.runtime.download?.completedAt) badges.push('Downloaded')
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
  return post.definition.platform === 'other' ? 'Save, download or paste link' : `Save, download or paste ${postPlatformName(post)} link`
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

export function postDeliveryReceipt(delivered: DeliveredPost, destination: DeliveryDestination): string {
  const { post, download } = delivered
  if (destination === 'download') return download ? `Downloaded ${post.address} as ${download.filename}` : `${post.address} is ready to download`
  const folder = post.runtime.icloud?.folder
  return folder ? `Saved ${post.address} to iCloud · Videobook/${folder}` : `Saved ${post.address} to iCloud`
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
