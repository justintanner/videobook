import { describe, expect, it } from 'vitest'
import type { PostView } from '../../server/src/posts/post-contract'
import { cellStateFlag } from '../../src/videobook/cell-state-flag'

function postView(runtime: Partial<PostView['runtime']> = {}, sourced = true): PostView {
  return {
    id: 'post-d6',
    notebookId: 'notebook-1',
    address: '@d6',
    label: 'Post · x',
    definition: {
      version: 1,
      platform: 'x',
      account: '',
      caption: 'Sunday at the pool, one take.',
      credits: '',
      notes: '',
      createdAt: '2026-11-20T09:00:00.000Z',
      source: sourced
        ? { cellId: 'video-d3', artifactId: 'artifact-d3', revision: 'r1', objectHash: 'h1', filename: 'pool.mp4', snapshotArtifactId: 'snapshot-d3' }
        : null,
      lineage: [],
    },
    runtime: { status: 'draft', metrics: [], ...runtime },
  }
}

describe('cellStateFlag', () => {
  it('leaves ready and finished tiles unflagged', () => {
    expect(cellStateFlag({ kind: 'video', status: 'completed' })).toBeNull()
    expect(cellStateFlag({ kind: 'generate_video', status: 'ready' })).toBeNull()
    expect(cellStateFlag({ kind: 'image', status: '' })).toBeNull()
  })

  it('names active work with the clock label and tells waiting from working', () => {
    expect(cellStateFlag({ kind: 'video', status: 'queued' })).toEqual({ label: 'Queued', tone: 'queued' })
    expect(cellStateFlag({ kind: 'video', status: 'render-queued-portrait' }))
      .toEqual({ label: 'Queued to render', tone: 'queued' })
    expect(cellStateFlag({ kind: 'video', status: 'awaiting-output' })).toEqual({ label: 'Generating', tone: 'working' })
    expect(cellStateFlag({ kind: 'video', status: 'downloading' })).toEqual({ label: 'Downloading', tone: 'working' })
    expect(cellStateFlag({ kind: 'video', status: 'trimming' })).toEqual({ label: 'Trimming', tone: 'working' })
  })

  it('flags a failure ahead of anything else the cell is doing', () => {
    expect(cellStateFlag({ kind: 'image', status: 'error', runningTakes: 2 })).toEqual({ label: 'Failed', tone: 'failed' })
  })

  it('names an upload into an empty media slot', () => {
    expect(cellStateFlag({ kind: 'image', status: 'ready', slotOperation: 'upload' }))
      .toEqual({ label: 'Uploading', tone: 'working' })
    expect(cellStateFlag({ kind: 'video', status: 'ready', slotOperation: 'attach' }))
      .toEqual({ label: 'Attaching', tone: 'working' })
  })

  it('marks a gen cell whose takes are running, then one that still needs a prompt', () => {
    expect(cellStateFlag({ kind: 'generate_video', status: 'completed', runningTakes: 2 }))
      .toEqual({ label: 'Running', tone: 'working' })
    expect(cellStateFlag({ kind: 'generate_video', status: 'ready', promptMissing: true }))
      .toEqual({ label: 'No prompt', tone: 'attention' })
    expect(cellStateFlag({ kind: 'generate_video', status: 'generating', promptMissing: true }))
      .toEqual({ label: 'Generating', tone: 'working' })
  })

  it('reads a post from its runtime instead of the cell status', () => {
    expect(cellStateFlag({ kind: 'post', status: 'completed', post: postView() })).toBeNull()
    expect(cellStateFlag({ kind: 'post', status: 'draft', post: postView({ status: 'posting' }) }))
      .toEqual({ label: 'Posting', tone: 'working' })
    expect(cellStateFlag({ kind: 'post', status: 'draft', post: postView({ status: 'failed', error: 'Too long' }) }))
      .toEqual({ label: 'Failed', tone: 'failed' })
    expect(cellStateFlag({
      kind: 'post',
      status: 'posted',
      post: postView({ status: 'posted', url: 'https://x.com/a/status/1', postedAt: '2026-11-22T10:00:00.000Z' }),
    })).toEqual({ label: 'Posted', tone: 'done' })
  })

  it('asks for the live link once a post is on the phone but not yet linked', () => {
    const delivered = postView({ icloud: { folder: 'pool', completedAt: '2026-11-21T08:00:00.000Z' } })
    expect(cellStateFlag({ kind: 'post', status: 'draft', post: delivered }))
      .toEqual({ label: 'Needs link', tone: 'attention' })
  })

  it('shows an unfamiliar status as a neutral word rather than hiding it', () => {
    expect(cellStateFlag({ kind: 'analyze', status: 'cancelled' })).toEqual({ label: 'Cancelled', tone: 'neutral' })
    expect(cellStateFlag({ kind: 'analyze', status: 'not_ready' })).toEqual({ label: 'Not ready', tone: 'neutral' })
  })
})
