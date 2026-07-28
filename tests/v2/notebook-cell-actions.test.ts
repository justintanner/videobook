import { describe, expect, it } from 'vitest'
import { startNotebookCellRun } from '../../src/videobook/notebook-cell-actions'

describe('notebook cell run actions', () => {
  it('starts presentation before waiting for server acceptance', async () => {
    const events: string[] = []
    let accept: ((value: string) => void) | undefined
    const result = startNotebookCellRun({
      start: () => new Promise<string>((resolve) => {
        events.push('request')
        accept = resolve
      }),
      onStarting: () => events.push('starting'),
      onAccepted: () => events.push('accepted'),
    })

    expect(events).toEqual(['starting', 'request'])
    accept?.('run-id')
    await expect(result).resolves.toBe('run-id')
    expect(events).toEqual(['starting', 'request', 'accepted'])
  })

  it('clears starting presentation when the request is rejected', async () => {
    const events: string[] = []
    const result = startNotebookCellRun({
      start: async () => {
        throw new Error('offline')
      },
      onStarting: () => events.push('starting'),
      onRejected: () => events.push('rejected'),
    })

    await expect(result).rejects.toThrow('offline')
    expect(events).toEqual(['starting', 'rejected'])
  })
})
