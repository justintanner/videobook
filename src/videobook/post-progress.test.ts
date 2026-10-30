import { describe, expect, it } from 'vitest'
import type { PostView } from '../../server/src/posts/post-contract'
import { postPreviewAspect, postProgressCurrent, postProgressSteps } from './post-progress'

function postView(caption: string, runtime: Partial<PostView['runtime']> = {}, source = true): PostView {
  return {
    id: 'post-1',
    notebookId: 'notebook-1',
    address: '@d3',
    label: 'Post · tiktok',
    definition: {
      version: 1,
      platform: 'tiktok',
      account: '',
      caption,
      credits: '',
      notes: '',
      createdAt: '2026-10-27T13:23:29.000Z',
      source: source ? { cellId: 'source-cell', artifactId: 'source-artifact', revision: 'r1', objectHash: 'h1', filename: 'clip.mp4', snapshotArtifactId: 'snapshot' } : null,
      lineage: [],
    },
    runtime: { status: 'draft', metrics: [], ...runtime },
  }
}

const done = (post: PostView) => postProgressSteps(post).filter(step => step.done).map(step => step.key)

describe('post progress', () => {
  it('starts at the clip when no source is frozen', () => {
    const steps = postProgressSteps(postView('', {}, false))
    expect(done(postView('', {}, false))).toEqual([])
    expect(postProgressCurrent(steps)).toBe('clip')
  })

  it('waits on delivery once the clip and caption are set', () => {
    const post = postView('Overhead pass')
    expect(done(post)).toEqual(['clip', 'caption'])
    expect(postProgressCurrent(postProgressSteps(post))).toBe('deliver')
  })

  it('treats a whitespace caption as missing', () => {
    expect(postProgressCurrent(postProgressSteps(postView('   ')))).toBe('caption')
  })

  it('asks for the live link after a download', () => {
    const post = postView('Overhead pass', { download: { completedAt: '2026-10-27T14:00:00.000Z' } })
    expect(postProgressCurrent(postProgressSteps(post))).toBe('link')
  })

  it('counts a linked post as delivered and waits on results', () => {
    const post = postView('Overhead pass', { status: 'posted', url: 'https://www.tiktok.com/@a/video/1' })
    expect(done(post)).toEqual(['clip', 'caption', 'deliver', 'link'])
    expect(postProgressCurrent(postProgressSteps(post))).toBe('results')
  })

  it('completes once an observation exists', () => {
    const post = postView('Overhead pass', { status: 'posted', url: 'https://x.com/a/status/1', metrics: [{ observedAt: '2026-10-28T10:00:00.000Z', source: 'manual', values: { views: 12 } }] })
    expect(postProgressCurrent(postProgressSteps(post))).toBeNull()
  })

  it('uses the media dimensions for the preview frame and falls back to 9:16', () => {
    expect(postPreviewAspect(1920, 1080)).toBe('1920 / 1080')
    expect(postPreviewAspect(null, 1080)).toBe('9 / 16')
    expect(postPreviewAspect(undefined, undefined)).toBe('9 / 16')
  })
})
