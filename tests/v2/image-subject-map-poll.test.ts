import { describe, expect, it } from 'vitest'
import {
  pollImageSubjectMap,
  type ImageSubjectMapPollResult,
} from '../../src/videobook/image-subject-map-poll'
import type {
  ImageSubjectMap,
  ImageSubjectMapStatus,
} from '../../src/videobook/image-subject-map'

function subjectMap(
  status: ImageSubjectMapStatus,
  startedAt: string | null,
): ImageSubjectMap {
  return {
    status,
    artifactId: 'image-artifact',
    objectHash: 'sha256:image',
    width: 1200,
    height: 800,
    baseUrl: null,
    jobId: 'subject-job',
    startedAt,
    error: null,
    subjects: [],
  }
}

describe('pollImageSubjectMap', () => {
  it('uses the persisted analysis start for one absolute timeout', async () => {
    let now = 10_000
    const published: ImageSubjectMap[] = []
    const waits: number[] = []
    const analyzing = subjectMap('analyzing', new Date(9_500).toISOString())

    const result = await pollImageSubjectMap({
      initialMap: analyzing,
      read: async () => analyzing,
      publish: (map) => published.push(map),
      isCurrent: () => true,
      now: () => now,
      wait: async (milliseconds) => {
        waits.push(milliseconds)
        now += milliseconds
      },
      intervalMs: 50,
      timeoutMs: 600,
    })

    expect(result).toEqual({ kind: 'timeout', map: analyzing })
    expect(waits).toEqual([50, 50])
    expect(published).toEqual([analyzing])
  })

  it('starts the timeout window now when the server start is missing', async () => {
    let now = 20_000
    const waits: number[] = []
    const analyzing = subjectMap('analyzing', null)

    const result = await pollImageSubjectMap({
      initialMap: analyzing,
      read: async () => analyzing,
      publish: () => undefined,
      isCurrent: () => true,
      now: () => now,
      wait: async (milliseconds) => {
        waits.push(milliseconds)
        now += milliseconds
      },
      intervalMs: 60,
      timeoutMs: 100,
    })

    expect(result).toEqual({ kind: 'timeout', map: analyzing })
    expect(waits).toEqual([60, 40])
  })

  it('discards a terminal response after request invalidation', async () => {
    let current = true
    const published: ImageSubjectMap[] = []
    const analyzing = subjectMap('analyzing', null)
    const ready = subjectMap('ready', null)

    const result = await pollImageSubjectMap({
      initialMap: analyzing,
      read: async () => {
        current = false
        return ready
      },
      publish: (map) => published.push(map),
      isCurrent: () => current,
      now: () => 1,
      wait: async () => undefined,
      intervalMs: 1,
      timeoutMs: 100,
    })

    expect(result).toEqual({ kind: 'stale' })
    expect(published).toEqual([])
  })

  it('publishes and returns a current terminal map', async () => {
    let now = 0
    const published: ImageSubjectMap[] = []
    const ready = subjectMap('ready', null)

    const result = await pollImageSubjectMap({
      initialMap: subjectMap('analyzing', null),
      read: async () => ready,
      publish: (map) => published.push(map),
      isCurrent: () => true,
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds
      },
      intervalMs: 1,
      timeoutMs: 100,
    })

    expect(result).toEqual({ kind: 'terminal', map: ready })
    expect(published).toEqual([ready])
  })

  it('returns a read error with the latest analyzing map', async () => {
    let now = 0
    const failure = new Error('subject map unavailable')
    const analyzing = subjectMap('analyzing', null)

    const result: ImageSubjectMapPollResult = await pollImageSubjectMap({
      initialMap: analyzing,
      read: async () => {
        throw failure
      },
      publish: () => undefined,
      isCurrent: () => true,
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds
      },
      intervalMs: 1,
      timeoutMs: 100,
    })

    expect(result).toEqual({ kind: 'error', map: analyzing, error: failure })
  })
})
