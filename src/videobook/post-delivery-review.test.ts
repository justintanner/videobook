import { describe, expect, it } from 'vitest'
import type { NotebookCell } from 'videobook-engine'
import type { PostView } from '../../server/src/posts/post-contract'
import {
  copyWithCaption,
  defaultIcloudFolder,
  deliveredPostFromTool,
  deliveryDestinationForEntry,
  icloudPhoneReceipt,
  icloudProgressLabel,
  icloudShareHint,
  postAwaitingLink,
  postDeliveryBadges,
  postLinkPrompt,
  postTileMetrics,
  postTileNextStep,
  postTilePostedOn,
  postTileStatus,
  icloudSyncFromTool,
  icloudSyncShouldPoll,
  latestPostForSource,
  postDeliveryArgs,
  postDeliveryReceipt,
  postDeliveryValidation,
  postDownloadFor,
  postFrozen,
  resolveDeliveryPost,
  resolveDeliverySource,
  reviewWithIcloudStatus,
  type ICloudStatus,
  postReviewDraftArgs,
  type PostDeliveryReview,
} from './post-delivery-review'
import { copyCaption, editCopyVersion, initialCopyState } from './post-copy-review'

const OUTBOUND = { artifactId: 'out', filename: 'clip.mp4', caption: 'Draft caption', frozenAt: '2026-10-14T10:00:00.000Z', revision: 'r2', objectHash: 'h2' }

function postView(overrides: Partial<PostView['runtime']> = {}, frozen = true): PostView {
  return {
    id: '01a13a51-c60a-77de-9db7-699805479eab',
    notebookId: 'notebook-1',
    address: '@b1',
    label: 'Post · tiktok',
    definition: {
      version: 1,
      platform: 'tiktok',
      account: '',
      caption: 'Draft caption',
      credits: '',
      notes: '',
      createdAt: '2026-10-14T09:42:00.000Z',
      source: frozen
        ? { cellId: 'source-cell', artifactId: 'source-artifact', revision: 'r1', objectHash: 'h1', filename: 'clip.mp4', snapshotArtifactId: 'snapshot-artifact' }
        : null,
      lineage: [],
    },
    runtime: { status: 'draft', metrics: [], ...overrides },
  }
}

function status(overrides: Partial<ICloudStatus> = {}): ICloudStatus {
  return { available: true, root: '/tmp/Videobook', shared: null, role: null, reason: null, ...overrides }
}

function review(overrides: Partial<PostDeliveryReview> = {}): PostDeliveryReview {
  return {
    bookId: 'book-1',
    notebookId: 'notebook-1',
    postId: postView().id,
    entry: 'icloud',
    destination: 'icloud',
    pinnedDestination: false,
    copy: initialCopyState(postView()),
    icloudFolder: 'my-book/post-b1-479eab',
    icloud: status(),
    receipt: null,
    sync: null,
    download: null,
    ...overrides,
  }
}

const cells = [{ id: postView().id, type: 'post', outputArtifactId: 'snapshot-artifact', slot: { row: 1, column: 0 } }] as unknown as NotebookCell[]

