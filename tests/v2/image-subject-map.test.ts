import { describe, expect, it } from 'vitest'
import { asImageSubjectMap } from '../../src/videobook/image-subject-map'

describe('asImageSubjectMap', () => {
  it('prefers nested subject-map status and decodes snake-case start time', () => {
    const startedAt = '2026-08-17T07:00:00.000Z'
    const result = asImageSubjectMap({
      status: 'failed',
      subject_map: {
        status: 'analyzing',
        artifact_id: 'image-artifact',
        object_hash: 'sha256:image',
        job_id: 'subject-job',
        started_at: startedAt,
      },
    })

    expect(result.status).toBe('analyzing')
    expect(result.startedAt).toBe(startedAt)
    expect(result.jobId).toBe('subject-job')
  })

  it('decodes camel-case start time', () => {
    const startedAt = '2026-08-17T07:01:00.000Z'
    const result = asImageSubjectMap({
      subjectMap: {
        status: 'analyzing',
        startedAt,
      },
    })

    expect(result.startedAt).toBe(startedAt)
  })

  it('infers a failed map from a nonempty error', () => {
    const result = asImageSubjectMap({
      artifact_id: 'image-artifact',
      error: 'Seedream decomposition stopped',
    })

    expect(result.status).toBe('failed')
    expect(result.error).toBe('Seedream decomposition stopped')
  })
})
