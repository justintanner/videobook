import type { PostPlatform, PostView } from '../../server/src/posts/post-contract'
import {
  joinCaptionTags,
  normalizePostTags,
  PLATFORM_CAPTION_LIMITS,
  PLATFORM_NAMES,
  PLATFORM_TAG_LIMITS,
  POST_COPY_LANGUAGE_NAMES,
  splitCaptionTags,
  type PostCopyLanguage,
} from '../../server/src/posts/post-copy-format'

export type CopyOrigin = 'saved' | 'auto' | 'astra' | 'edited'

export type CopyVersion = {
  body: string
  tags: string[]
  origin: CopyOrigin
  instruction: string | null
}

export type CopyTrack = {
  versions: CopyVersion[]
  index: number
}

export type PostCopyState = {
  language: PostCopyLanguage
  platform: PostPlatform
  tracks: Partial<Record<PostCopyLanguage, CopyTrack>>
  prompt: string
  drafting: { requestId: string; language: PostCopyLanguage } | null
  error: string | null
}

export type PostCopyDraftResult = { caption: string; tags: string[] }

export const COPY_PLATFORMS: ReadonlyArray<{ id: PostPlatform; label: string }> = [
  { id: 'x', label: 'X' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'youtube', label: 'YT Shorts' },
  { id: 'other', label: 'Other' },
]

export const COPY_PROMPT_PRESETS: readonly string[] = ['Shorter', 'Punchier hook', 'More playful', 'Fewer tags', 'Add a call to action']

const THAI_SCRIPT = /[฀-๿]/u

export function captionLanguage(text: string): PostCopyLanguage {
  return THAI_SCRIPT.test(text) ? 'th' : 'en'
}

export function initialCopyState(post: PostView): PostCopyState {
  const caption = post.definition.caption
  const language = captionLanguage(caption)
  const parts = splitCaptionTags(caption)
  const tracks: PostCopyState['tracks'] = caption.trim()
    ? { [language]: { versions: [{ body: parts.body, tags: parts.tags, origin: 'saved', instruction: null }], index: 0 } }
    : {}
  return { language, platform: post.definition.platform, tracks, prompt: '', drafting: null, error: null }
}

export function currentCopyVersion(copy: PostCopyState): CopyVersion | null {
  const track = copy.tracks[copy.language]
  return track?.versions[track.index] ?? null
}

export function copyCaption(copy: PostCopyState): string {
  const version = currentCopyVersion(copy)
  return version ? joinCaptionTags(version.body, version.tags) : ''
}

function replaceCurrent(copy: PostCopyState, version: CopyVersion): PostCopyState {
  const track = copy.tracks[copy.language]
  const next: CopyTrack = track
    ? { ...track, versions: track.versions.map((item, index) => index === track.index ? version : item) }
    : { versions: [version], index: 0 }
  return { ...copy, tracks: { ...copy.tracks, [copy.language]: next } }
}

export function editCopyVersion(copy: PostCopyState, patch: Partial<Pick<CopyVersion, 'body' | 'tags'>>): PostCopyState {
  const current = currentCopyVersion(copy) ?? { body: '', tags: [], origin: 'edited', instruction: null }
  return replaceCurrent(copy, { ...current, ...patch, origin: 'edited' })
}

export function addCopyTag(copy: PostCopyState, raw: string): PostCopyState {
  const tags = currentCopyVersion(copy)?.tags ?? []
  const next = normalizePostTags([...tags, ...raw.split(/[\s,]+/u)])
  return next.length === tags.length ? copy : editCopyVersion(copy, { tags: next })
}

export function removeCopyTag(copy: PostCopyState, tag: string): PostCopyState {
  const tags = currentCopyVersion(copy)?.tags ?? []
  return editCopyVersion(copy, { tags: tags.filter(item => item !== tag) })
}

export function appendCopyDraft(copy: PostCopyState, language: PostCopyLanguage, draft: PostCopyDraftResult, instruction: string | null): PostCopyState {
  const track = copy.tracks[language] ?? { versions: [], index: 0 }
  const version: CopyVersion = { body: draft.caption, tags: draft.tags, origin: instruction ? 'astra' : 'auto', instruction }
  const versions = [...track.versions, version]
  return { ...copy, tracks: { ...copy.tracks, [language]: { versions, index: versions.length - 1 } }, drafting: null, error: null }
}

export function stepCopyVersion(copy: PostCopyState, delta: number): PostCopyState {
  const track = copy.tracks[copy.language]
  if (!track) return copy
  const index = Math.min(track.versions.length - 1, Math.max(0, track.index + delta))
  return { ...copy, tracks: { ...copy.tracks, [copy.language]: { ...track, index } } }
}

export function copyNeedsDraft(copy: PostCopyState, language: PostCopyLanguage, locked: boolean): boolean {
  return !locked && !copy.drafting && !copy.tracks[language]?.versions.length
}

export function copyDraftArgs(bookId: string, postId: string, copy: PostCopyState, language: PostCopyLanguage, instruction: string | null): Record<string, unknown> {
  const track = copy.tracks[language]
  const current = track?.versions[track.index]
  return {
    book_id: bookId,
    post_cell_id: postId,
    language,
    platform: copy.platform,
    ...(instruction ? { instruction } : {}),
    ...(instruction && current ? { caption: current.body, tags: current.tags } : {}),
  }
}

export function postCopyDraftFromTool(value: unknown): PostCopyDraftResult {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const caption = typeof record.caption === 'string' ? record.caption.trim() : ''
  if (!caption) throw new Error('Astra returned an empty caption.')
  const tags = Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : []
  return { caption, tags: normalizePostTags(tags) }
}

export function copyProvenance(copy: PostCopyState): string {
  const version = currentCopyVersion(copy)
  const language = POST_COPY_LANGUAGE_NAMES[copy.language]
  if (!version) return `No ${language} caption yet`
  if (version.origin === 'saved') return 'Saved caption'
  if (version.origin === 'edited') return 'Edited by you · Regen keeps this version in history'
  if (version.origin === 'astra') return `Rewritten by Astra · “${version.instruction ?? ''}”`
  return `Drafted by Astra from the video analysis · ${language}`
}

export function copyLimitStatus(copy: PostCopyState): { length: number; limit: number; over: boolean; tooManyTags: boolean } {
  const length = copyCaption(copy).length
  const limit = PLATFORM_CAPTION_LIMITS[copy.platform]
  const tags = currentCopyVersion(copy)?.tags.length ?? 0
  return { length, limit, over: length > limit, tooManyTags: tags > PLATFORM_TAG_LIMITS[copy.platform] }
}

export function copyLimitNotice(copy: PostCopyState): string | null {
  const status = copyLimitStatus(copy)
  const name = PLATFORM_NAMES[copy.platform]
  if (status.over) return `Over ${name}'s ${status.limit.toLocaleString()}-character limit. Shorten it or regen with Astra.`
  if (status.tooManyTags) return `${name} works best with ${PLATFORM_TAG_LIMITS[copy.platform]} tags or fewer.`
  return null
}
