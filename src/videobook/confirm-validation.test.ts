import { describe, expect, it } from 'vitest'
import {
  commandPlanValidation,
  confirmSheetStatus,
  generationValidation,
  splitValidation,
  VALID_CONFIRMATION,
  watermarkValidation,
  xPostValidation,
  type WatermarkValidationInput,
} from './confirm-validation'

function watermark(overrides: Partial<WatermarkValidationInput> = {}): WatermarkValidationInput {
  return {
    includeHandle: true,
    includeQr: true,
    handle: '@catsleep',
    url: '',
    durationSeconds: 26,
    qrStartSeconds: 0,
    qrEndSeconds: null,
    handleStartSeconds: 0,
    handleEndSeconds: null,
    ...overrides,
  }
}

describe('watermark validation', () => {
  it('accepts a handle-backed QR with whole-clip timing', () => {
    expect(watermarkValidation(watermark())).toEqual(VALID_CONFIRMATION)
  })

  it('names the missing handle and the way out', () => {
    expect(watermarkValidation(watermark({ handle: ' @ ' })).blocking)
      .toBe('Include handle is on but no handle is set. Type a handle, or turn Include handle off.')
  })

  it('needs something for the QR to link to', () => {
    expect(watermarkValidation(watermark({ includeHandle: false, handle: '' })).blocking)
      .toContain('nothing to link')
    expect(watermarkValidation(watermark({ includeHandle: false, handle: '', url: 'https://x.com/a' })))
      .toEqual(VALID_CONFIRMATION)
  })

  it('requires at least one badge', () => {
    expect(watermarkValidation(watermark({ includeHandle: false, includeQr: false })).blocking)
      .toBe('Include a handle, a QR code, or both.')
  })

  it('checks the timing of whichever badges are on', () => {
    expect(watermarkValidation(watermark({ qrStartSeconds: 4, qrEndSeconds: 2 })).blocking)
      .toBe('QR end time must be after its start time.')
    expect(watermarkValidation(watermark({ handleStartSeconds: 30, handleEndSeconds: null })).blocking)
      .toBe('Handle end time must be after its start time.')
    expect(watermarkValidation(watermark({
      includeQr: false,
      qrStartSeconds: 4,
      qrEndSeconds: 2,
    }))).toEqual(VALID_CONFIRMATION)
  })
})

describe('generation validation', () => {
  const base = {
    prompt: 'a cat',
    previewLoading: false,
    previewError: null,
    previewStale: false,
    promptLeaks: [],
    estimateUnknown: false,
  }

  it('blocks on an empty prompt, a loading or failed preview, and prompt leaks', () => {
    expect(generationValidation({ ...base, prompt: '  ' }).blocking).toBe('Write a prompt before applying.')
    expect(generationValidation({ ...base, previewLoading: true }).blocking).toBe('Waiting for the server preview.')
    expect(generationValidation({ ...base, previewError: 'model offline' }).blocking)
      .toBe('Preview failed — model offline')
    expect(generationValidation({
      ...base,
      promptLeaks: [
        { token: '@e2', message: '@e2 does not have media output yet' },
        { token: '@e3', message: '@e3 is empty' },
      ],
    }).blocking).toBe('@e2 does not have media output yet (+1 more). Add it with Add input, or remove the mention.')
  })

  it('allows server revalidation while automatically refreshing an edited draft', () => {
    const validation = generationValidation({
      ...base,
      previewStale: true,
      previewLoading: true,
      promptLeaks: [{ token: '@e2', message: 'stale' }],
    })
    expect(validation.blocking).toBeNull()
    expect(validation.notice).toBeNull()
  })

  it('mentions an unknown estimate without blocking', () => {
    expect(generationValidation({ ...base, estimateUnknown: true })).toEqual({
      blocking: null,
      notice: 'No cost estimate is available for this model.',
    })
    expect(generationValidation(base)).toEqual(VALID_CONFIRMATION)
    expect(generationValidation({ ...base, previewStale: true, settingsError: 'Resume original must be after Replace from.' }).blocking)
      .toBe('Resume original must be after Replace from.')
  })
})

describe('split validation', () => {
  it('counts the notebook cells a split needs', () => {
    expect(splitValidation({
      availableEmptyCells: 4,
      cutPointsSeconds: [2, 5.5],
      outputMode: 'all',
      sourceDurationSeconds: 26,
    })).toEqual(VALID_CONFIRMATION)
    expect(splitValidation({
      availableEmptyCells: 3,
      cutPointsSeconds: [2, 5.5],
      outputMode: 'all',
      sourceDurationSeconds: 26,
    }).blocking).toBe('This split needs 4 empty notebook cells; 3 available.')
  })

  it('refuses to remove the only piece', () => {
    expect(splitValidation({
      availableEmptyCells: 9,
      cutPointsSeconds: [],
      outputMode: 'remove',
      sourceDurationSeconds: 26,
    }).blocking).toBe('Removing a piece needs at least two pieces. Add a cut first.')
  })
})

