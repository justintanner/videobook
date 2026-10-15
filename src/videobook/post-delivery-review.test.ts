import { describe, expect, it } from 'vitest'
import type { NotebookCell } from 'videobook-engine'
import type { PostView } from '../../server/src/posts/post-contract'
import {
  defaultDropboxFolder,
  defaultIcloudFolder,
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
  resolveDeliveryPost,
  resolveDeliverySource,
  reviewWithIcloudStatus,
  type ICloudStatus,
  postPlatformArgs,
  type PostDeliveryReview,
} from './post-delivery-review'
import { editCopyVersion, initialCopyState } from './post-copy-review'

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
    dropboxFolder: '/Videobook/my-book/post-b1-479eab',
    connection: { connected: true, pending: false, hasCredentials: true, error: null },
    connecting: false,
    icloud: status(),
    receipt: null,
    sync: null,
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

  it('starts on iCloud unless the entry is Dropbox or iCloud Drive is unavailable', () => {
    expect(deliveryDestinationForEntry('icloud', null)).toBe('icloud')
    expect(deliveryDestinationForEntry('icloud', status())).toBe('icloud')
    expect(deliveryDestinationForEntry('dropbox', status())).toBe('dropbox')
    expect(deliveryDestinationForEntry('icloud', status({ available: false, reason: 'missing' }))).toBe('dropbox')
    const opened = review({ entry: 'icloud', destination: 'icloud', icloud: null })
    expect(reviewWithIcloudStatus(opened, status({ available: false, reason: 'iCloud Drive is not set up on this Mac.' })).destination).toBe('dropbox')
    expect(reviewWithIcloudStatus({ ...opened, pinnedDestination: true }, status({ available: false })).destination).toBe('icloud')
  })

  it('suggests the shared folder shape and keeps a folder already used', () => {
    expect(defaultIcloudFolder(postView(), 'My Book!')).toBe('my-book/post-b1-479eab')
    expect(defaultDropboxFolder(postView(), 'My Book!')).toBe('/Videobook/my-book/post-b1-479eab')
    const used = postView({
      icloud: { folder: 'phones/skate', completedAt: '2026-10-14T10:00:00.000Z' },
      dropbox: { folder: '/Clients/rain', video: { path: '/Clients/rain/clip.mp4', hash: 'a', offset: 0 }, caption: { path: '/Clients/rain/caption.txt', hash: 'b', offset: 0 } },
    })
    expect(defaultIcloudFolder(used, 'My Book')).toBe('phones/skate')
    expect(defaultDropboxFolder(used, 'My Book')).toBe('/Clients/rain')
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
    expect(postDeliveryValidation(postView(), review({ destination: 'dropbox', dropboxFolder: 'clips' })).blocking).toContain('Start the Dropbox folder with /')
    expect(postDeliveryValidation(postView(), review({ destination: 'dropbox', connection: { connected: false, pending: false, hasCredentials: false, error: null } })).blocking).toContain('DROPBOX_CLIENT_ID')
    expect(postDeliveryValidation(postView(), review())).toEqual({ blocking: null, notice: null })
    expect(icloudShareHint(status({ shared: false }))).toBe('Share iCloud Drive › Videobook with your phones first')
    expect(icloudShareHint(status({ shared: true }))).toBe('Shared with your iPhones')
    expect(icloudShareHint(status({ shared: null }))).toBeNull()
    expect(postDeliveryValidation(postView(), review({ icloud: status({ shared: false }) })).blocking).toBeNull()
  })

  it('sends the caption only when it changed and is still editable', () => {
    expect(postDeliveryArgs(postView(), review({ icloudFolder: 'skate/' }))).toEqual({ book_id: 'book-1', post_cell_id: postView().id, folder: 'skate' })
    const edited = editCopyVersion(initialCopyState(postView()), { body: 'New', tags: ['rain'] })
    expect(postDeliveryArgs(postView(), review({ copy: edited }))).toMatchObject({ caption: 'New\n\n#rain' })
    const frozen = postView({ outbound: { artifactId: 'out', filename: 'clip.mp4', caption: 'Draft caption', frozenAt: '2026-10-14T10:00:00.000Z', revision: 'r2', objectHash: 'h2' } })
    expect(postDeliveryArgs(frozen, review({ copy: edited }))).not.toHaveProperty('caption')
  })

  it('saves a changed platform before delivery while the Post is still a draft', () => {
    expect(postPlatformArgs(postView(), review())).toBeNull()
    const copy = { ...initialCopyState(postView()), platform: 'x' as const }
    expect(postPlatformArgs(postView(), review({ copy }))).toEqual({ book_id: 'book-1', post_cell_id: postView().id, platform: 'x' })
    const frozen = postView({ outbound: { artifactId: 'out', filename: 'clip.mp4', caption: 'Draft caption', frozenAt: '2026-10-14T10:00:00.000Z', revision: 'r2', objectHash: 'h2' } })
    expect(postPlatformArgs(frozen, review({ copy }))).toBeNull()
  })

  it('waits for Astra and warns past the platform limit', () => {
    const drafting = { ...initialCopyState(postView()), drafting: { requestId: 'r', language: 'en' as const } }
    expect(postDeliveryValidation(postView(), review({ copy: drafting })).blocking).toBe('Astra is writing the caption…')
    const long = editCopyVersion({ ...initialCopyState(postView()), platform: 'x' }, { body: 'a'.repeat(281) })
    expect(postDeliveryValidation(postView(), review({ copy: long }))).toEqual({ blocking: null, notice: "Over X's 280-character limit. Shorten it or regen with Astra." })
    expect(postDeliveryArgs(postView(), review({ destination: 'dropbox', dropboxFolder: '/Out/' })).folder).toBe('/Out')
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
    expect(postDeliveryReceipt(postView({ icloud: { folder: 'my-book/post-b1-479eab', completedAt: '2026-10-15T00:00:00.000Z' } }), 'icloud')).toBe('Saved @b1 to iCloud · Videobook/my-book/post-b1-479eab')
    expect(icloudPhoneReceipt('my-book/post-b1-479eab')).toBe('On iPhone · iCloud Drive › Videobook › my-book/post-b1-479eab')
    expect(postDeliveryBadges(postView())).toEqual([])
    expect(postDeliveryBadges(postView({ icloud: { folder: 'phones/skate', completedAt: '2026-10-15T00:00:00.000Z' }, dropbox: { folder: '/Clients/rain', video: { path: '/Clients/rain/clip.mp4', hash: 'a', offset: 0 }, caption: { path: '/Clients/rain/caption.txt', hash: 'b', offset: 0 }, completedAt: '2026-10-15T00:00:00.000Z' } }))).toEqual(['iPhone', 'Dropbox'])
    expect(postDeliveryBadges(postView({ icloud: { folder: 'phones/skate' } }))).toEqual([])
  })

  it('asks for the published link once a Post is delivered and until it is linked', () => {
    const delivered = postView({ status: 'ready', icloud: { folder: 'phones/skate', completedAt: '2026-10-15T00:00:00.000Z' } })
    expect(postAwaitingLink(postView())).toBe(false)
    expect(postAwaitingLink(postView({ icloud: { folder: 'phones/skate' } }))).toBe(false)
    expect(postAwaitingLink(delivered)).toBe(true)
    expect(postAwaitingLink(postView({ ...delivered.runtime, url: 'https://www.tiktok.com/@jtbkk/video/1', postedAt: '2026-10-15T01:00:00.000Z' }))).toBe(false)
    expect(postLinkPrompt(delivered)).toBe('Posted on TikTok? Paste the link')
    expect(postTileNextStep(postView())).toBe('Save to iPhone next')
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