describe('post delivery review', () => {
  it('resolves a Post by address, cell id, resolved artifact id or selection, and nothing else', () => {
    const posts = [postView()]
    expect(resolveDeliveryPost(posts, cells, '@B1', null)?.id).toBe(posts[0]!.id)
    expect(resolveDeliveryPost(posts, cells, posts[0]!.id, null)?.id).toBe(posts[0]!.id)
    expect(resolveDeliveryPost(posts, cells, 'snapshot-artifact', null)?.id).toBe(posts[0]!.id)
    expect(resolveDeliveryPost(posts, cells, undefined, posts[0]!.id)?.id).toBe(posts[0]!.id)
    expect(resolveDeliveryPost(posts, cells, '@a3', posts[0]!.id)).toBeNull()
    expect(resolveDeliveryPost(posts, cells, undefined, 'other-cell')).toBeNull()
  })

  it('resolves a clip cell by address, cell id or artifact id and finds its newest Post', () => {
    const clips = [
      ...cells,
      { id: 'source-cell', type: 'video', outputArtifactId: 'source-artifact', slot: { row: 3, column: 1 } },
      { id: 'empty-cell', type: 'video', outputArtifactId: null, slot: { row: 3, column: 2 } },
    ] as unknown as NotebookCell[]
    expect(resolveDeliverySource(clips, '@D2')?.id).toBe('source-cell')
    expect(resolveDeliverySource(clips, 'source-cell')?.id).toBe('source-cell')
    expect(resolveDeliverySource(clips, 'source-artifact')?.id).toBe('source-cell')
    expect(resolveDeliverySource(clips, '@d3')).toBeNull()
    expect(resolveDeliverySource(clips, '@b1')).toBeNull()
    const older = postView()
    const newer = { ...postView(), id: 'newer-post', definition: { ...postView().definition, createdAt: '2026-10-15T09:42:00.000Z' } }
    expect(latestPostForSource([older, newer], 'source-cell')?.id).toBe('newer-post')
    expect(latestPostForSource([older, newer], 'other-cell')).toBeNull()
  })

  it('starts on iCloud unless the entry is Download or iCloud Drive is unavailable', () => {
    expect(deliveryDestinationForEntry('icloud', null)).toBe('icloud')
    expect(deliveryDestinationForEntry('icloud', status())).toBe('icloud')
    expect(deliveryDestinationForEntry('download', status())).toBe('download')
    expect(deliveryDestinationForEntry('icloud', status({ available: false, reason: 'missing' }))).toBe('download')
    const opened = review({ entry: 'icloud', destination: 'icloud', icloud: null })
    expect(reviewWithIcloudStatus(opened, status({ available: false, reason: 'iCloud Drive is not set up on this Mac.' })).destination).toBe('download')
    expect(reviewWithIcloudStatus({ ...opened, pinnedDestination: true }, status({ available: false })).destination).toBe('icloud')
  })

  it('suggests the shared folder shape and keeps a folder already used', () => {
    expect(defaultIcloudFolder(postView(), 'My Book!')).toBe('my-book/post-b1-479eab')
    const used = postView({ icloud: { folder: 'phones/skate', completedAt: '2026-10-14T10:00:00.000Z' } })
    expect(defaultIcloudFolder(used, 'My Book')).toBe('phones/skate')
  })

  it('explains each reason a delivery is unavailable and keeps the phone hint non-blocking', () => {
    expect(postDeliveryValidation(null, review()).blocking).toBe('This Post is no longer on the canvas.')
    expect(postDeliveryValidation(postView({}, false), review()).blocking).toContain('has no saved source clip')
    expect(postDeliveryValidation(postView({ status: 'scheduled' }), review()).blocking).toContain('current publication')
    expect(postDeliveryValidation(postView(), review({ icloud: null })).blocking).toBe('Checking iCloud Drive…')
    expect(postDeliveryValidation(postView(), review({ icloud: status({ available: false, reason: null }) })).blocking).toBe("iCloud Drive isn't available on this Mac.")
    expect(postDeliveryValidation(postView(), review({ icloudFolder: '' })).blocking).toBe('Choose an iCloud folder.')
    expect(postDeliveryValidation(postView(), review({ icloudFolder: '/Users/me' })).blocking).toContain('inside iCloud Drive')
    expect(postDeliveryValidation(postView(), review({ icloudFolder: 'a/../b' })).blocking).toContain('..')
    expect(postDeliveryValidation(postView(), review({ destination: 'download', icloud: status({ available: false }), icloudFolder: '' }))).toEqual({ blocking: null, notice: null })
    expect(postDeliveryValidation(postView({}, false), review({ destination: 'download' })).blocking).toContain('has no saved source clip')
    expect(postDeliveryValidation(postView(), review())).toEqual({ blocking: null, notice: null })
    expect(icloudShareHint(status({ shared: false }))).toBe('Share iCloud Drive › Videobook with your phones first')
    expect(icloudShareHint(status({ shared: true }))).toBe('Shared with your iPhones')
    expect(icloudShareHint(status({ shared: null }))).toBeNull()
    expect(postDeliveryValidation(postView(), review({ icloud: status({ shared: false }) })).blocking).toBeNull()
  })

  it('posts in one call with the caption and platform only when they changed and are still editable', () => {
    expect(postDeliveryArgs(postView(), review({ icloudFolder: 'skate/' }))).toEqual({ book_id: 'book-1', to: 'icloud', post_cell_id: postView().id, folder: 'skate' })
    const edited = { ...editCopyVersion(initialCopyState(postView()), { body: 'New', tags: ['rain'] }), platform: 'instagram' as const }
    expect(postDeliveryArgs(postView(), review({ copy: edited, destination: 'download' }))).toEqual({ book_id: 'book-1', to: 'download', post_cell_id: postView().id, platform: 'instagram', text: 'New\n\n#rain' })
    const frozen = postView({ outbound: OUTBOUND })
    expect(postDeliveryArgs(frozen, review({ copy: edited }))).toEqual({ book_id: 'book-1', to: 'icloud', post_cell_id: postView().id, folder: 'my-book/post-b1-479eab' })
  })

  it('saves the reviewed caption and platform with the published link of a Post that skipped delivery', () => {
    expect(postReviewDraftArgs(postView(), review())).toEqual({})
    const edited = { ...editCopyVersion(initialCopyState(postView()), { body: 'New', tags: ['rain'] }), platform: 'instagram' as const }
    expect(postReviewDraftArgs(postView(), review({ copy: edited }))).toEqual({ platform: 'instagram', caption: 'New\n\n#rain' })
    expect(postReviewDraftArgs(postView({ outbound: OUTBOUND }), review({ copy: edited }))).toEqual({})
  })

  it('prefills a caption typed after /post unless the Post was already delivered', () => {
    expect(copyCaption(copyWithCaption(postView(), '  Skate day  '))).toBe('Skate day')
    expect(copyCaption(copyWithCaption(postView(), undefined))).toBe('Draft caption')
    expect(copyCaption(copyWithCaption(postView({ outbound: OUTBOUND }), 'Changed'))).toBe('Draft caption')
    expect(postFrozen(postView())).toBe(false)
    expect(postFrozen(postView({ outbound: OUTBOUND }))).toBe(true)
    expect(postFrozen(postView({ status: 'scheduled' }))).toBe(true)
  })

  it('builds download links for the frozen clip and reads them from the post result', () => {
    expect(postDownloadFor(postView(), { bookId: 'book-1', name: 'My Book' })).toBeNull()
    const links = postDownloadFor(postView({ outbound: OUTBOUND }), { bookId: 'book-1', name: 'My Book' })
    expect(links).toEqual({
      clip_url: '/files/book-1/out/clip.mp4?download=my-book-post-b1-479eab.mp4',
      caption_url: '/files/book-1/out/caption.txt?download=my-book-post-b1-479eab.txt',
      filename: 'my-book-post-b1-479eab.mp4',
      caption: 'Draft caption',
    })
    expect(deliveredPostFromTool({ post: postView(), download: links }).download).toEqual(links)
    expect(deliveredPostFromTool({ post: postView() }).download).toBeNull()
    expect(deliveredPostFromTool({ post: postView(), download: { clip_url: '/files/x' } }).download).toBeNull()
  })

  it('waits for Astra and warns past the platform limit', () => {
    const drafting = { ...initialCopyState(postView()), drafting: { requestId: 'r', language: 'en' as const } }
    expect(postDeliveryValidation(postView(), review({ copy: drafting })).blocking).toBe('Astra is writing the caption…')
    const long = editCopyVersion({ ...initialCopyState(postView()), platform: 'x' }, { body: 'a'.repeat(281) })
    expect(postDeliveryValidation(postView(), review({ copy: long }))).toEqual({ blocking: null, notice: "Over X's 280-character limit. Shorten it or regen with Astra." })
    expect(postDeliveryArgs(postView(), review({ destination: 'download' }))).not.toHaveProperty('folder')
  })

  it('shows upload progress only for a real iCloud folder and stops polling once it settles', () => {
    expect(icloudProgressLabel('uploading')).toBe('Uploading to iCloud…')
    expect(icloudProgressLabel('uploaded')).toBe('On iCloud')
    expect(icloudProgressLabel('error', 'Quota exceeded')).toBe('Quota exceeded')
    expect(icloudProgressLabel('not-icloud')).toBeNull()
    expect(icloudProgressLabel(null)).toBeNull()
    expect(icloudSyncShouldPoll(null)).toBe(true)
    expect(icloudSyncShouldPoll('uploading')).toBe(true)
    expect(icloudSyncShouldPoll('uploaded')).toBe(false)
    expect(icloudSyncShouldPoll('error')).toBe(false)
    expect(icloudSyncShouldPoll('not-icloud')).toBe(false)
    expect(icloudSyncFromTool({ phase: 'not-icloud', error: null })).toEqual({ phase: 'not-icloud', error: null })
    expect(postDeliveryReceipt({ post: postView({ icloud: { folder: 'my-book/post-b1-479eab', completedAt: '2026-10-15T00:00:00.000Z' } }), download: null }, 'icloud')).toBe('Saved @b1 to iCloud · Videobook/my-book/post-b1-479eab')
    expect(postDeliveryReceipt({ post: postView(), download: postDownloadFor(postView({ outbound: OUTBOUND }), { bookId: 'book-1', name: 'My Book' }) }, 'download')).toBe('Downloaded @b1 as my-book-post-b1-479eab.mp4')
    expect(icloudPhoneReceipt('my-book/post-b1-479eab')).toBe('On iPhone · iCloud Drive › Videobook › my-book/post-b1-479eab')
    expect(postDeliveryBadges(postView())).toEqual([])
    expect(postDeliveryBadges(postView({ icloud: { folder: 'phones/skate', completedAt: '2026-10-15T00:00:00.000Z' }, download: { completedAt: '2026-10-15T00:00:00.000Z' } }))).toEqual(['iPhone', 'Downloaded'])
    expect(postDeliveryBadges(postView({ icloud: { folder: 'phones/skate' } }))).toEqual([])
  })

  it('asks for the published link once a Post is delivered and until it is linked', () => {
    const delivered = postView({ status: 'ready', icloud: { folder: 'phones/skate', completedAt: '2026-10-15T00:00:00.000Z' } })
    expect(postAwaitingLink(postView())).toBe(false)
    expect(postAwaitingLink(postView({ icloud: { folder: 'phones/skate' } }))).toBe(false)
    expect(postAwaitingLink(delivered)).toBe(true)
    expect(postAwaitingLink(postView({ ...delivered.runtime, url: 'https://www.tiktok.com/@jtbkk/video/1', postedAt: '2026-10-15T01:00:00.000Z' }))).toBe(false)
    expect(postLinkPrompt(delivered)).toBe('Posted on TikTok? Paste the link')
    expect(postTileNextStep(postView())).toBe('Save, download or paste TikTok link')
    expect(postTileNextStep(delivered)).toBe('Paste TikTok link')
    expect(postTileStatus(postView())).toBe('draft')
    expect(postTileStatus(delivered)).toBe('needs_link')
  })

  it('shows a posted tile with its date and latest results', () => {
    const posted = postView({ status: 'posted', url: 'https://www.tiktok.com/@jtbkk/video/1', postedAt: '2026-10-15T12:00:00.000Z' })
    expect(postTileNextStep(posted)).toBeNull()
    expect(postTileStatus(posted)).toBe('posted')
    expect(postTilePostedOn(posted)).toBe(new Date('2026-10-15T12:00:00.000Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
    expect(postTileMetrics(posted)).toEqual([])
    const measured = postView({ ...posted.runtime, metrics: [{ observedAt: '2026-10-16T00:00:00.000Z', source: 'manual', values: { views: 12400, likes: 860, impressions: 99 } }] })
    expect(postTileMetrics(measured).map(metric => metric.label)).toEqual(['views', 'likes'])
    const impressionsOnly = postView({ ...posted.runtime, metrics: [{ observedAt: '2026-10-16T00:00:00.000Z', source: 'x', values: { impressions: 50, likes: null } }] })
    expect(postTileMetrics(impressionsOnly).map(metric => metric.label)).toEqual(['impressions'])
  })
})
