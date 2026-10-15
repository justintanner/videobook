import { describe, expect, it } from 'vitest'
import type { NotebookCell } from 'videobook-engine'
import type { PostView } from '../../server/src/posts/post-contract'
import {
  defaultDropboxFolder,
  postDropboxArgs,
  postDropboxValidation,
  resolveDropboxPost,
  type PostDropboxReview,
} from './post-dropbox-review'

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

function review(overrides: Partial<PostDropboxReview> = {}): PostDropboxReview {
  return {
    bookId: 'book-1',
    notebookId: 'notebook-1',
    postId: postView().id,
    caption: 'Draft caption',
    folder: '/Videobook/my-book/post-b1-479eab',
    connection: { connected: true, pending: false, hasCredentials: true, error: null },
    connecting: false,
    ...overrides,
  }
}

const cells = [{ id: postView().id, type: 'post', outputArtifactId: 'snapshot-artifact', slot: { row: 1, column: 0 } }] as unknown as NotebookCell[]

describe('post Dropbox review', () => {
  it('resolves a Post by address, cell id, resolved artifact id or selection, and nothing else', () => {
    const posts = [postView()]
    expect(resolveDropboxPost(posts, cells, '@B1', null)?.id).toBe(posts[0]!.id)
    expect(resolveDropboxPost(posts, cells, posts[0]!.id, null)?.id).toBe(posts[0]!.id)
    expect(resolveDropboxPost(posts, cells, 'snapshot-artifact', null)?.id).toBe(posts[0]!.id)
    expect(resolveDropboxPost(posts, cells, undefined, posts[0]!.id)?.id).toBe(posts[0]!.id)
    expect(resolveDropboxPost(posts, cells, '@a3', posts[0]!.id)).toBeNull()
    expect(resolveDropboxPost(posts, cells, undefined, 'other-cell')).toBeNull()
  })

  it('suggests a readable default folder and keeps a folder already used', () => {
    expect(defaultDropboxFolder(postView(), 'My Book!')).toBe('/Videobook/my-book/post-b1-479eab')
    const used = postView({ dropbox: { folder: '/Clients/rain', video: { path: '/Clients/rain/clip.mp4', hash: 'a', offset: 0 }, caption: { path: '/Clients/rain/caption.txt', hash: 'b', offset: 0 } } })
    expect(defaultDropboxFolder(used, 'My Book')).toBe('/Clients/rain')
  })

  it('explains each reason the upload is unavailable', () => {
    expect(postDropboxValidation(null, review()).blocking).toBe('This Post is no longer on the canvas.')
    expect(postDropboxValidation(postView({}, false), review()).blocking).toContain('has no saved source clip')
    expect(postDropboxValidation(postView({ status: 'scheduled' }), review()).blocking).toContain('current publication')
    expect(postDropboxValidation(postView(), review({ folder: 'clips' })).blocking).toContain('Start the Dropbox folder with /')
    expect(postDropboxValidation(postView(), review({ folder: '/a/../b' })).blocking).toContain('without ..')
    expect(postDropboxValidation(postView(), review({ connection: null })).blocking).toBe('Checking the Dropbox connection…')
    expect(postDropboxValidation(postView(), review({ connection: { connected: false, pending: false, hasCredentials: false, error: null } })).blocking).toContain('DROPBOX_CLIENT_ID')
    expect(postDropboxValidation(postView(), review({ connection: { connected: false, pending: false, hasCredentials: true, error: null } })).blocking).toBe('Connect Dropbox to upload.')
    expect(postDropboxValidation(postView(), review())).toEqual({ blocking: null, notice: null })
  })

  it('sends the caption only when it changed and is still editable', () => {
    expect(postDropboxArgs(postView(), review({ folder: '/Out/' }))).toEqual({ book_id: 'book-1', post_cell_id: postView().id, folder: '/Out' })
    expect(postDropboxArgs(postView(), review({ caption: 'New' }))).toMatchObject({ caption: 'New' })
    const frozen = postView({ outbound: { artifactId: 'out', filename: 'clip.mp4', caption: 'Draft caption', frozenAt: '2026-10-14T10:00:00.000Z', revision: 'r2', objectHash: 'h2' } })
    expect(postDropboxArgs(frozen, review({ caption: 'New' }))).not.toHaveProperty('caption')
  })
})
