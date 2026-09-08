import { describe, expect, it } from 'vitest'
import {
  clearReferencesConfirmation,
  forgetConfirmation,
  forgetReferenceSummary,
  formatReclaimedBytes,
  forgottenNotice,
  type ForgetAssetOutcome,
} from './forget-asset'

function outcome(patch: Partial<ForgetAssetOutcome> = {}): ForgetAssetOutcome {
  return {
    status: 'forgotten',
    artifactId: '01a04dfc-9293-717a-adfd-e87be682f3e9',
    label: null,
    references: [],
    clearedCells: 0,
    forgottenObjects: 1,
    sharedObjects: 0,
    reclaimedBytes: 0,
    ...patch,
  }
}

describe('forgetReferenceSummary', () => {
  it('counts each kind in a readable order', () => {
    expect(forgetReferenceSummary([
      { kind: 'sequenceClip', id: 'clip-1' },
      { kind: 'cell.outputArtifact', id: 'n/1' },
      { kind: 'cell.outputArtifact', id: 'n/2' },
    ])).toBe('2 notebook cells and 1 sequence clip')
  })

  it('reads three kinds as a list', () => {
    expect(forgetReferenceSummary([
      { kind: 'cell.outputArtifact', id: 'n/1' },
      { kind: 'cell.reference', id: 'n/2/r' },
      { kind: 'pinnedSearchResult', id: 'n/3/p' },
    ])).toBe('1 notebook cell, 1 cell reference and 1 pinned result')
  })

  it('passes through a kind the client has not seen', () => {
    expect(forgetReferenceSummary([{ kind: 'futureThing', id: 'x' }]))
      .toBe('1 futureThing')
  })

  it('never claims nothing holds the asset', () => {
    expect(forgetReferenceSummary([])).toBe('something else in this book')
  })
})

describe('formatReclaimedBytes', () => {
  it('scales to the nearest unit', () => {
    expect(formatReclaimedBytes(0)).toBe('0 B')
    expect(formatReclaimedBytes(-1)).toBe('0 B')
    expect(formatReclaimedBytes(512)).toBe('512 B')
    expect(formatReclaimedBytes(2048)).toBe('2 KB')
    expect(formatReclaimedBytes(1024 * 1024 * 12.4)).toBe('12.4 MB')
    expect(formatReclaimedBytes(1024 ** 3 * 2.5)).toBe('2.5 GB')
  })
})

describe('forgottenNotice', () => {
  it('reports what the delete reclaimed', () => {
    expect(forgottenNotice('@a1', outcome({ reclaimedBytes: 1024 * 1024 })))
      .toBe('Forgot @a1 · 1 MB reclaimed')
  })

  it('says when bytes stayed for another asset', () => {
    expect(forgottenNotice('@a1', outcome({
      forgottenObjects: 0,
      sharedObjects: 2,
    }))).toBe('Forgot @a1 · 2 files kept for another asset')
  })

  it('mentions cleared cells', () => {
    expect(forgottenNotice('@a1', outcome({
      reclaimedBytes: 2048,
      clearedCells: 1,
    }))).toBe('Forgot @a1 · 2 KB reclaimed · cleared 1 cell')
  })

  it('stays plain when there is nothing to add', () => {
    expect(forgottenNotice('@a1', outcome())).toBe('Forgot @a1')
  })
})

describe('confirmations', () => {
  it('says the delete is permanent', () => {
    const message = forgetConfirmation('@a1')
    expect(message).toContain('Forget @a1?')
    expect(message).toContain('destroys its stored content')
    expect(message).toContain('cannot be undone')
  })

  it('names what still holds the asset', () => {
    expect(clearReferencesConfirmation('@a1', [
      { kind: 'cell.outputArtifact', id: 'n/1' },
    ])).toContain('@a1 is still used by 1 notebook cell')
  })
})
