import { describe, expect, it } from 'vitest'
import {
  formatMediaAspectRatio,
  formatMediaTime,
  notebookAudioPresentation,
  notebookAudioSummary,
  notebookCellActionPresentation,
  notebookCellExecutionObservation,
  notebookCellInspectorActionLabel,
  notebookCellIsActiveStatus,
  notebookCellMediaCaption,
  notebookCellRunObservation,
  notebookCellStatusLabel,
  notebookCellSupportsExecution,
  notebookOutputVersionArtifactIds,
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

  it('identifies every active execution phase', () => {
    expect([
      'awaiting-output',
      'completing',
      'queued',
      'running',
    ].every(notebookCellIsActiveStatus)).toBe(true)
    expect(notebookCellIsActiveStatus('completed')).toBe(false)
    expect(notebookCellIsActiveStatus('error')).toBe(false)
  })

  it('observes only the matching notebook run lifecycle', () => {
    const pending = {
      execution: {
        cell: { runId: 'previous-run', status: 'completed' },
      },
    }
    expect(notebookCellRunObservation(pending, 'cell', 'current-run')).toEqual({
      error: null,
      state: 'pending',
      status: null,
    })

    const running = {
      execution: {
        cell: { runId: 'current-run', status: 'running' },
      },
    }
    expect(notebookCellRunObservation(running, 'cell', 'current-run')).toEqual({
      error: null,
      state: 'active',
      status: 'running',
    })

    const failed = {
      execution: {
        cell: {
          runId: 'current-run',
          status: 'error',
          error: 'ffmpeg failed',
        },
      },
    }
    expect(notebookCellRunObservation(failed, 'cell', 'current-run')).toEqual({
      error: 'ffmpeg failed',
      state: 'error',
      status: 'error',
    })
  })

  it('reads persisted execution details independently of a run id', () => {
    const document = {
      execution: {
        cell: {
          runId: 'failed-run',
          status: 'error',
          error: 'ffmpeg failed',
        },
      },
    }

    expect(notebookCellExecutionObservation(document, 'cell')).toEqual({
      error: 'ffmpeg failed',
      status: 'error',
    })
    expect(notebookCellExecutionObservation(document, 'missing')).toEqual({
      error: null,
      status: null,
    })
  })

  it('uses operation-aware action copy in the inspector', () => {
    expect(notebookCellInspectorActionLabel('extract_audio', 'Re-run')).toBe('Extract again')
    expect(notebookCellInspectorActionLabel('extract_frame', 'Run')).toBe('Extract')
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

  it('formats video dimensions as stable display aspect ratios', () => {
    expect(formatMediaAspectRatio(1920, 1080)).toBe('16:9')
    expect(formatMediaAspectRatio(768, 1344)).toBe('9:16')
    expect(formatMediaAspectRatio(1000, 700)).toBe('10:7')
    expect(formatMediaAspectRatio(0, 1080)).toBeNull()
  })

  it('keeps prompt captions off video output cards', () => {
    expect(notebookCellMediaCaption({
      type: 'video',
      hasMedia: true,
      prompt: 'Prompt with @artifact-id',
      tool: 'MINIMAX-H3/R2V',
      model: 'MINIMAX-H3/R2V',
    })).toBeNull()
    expect(notebookCellMediaCaption({
      type: 'image',
      hasMedia: true,
      prompt: 'Image prompt',
      tool: null,
      model: null,
    })).toEqual({
      prompt: 'Image prompt',
      tool: null,
      model: null,
    })
  })

  it('presents the active output as the latest unique saved version', () => {
    expect(notebookOutputVersionArtifactIds({
      outputVersionArtifactIds: ['audio-one', 'audio-two', 'audio-two', null],
    }, 'audio-three')).toEqual([
      'audio-one',
      'audio-two',
      'audio-three',
    ])
    expect(notebookOutputVersionArtifactIds(undefined, 'audio-current')).toEqual([
      'audio-current',
    ])
  })
})