describe('command plan validation', () => {
  it('blocks when every suggestion is excluded or a preview conflicts', () => {
    expect(commandPlanValidation({
      suggestions: [{ included: false }, { included: false }],
      previews: [],
    }).blocking).toBe('Include at least one suggestion, or cancel.')
    expect(commandPlanValidation({
      suggestions: undefined,
      previews: [{ valid: false, warnings: [], conflicts: [{ message: 'Clip moved' }] }],
    }).blocking).toBe('Clip moved')
    expect(commandPlanValidation({
      suggestions: undefined,
      previews: [{ valid: false, warnings: [], conflicts: [] }],
    }).blocking).toContain('no longer fits')
  })

  it('surfaces warnings as a notice', () => {
    expect(commandPlanValidation({
      suggestions: [{ included: true }],
      previews: [
        { valid: true, warnings: [{ message: 'Removes dialogue' }], conflicts: [] },
        { valid: true, warnings: [{ message: 'Long render' }], conflicts: [] },
      ],
    })).toEqual({ blocking: null, notice: 'Removes dialogue (+1 more)' })
  })
})

describe('x post validation', () => {
  it('wraps the draft error', () => {
    expect(xPostValidation({
      postText: 'x'.repeat(281),
      scheduledFor: null,
      orientation: null,
      followups: [],
    }).blocking)
      .toBe('Title is 1 character too long.')
    expect(xPostValidation({
      postText: 'ok',
      scheduledFor: null,
      orientation: null,
      followups: [],
    }))
      .toEqual(VALID_CONFIRMATION)
    // A Premium account's limit is passed through to the draft check.
    expect(xPostValidation({
      postText: 'x'.repeat(281),
      scheduledFor: null,
      orientation: null,
      followups: [{ text: 'p'.repeat(3_320), imageAssetIds: [] }],
    }, undefined, 25_000))
      .toEqual(VALID_CONFIRMATION)
    expect(xPostValidation({
      postText: 'ok',
      scheduledFor: null,
      orientation: null,
      followups: [{ text: 'p'.repeat(25_001), imageAssetIds: [] }],
    }, undefined, 25_000).blocking)
      .toBe('Follow-up 1 is 1 character too long.')
  })
})

describe('confirm sheet status', () => {
  const base = {
    busy: false,
    busyLabel: 'Applying…',
    validation: VALID_CONFIRMATION,
    outcome: null,
    notice: null,
  }

  it('orders busy, blocking, failed, notice, info, ready', () => {
    expect(confirmSheetStatus({
      ...base,
      busy: true,
      validation: { blocking: 'x', notice: null },
      outcome: { ok: false, message: 'boom' },
    })).toEqual({ state: 'busy', message: 'Applying…', dismissible: false })
    expect(confirmSheetStatus({
      ...base,
      validation: { blocking: 'Fix the handle', notice: null },
      outcome: { ok: false, message: 'boom' },
    })).toEqual({ state: 'blocking', message: 'Fix the handle', dismissible: false })
    expect(confirmSheetStatus({
      ...base,
      validation: { blocking: null, notice: 'stale' },
      outcome: { ok: false, message: 'ffmpeg exited 1' },
    })).toEqual({ state: 'failed', message: 'ffmpeg exited 1', dismissible: true })
    expect(confirmSheetStatus({
      ...base,
      notice: { message: 'Server refused', tone: 'error' },
    })).toEqual({ state: 'failed', message: 'Server refused', dismissible: true })
    expect(confirmSheetStatus({
      ...base,
      validation: { blocking: null, notice: 'stale' },
      outcome: { ok: true, message: 'Ready to review' },
    })).toEqual({ state: 'notice', message: 'stale', dismissible: false })
    expect(confirmSheetStatus({
      ...base,
      outcome: { ok: true, message: 'Ready to review' },
    })).toEqual({ state: 'info', message: 'Ready to review', dismissible: true })
    expect(confirmSheetStatus({
      ...base,
      notice: { message: 'Preview refreshed', tone: 'info' },
    })).toEqual({ state: 'info', message: 'Preview refreshed', dismissible: true })
    expect(confirmSheetStatus(base)).toEqual({ state: 'ready', message: null, dismissible: false })
  })
})
