import { describe, expect, it } from 'vitest'
import {
  formatMediaTime,
  notebookAudioPresentation,
  notebookAudioSummary,
  notebookCellActionPresentation,
  notebookCellInspectorActionLabel,
  notebookCellStatusLabel,
  notebookCellSupportsExecution,
  notebookSplitFrameIds,
  notebookSplitRange,
} from '../../src/videobook/notebook-cell-presentation'

describe('notebook cell presentation', () => {
  it('keeps media cells passive even when obsolete action fields are present', () => {
    const video = {
      type: 'video' as const,
      operation: 'preprocess_source',
      tool: 'ffmpeg',
    }
    const image = {
      type: 'image' as const,
      operation: 'capture_frame',
      tool: 'ffmpeg',
    }

    expect(notebookCellSupportsExecution(video)).toBe(false)
    expect(notebookCellActionPresentation(video, 'completed')).toBeNull()
    expect(notebookCellActionPresentation(image, 'completed')).toBeNull()
  })

  it('labels generators Gen and completed operations Re-run', () => {
    expect(notebookCellActionPresentation({
      type: 'generate_video',
      tool: 'generate_video',
    }, 'ready')).toEqual({ disabled: false, label: 'Gen' })
    expect(notebookCellActionPresentation({
      type: 'extract_audio',
      operation: 'extract_audio',
      tool: 'ffmpeg',
      outputArtifactId: 'audio-artifact',
    }, 'completed')).toEqual({ disabled: false, label: 'Re-run' })
    expect(notebookCellActionPresentation({
      type: 'split_video',
      operation: 'split_range',
      tool: 'ffmpeg',
    }, 'pending')).toEqual({ disabled: false, label: 'Run' })
  })

  it('uses operation-aware action copy in the inspector', () => {
    expect(notebookCellInspectorActionLabel('extract_audio', 'Re-run')).toBe('Extract again')
    expect(notebookCellInspectorActionLabel('split_video', 'Run')).toBe('Split')
    expect(notebookCellInspectorActionLabel('generate_video', 'Gen')).toBe('Generate')
  })

  it('hides execution status for passive media but not generators', () => {
    expect(notebookCellStatusLabel('video', 'completed')).toBeNull()
    expect(notebookCellStatusLabel('image', 'completed')).toBeNull()
    expect(notebookCellStatusLabel('audio', 'completed')).toBeNull()
    expect(notebookCellStatusLabel('generate_video', 'completed')).toBe('completed')
    expect(notebookCellStatusLabel('split_video', 'completed')).toBe('completed')
  })

  it('projects canonical split frame references and range values', () => {
    const inputs = {
      startSeconds: 15,
      endSeconds: 30,
      firstFrameArtifactId: 'first-artifact',
      lastFrameArtifactId: 'last-artifact',
    }

    expect(notebookSplitFrameIds(inputs)).toEqual({
      first: 'first-artifact',
      last: 'last-artifact',
    })
    expect(notebookSplitRange(inputs)).toEqual({
      startSeconds: 15,
      endSeconds: 30,
    })
  })

  it('formats persisted audio stream information', () => {
    expect(formatMediaTime(60.005)).toBe('1:00.01')
    expect(formatMediaTime(59.999)).toBe('1:00')
    const input = {
      audioInfo: {
        channelLayout: 'stereo',
        channels: 2,
        codec: 'aac',
        durationSeconds: 15,
        sampleRateHz: 48_000,
      },
      durationSeconds: 15,
      hasOutput: true,
      inputs: { audioRole: 'scene' },
    }
    expect(notebookAudioPresentation(input)).toEqual({
      role: 'Scene audio',
      duration: '0:15',
      details: ['AAC', '48 kHz', 'stereo'],
    })
    expect(notebookAudioSummary(input)).toBe(
      'Scene audio · 0:15 · AAC · 48 kHz · stereo',
    )
    expect(notebookAudioSummary({
      audioInfo: null,
      durationSeconds: null,
      hasOutput: true,
      inputs: {
        audioRole: 'continuous-source',
        durationSeconds: 30,
      },
    })).toBe('Continuous source · 0:30')
  })
})
