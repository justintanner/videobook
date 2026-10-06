import { describe, expect, it } from 'vitest'
import {
  generatingTimeline,
  generationPayloadSentPrompt,
  generationPayloadSettings,
  parseGenerationRequestInspection,
} from './generation-request-inspection'

const geminiOmniPayload = {
  model: 'gemini-omni-video',
  input: {
    prompt: 'Subject image <image 1>. Motion video <video 1>.',
    image_urls: ['https://tempfile.example/portrait.png'],
    video_list: [{ url: 'https://tempfile.example/ref.mp4', start: 0, ends: 5 }],
    duration: '8',
    aspect_ratio: '16:9',
    resolution: '720p',
    seed: 42,
  },
}

describe('parseGenerationRequestInspection', () => {
  it('reads the payload, task type, and pending task', () => {
    expect(parseGenerationRequestInspection({
      payload: geminiOmniPayload,
      meta: { prompt: 'x' },
      error: null,
      taskType: 'gemini_omni_video',
      task: {
        taskId: 'task-1',
        submittedAt: '2026-10-06T12:00:00.000Z',
        completing: false,
      },
    })).toEqual({
      payload: geminiOmniPayload,
      taskType: 'gemini_omni_video',
      task: {
        taskId: 'task-1',
        submittedAt: '2026-10-06T12:00:00.000Z',
        completing: false,
      },
      errorMessage: null,
    })
  })

  it('tolerates responses from servers without task details', () => {
    expect(parseGenerationRequestInspection({
      payload: null,
      error: { message: 'Provider rejected the request' },
    })).toEqual({
      payload: null,
      taskType: null,
      task: null,
      errorMessage: 'Provider rejected the request',
    })
  })
})

describe('generationPayloadSentPrompt', () => {
  it('reads a nested input prompt', () => {
    expect(generationPayloadSentPrompt(geminiOmniPayload))
      .toBe('Subject image <image 1>. Motion video <video 1>.')
  })

  it('reads a flat prompt', () => {
    expect(generationPayloadSentPrompt({ prompt: 'flat', model: 'veo3' }))
      .toBe('flat')
  })

  it('returns null without a prompt', () => {
    expect(generationPayloadSentPrompt(null)).toBeNull()
  })
})

describe('generationPayloadSettings', () => {
  it('lists scalar settings and skips prompts, urls, and lists', () => {
    expect(generationPayloadSettings(geminiOmniPayload)).toEqual([
      { key: 'duration', value: '8' },
      { key: 'aspect_ratio', value: '16:9' },
      { key: 'resolution', value: '720p' },
      { key: 'seed', value: '42' },
    ])
  })

  it('reads flat payloads without echoing the model', () => {
    expect(generationPayloadSettings({
      model: 'veo3',
      prompt: 'x',
      aspectRatio: '9:16',
      enableTranslation: false,
      callBackUrl: 'https://example.com/hook',
    })).toEqual([
      { key: 'aspectRatio', value: '9:16' },
      { key: 'enableTranslation', value: 'false' },
    ])
  })
})

describe('generatingTimeline', () => {
  const task = {
    taskId: 'task-1',
    submittedAt: '2026-10-06T12:00:05.000Z',
    completing: false,
  }
  const statuses = (input: Parameters<typeof generatingTimeline>[0]) =>
    generatingTimeline(input).map((step) => step.status)

  it('waits on the run while queued', () => {
    expect(statuses({ runKind: 'queued', startedAt: null, task: null }))
      .toEqual(['active', 'pending', 'pending', 'pending'])
  })

  it('waits on submission until the provider task exists', () => {
    expect(statuses({
      runKind: 'generating',
      startedAt: '2026-10-06T12:00:00.000Z',
      task: null,
    })).toEqual(['done', 'active', 'pending', 'pending'])
  })

  it('tracks provider work and its submit time', () => {
    const steps = generatingTimeline({
      runKind: 'generating',
      startedAt: '2026-10-06T12:00:00.000Z',
      task,
    })
    expect(steps.map((step) => step.status))
      .toEqual(['done', 'done', 'active', 'pending'])
    expect(steps[1]?.at).toBe(task.submittedAt)
  })

  it('moves to download once the task is completing', () => {
    expect(statuses({
      runKind: 'generating',
      startedAt: null,
      task: { ...task, completing: true },
    })).toEqual(['done', 'done', 'done', 'active'])
  })

  it('marks the step that was running when the run failed', () => {
    expect(statuses({ runKind: 'failed', startedAt: null, task }))
      .toEqual(['done', 'done', 'failed', 'pending'])
  })
})
