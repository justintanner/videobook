import { describe, expect, it } from 'vitest'
import type { PostView } from '../../server/src/posts/post-contract'
import {
  addCopyTag,
  appendCopyDraft,
  captionLanguage,
  copyCaption,
  copyDraftArgs,
  copyLimitNotice,
  copyNeedsDraft,
  copyProvenance,
  currentCopyVersion,
  editCopyVersion,
  initialCopyState,
  postCopyDraftFromTool,
  removeCopyTag,
  stepCopyVersion,
} from './post-copy-review'

function postView(caption: string): PostView {
  return {
    id: 'post-1',
    notebookId: 'notebook-1',
    address: '@d3',
    label: 'Post · tiktok',
    definition: {
      version: 1, platform: 'tiktok', account: '', caption, credits: '', notes: '', createdAt: '2026-10-15T06:30:00.000Z',
      source: { cellId: 'source', artifactId: 'clip', revision: 'r1', objectHash: 'h1', filename: 'clip.mp4', snapshotArtifactId: 'snap' },
      lineage: [],
    },
    runtime: { status: 'draft', metrics: [] },
  }
}

describe('post copy review', () => {
  it('starts empty and asks Astra for a first draft when the Post has no caption', () => {
    const copy = initialCopyState(postView(''))
    expect(copy).toMatchObject({ language: 'en', platform: 'tiktok', tracks: {}, prompt: '' })
    expect(copyNeedsDraft(copy, 'en', false)).toBe(true)
    expect(copyNeedsDraft(copy, 'en', true)).toBe(false)
    expect(copyProvenance(copy)).toBe('No English caption yet')
    expect(copyDraftArgs('book', 'post-1', copy, 'en', null)).toEqual({ book_id: 'book', post_cell_id: 'post-1', language: 'en', platform: 'tiktok' })
  })

  it('reads a saved Thai caption with its tag line', () => {
    const copy = initialCopyState(postView('ฝ่าพายุไปกับร่มสีชมพู\n\n#ฝนตก #lightning'))
    expect(captionLanguage('ฝนตก')).toBe('th')
    expect(copy.language).toBe('th')
    expect(currentCopyVersion(copy)).toEqual({ body: 'ฝ่าพายุไปกับร่มสีชมพู', tags: ['ฝนตก', 'lightning'], origin: 'saved', instruction: null })
    expect(copyNeedsDraft(copy, 'th', false)).toBe(false)
    expect(copyNeedsDraft(copy, 'en', false)).toBe(true)
  })

  it('keeps every draft as a version per language and rewrites the current one with a prompt', () => {
    let copy = appendCopyDraft(initialCopyState(postView('')), 'en', { caption: 'Riding out the storm.', tags: ['rain'] }, null)
    expect(copyProvenance(copy)).toBe('Drafted by Astra from the video analysis · English')
    copy = editCopyVersion(copy, { body: 'Riding out the storm!' })
    copy = addCopyTag(copy, '#storm city')
    expect(copyCaption(copy)).toBe('Riding out the storm!\n\n#rain #storm #city')
    expect(copyProvenance(copy)).toBe('Edited by you · Regen keeps this version in history')
    expect(copyDraftArgs('book', 'post-1', { ...copy, platform: 'x' }, 'en', 'shorter')).toEqual({
      book_id: 'book', post_cell_id: 'post-1', language: 'en', platform: 'x', instruction: 'shorter', caption: 'Riding out the storm!', tags: ['rain', 'storm', 'city'],
    })
    copy = appendCopyDraft({ ...copy, drafting: { requestId: 'r', language: 'en' } }, 'en', { caption: 'Storm. Umbrella. Go.', tags: [] }, 'shorter')
    expect(copy.drafting).toBeNull()
    expect(copyProvenance(copy)).toBe('Rewritten by Astra · “shorter”')
    expect(copy.tracks.en?.index).toBe(1)
    copy = stepCopyVersion(copy, -5)
    expect(copyCaption(copy)).toBe('Riding out the storm!\n\n#rain #storm #city')
    copy = removeCopyTag(copy, 'storm')
    expect(currentCopyVersion(copy)?.tags).toEqual(['rain', 'city'])
  })

  it('warns about platform limits and rejects an empty Astra reply', () => {
    const copy = editCopyVersion({ ...initialCopyState(postView('')), platform: 'x' }, { tags: ['a', 'b', 'c'] })
    expect(copyLimitNotice(copy)).toBe('X works best with 2 tags or fewer.')
    expect(postCopyDraftFromTool({ caption: ' Hi ', tags: ['#Rain day', 4] })).toEqual({ caption: 'Hi', tags: ['Rainday'] })
    expect(() => postCopyDraftFromTool({ caption: '' })).toThrow('Astra returned an empty caption.')
  })
})
