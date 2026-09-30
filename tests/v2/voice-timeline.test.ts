import { afterEach, describe, expect, it } from 'vitest'
import {
  VOICE_PERFORMANCE_MARK,
  VoiceTimeline,
  summarizeVoiceMarks,
  voiceMarksFromPerformance,
} from '../../src/videobook/voice-timeline'

afterEach(() => {
  performance.clearMarks(VOICE_PERFORMANCE_MARK)
})

describe('voice performance timeline', () => {
  it('records connection-setup and utterance-end-to-decoded-audio from the shipped marks', () => {
    const timeline = new VoiceTimeline()
    timeline.connectStart()
    timeline.permissionWaitStart()
    timeline.permissionWaitEnd()
    timeline.sessionRequest()
    timeline.providerReady({
      provider: 'openai',
      transport: 'webrtc',
      model: 'gpt-realtime-2.1',
    })
    timeline.mediaReady()
    const utteranceEnd = performance.now() - 40
    timeline.turnDetection(utteranceEnd)
    timeline.mark('caption-first', { role: 'user' })
    timeline.mark('caption-final', { role: 'user' })
    timeline.mark('caption-first', { role: 'assistant' })
    timeline.firstDecodedAudio(utteranceEnd)
    timeline.mark('action-review')
    timeline.acknowledgement('review')

    const marks = voiceMarksFromPerformance()
    const stages = marks.map((mark) => mark.stage)
    expect(stages).toEqual(expect.arrayContaining([
      'connect-start',
      'permission-wait-start',
      'permission-wait-end',
      'session-request',
      'provider-ready',
      'media-ready',
      'connection-setup',
      'turn-detection',
      'caption-first',
      'caption-final',
      'first-audio',
      'utterance-end-to-decoded-audio',
      'action-review',
      'acknowledgement',
    ]))

    const summary = summarizeVoiceMarks(marks)
    expect(summary.connectionSetupMs).toBeGreaterThan(0)
    expect(summary.permissionWaitMs).toBeGreaterThanOrEqual(0)
    expect(summary.utteranceEndToDecodedAudioMs).toHaveLength(1)
    expect(summary.utteranceEndToDecodedAudioMs[0]).toBeGreaterThan(0)
    expect(summary.connectionSetup.sampleCount).toBe(1)
    expect(summary.utteranceEndToDecodedAudio.sampleCount).toBe(1)
    expect(summary.stages['connection-setup']).toEqual(expect.any(Number))
    expect(summary.stages['utterance-end-to-decoded-audio']).toEqual(expect.any(Number))
    expect(marks.find((mark) => mark.stage === 'acknowledgement')?.status).toBe('review')
    expect(marks.find((mark) => mark.stage === 'fallback')).toBeUndefined()
  })

  it('records pre-turn decoded output as activation audio outside reply latencies', () => {
    const timeline = new VoiceTimeline()
    timeline.connectStart()
    timeline.mediaReady()
    timeline.firstDecodedAudio()
    const marks = voiceMarksFromPerformance()
    const stages = marks.map((mark) => mark.stage)
    expect(stages).toContain('activation-audio')
    expect(stages).not.toContain('first-audio')
    expect(stages).not.toContain('utterance-end-to-decoded-audio')
    const summary = summarizeVoiceMarks(marks)
    expect(summary.utteranceEndToDecodedAudioMs).toEqual([])
    expect(summary.utteranceEndToDecodedAudio).toEqual({ sampleCount: 0 })
    expect(summary.stages['activation-audio']).toEqual(expect.any(Number))
  })

  it('measures decoded audio only after a detected turn', () => {
    const timeline = new VoiceTimeline()
    timeline.connectStart()
    timeline.mediaReady()
    timeline.firstDecodedAudio()
    const utteranceEnd = performance.now() - 40
    timeline.turnDetection(utteranceEnd)
    timeline.firstDecodedAudio(utteranceEnd)
    const marks = voiceMarksFromPerformance()
    expect(marks.filter((mark) => mark.stage === 'first-audio')).toHaveLength(1)
    const summary = summarizeVoiceMarks(marks)
    expect(summary.utteranceEndToDecodedAudioMs).toHaveLength(1)
    expect(summary.utteranceEndToDecodedAudioMs[0]).toBeGreaterThan(0)
  })

  it('itemizes fallback separately and omits reply percentiles when there are no samples', () => {
    const timeline = new VoiceTimeline()
    timeline.connectStart()
    timeline.permissionWaitStart()
    timeline.permissionWaitEnd()
    timeline.sessionRequest()
    timeline.providerReady({
      provider: 'xai',
      transport: 'pcm',
      model: 'grok-voice',
      fallbackReason: 'OPENAI_API_KEY is missing',
    })
    timeline.mediaReady()

    const summary = summarizeVoiceMarks(voiceMarksFromPerformance())
    expect(summary.connectionSetupMs).toBeGreaterThan(0)
    expect(summary.utteranceEndToDecodedAudioMs).toEqual([])
    expect(summary.utteranceEndToDecodedAudio).toEqual({ sampleCount: 0 })
    expect(summary.stages.fallback).toEqual(expect.any(Number))
    expect(voiceMarksFromPerformance().find((mark) => mark.stage === 'fallback')?.reason)
      .toContain('OPENAI_API_KEY')
  })
})
