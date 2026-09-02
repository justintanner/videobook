import { describe, expect, it } from 'vitest'
import {
  notebookMentionAssets,
  resolveNotebookMentionAliases,
} from './mention-suggestions'
import { resolveMusicVideoCommandAsset } from './music-video-command'

function asset(overrides: Partial<{
  id: string
  artifactId: string
  label: string
  type: string
  status: string
  mediaUrl: string | null
  audioInfo: unknown | null
}> = {}) {
  return {
    id: 'aud-master',
    artifactId: '01900000-0000-7000-8000-000000000001',
    label: 'Master song',
    type: 'audio',
    status: 'ready',
    mediaUrl: '/media/master.wav',
    audioInfo: { durationSeconds: 30 },
    ...overrides,
  }
}

describe('music-video slash command resolution', () => {
  it('requires an asset reference', () => {
    expect(resolveMusicVideoCommandAsset(null, [])).toEqual({
      ok: false,
      message: 'Usage: /music-video @audio',
    })
  })

  it('resolves either the projected id or canonical artifact id', () => {
    const input = asset()
    expect(resolveMusicVideoCommandAsset(input.id, [input])).toEqual({
      ok: true,
      asset: input,
    })
    expect(resolveMusicVideoCommandAsset(input.artifactId, [input])).toEqual({
      ok: true,
      asset: input,
    })
  })

  it('rejects non-audio and unprocessed audio assets', () => {
    expect(resolveMusicVideoCommandAsset('aud-master', [asset({ type: 'video' })])).toEqual({
      ok: false,
      message: '/music-video requires an audio asset',
    })
    expect(resolveMusicVideoCommandAsset('aud-master', [asset({ status: 'processing' })])).toEqual({
      ok: false,
      message: 'Process the audio asset before opening the music-video editor',
    })
    expect(resolveMusicVideoCommandAsset('aud-master', [asset({ audioInfo: null })])).toEqual({
      ok: false,
      message: 'Process the audio asset before opening the music-video editor',
    })
  })

  it('resolves a notebook address through mention aliases to the audio artifact', () => {
    const input = asset()
    const mentions = notebookMentionAssets(
      [{ slot: { row: 0, column: 1 }, type: 'audio', outputArtifactId: input.artifactId }],
      [{
        id: input.id,
        artifactId: input.artifactId,
        type: input.type,
        mediaUrl: input.mediaUrl,
        thumbnailUrl: null,
        width: null,
        height: null,
        duration: 30,
        status: input.status,
      }],
    )
    const resolved = resolveNotebookMentionAliases('@a2', mentions)
    expect(resolved).toBe(`@${input.artifactId}`)
    expect(resolveMusicVideoCommandAsset(input.artifactId, [input])).toEqual({
      ok: true,
      asset: input,
    })
  })
})
