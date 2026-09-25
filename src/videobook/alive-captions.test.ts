import { describe, expect, it } from 'vitest'
import { DEFAULT_ALIVE_SETTINGS, type AliveAnalysis } from '../../server/src/remotion/subtitles/alive-types'
import {
  aliveErrorMessage,
  aliveSettingsArgs,
  aliveWordRows,
  defaultAliveOrientation,
  driftRange,
  envelopePath,
  formatAliveTime,
  orientationGeometry,
  parseAliveStudioData,
  resolveAliveCommandAsset,
} from './alive-captions'

const ANALYSIS: AliveAnalysis = {
  version: 1,
  fingerprint: 'abc',
  analyzedAt: '2026-09-25T12:00:00.000Z',
  durationSeconds: 11.5,
  sourceWidth: 1920,
  sourceHeight: 1080,
  envelopeHz: 20,
  envelope: [0, 0.5, 1],
  onsets: [0.95],
  regionsAnalyzed: true,
  phrases: [{
    id: 'p1',
    frameTime: 1.5,
    regions: [{ kind: 'face', confidence: 0.94, x: 0.58, y: 0.16, width: 0.2, height: 0.42 }],
    lines: [
      [{ text: 'We', transcriptStart: 0.4, transcriptEnd: 0.62, onsetStart: 0.4, energy: 0.3 }],
      [{ text: 'burning', transcriptStart: 0.998, transcriptEnd: 1.7, onsetStart: 0.95, energy: 0.95 }],
    ],
  }],
}

describe('alive captions studio data', () => {
  it('parses the alive_captions tool response', () => {
    const data = parseAliveStudioData({ analysis: ANALYSIS, settings: DEFAULT_ALIVE_SETTINGS, cached: true })
    expect(data).toEqual({ analysis: ANALYSIS, settings: DEFAULT_ALIVE_SETTINGS, cached: true })
    expect(() => parseAliveStudioData({ analysis: { ...ANALYSIS, version: 9 }, settings: DEFAULT_ALIVE_SETTINGS })).toThrow()
  })

  it('reports words that start off their vocal onset and follows the snap setting', () => {
    const transcriptRows = aliveWordRows(ANALYSIS, { ...DEFAULT_ALIVE_SETTINGS, snapToOnsets: false })
    expect(transcriptRows.map((row) => [row.text, row.start, row.driftMs, row.drifted])).toEqual([
      ['We', 0.4, 0, false],
      ['burning', 0.998, 48, true],
    ])
    expect(driftRange(transcriptRows)).toEqual({ count: 1, minMs: 48, maxMs: 48 })
    const snappedRows = aliveWordRows(ANALYSIS, DEFAULT_ALIVE_SETTINGS)
    expect(snappedRows[1].start).toBeCloseTo(0.95)
  })

  it('maps orientations to render geometry', () => {
    expect(defaultAliveOrientation(1080, 1920)).toBe('portrait')
    expect(defaultAliveOrientation(1080, 1080)).toBe('square')
    expect(defaultAliveOrientation(null, null)).toBe('landscape')
    expect(orientationGeometry(ANALYSIS, 'portrait')).toEqual({ sourceWidth: 1920, sourceHeight: 1080, targetWidth: 1080, targetHeight: 1920 })
  })

  it('resolves only ready videos for /alive', () => {
    const assets = [
      { id: 'c4', artifactId: 'vid-1', type: 'video', status: 'ready', mediaUrl: '/files/b/vid-1/proxy.mp4' },
      { id: 'a1', artifactId: 'aud-1', type: 'audio', status: 'ready', mediaUrl: '/files/b/aud-1/a.m4a' },
      { id: 'c5', artifactId: 'vid-2', type: 'video', status: 'processing', mediaUrl: null },
    ]
    expect(resolveAliveCommandAsset('vid-1', assets)).toMatchObject({ ok: true, asset: { artifactId: 'vid-1' } })
    expect(resolveAliveCommandAsset('c4', assets)).toMatchObject({ ok: true })
    expect(resolveAliveCommandAsset('aud-1', assets)).toEqual({ ok: false, message: '/alive requires a video asset' })
    expect(resolveAliveCommandAsset('vid-2', assets)).toEqual({ ok: false, message: 'Process the video before opening alive captions' })
    expect(resolveAliveCommandAsset(null, assets)).toEqual({ ok: false, message: 'Usage: /alive @video' })
  })

  it('formats tool arguments, errors, time and the envelope', () => {
    expect(aliveSettingsArgs(DEFAULT_ALIVE_SETTINGS)).toEqual({
      style: 'stack', motion: 'pop', energy_sizing: true, snap_to_onsets: true,
      avoid_faces: true, avoid_text: true, text_color: '#F8FAFC', hit_color: '#72E7AA',
    })
    expect(aliveErrorMessage(new Error('{"status":"missing_transcript","message":"Run /transcribe first."}'))).toBe('Run /transcribe first.')
    expect(aliveErrorMessage(new Error('plain'))).toBe('plain')
    expect(formatAliveTime(4.123)).toBe('00:04.12')
    expect(envelopePath([0, 1])).toBe('M0,100 L0.0,100.0 L500.0,0.0 L1000,100 Z')
    expect(envelopePath([])).toBe('')
  })
})
