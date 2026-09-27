import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from 'videobook-engine'
import { describe, expect, it } from 'vitest'
import {
  chatResultWork,
  chatTurnLabel,
  observeChatWork,
  presentChat,
  reviewChat,
  type ChatExecution,
  type ChatTurn,
} from '../../src/videobook/chat-turns'
import { composerHistory } from '../../src/videobook/composer-history'
import { beginMcpCall, emptyMcpCallLog } from '../../src/videobook/mcp-activity'

function turn(id: number, text: string): ChatTurn {
  return { id, text, bookId: 'book', notebookId: null, status: 'working', reply: '', executing: false, work: [] }
}

describe('chat turns', () => {
  it('follows real persistent jobs through running, partial completion and failure without including unrelated jobs', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'videobook-chat-turns-'))
    const engine = createEngine({ rootDir, initialBookName: 'chat-turns' })
    try {
      const first = engine.jobs.queue.enqueue({ type: 'first-chat-action', initialState: 'running', payload: {} }).job
      const second = engine.jobs.queue.enqueue({ type: 'second-chat-action', initialState: 'running', payload: {}, maxAttempts: 1 }).job
      engine.jobs.queue.enqueue({ type: 'unrelated-action', initialState: 'running', payload: {} })
      let current: ChatTurn = {
        ...turn(1, 'Run both actions'),
        work: chatResultWork('chain', {}, { steps: [{ tool: 'first', child_job_ids: [first.id] }, { tool: 'second', child_job_ids: [second.id] }] }),
      }
      current = observeChatWork(current, engine.jobs.queue.list())
      expect(current.status).toBe('working')
      expect(current.work).toHaveLength(2)
      await engine.jobs.queue.complete(first.id, { result: {} })
      current = observeChatWork(current, engine.jobs.queue.list())
      expect(chatTurnLabel(current)).toBe('Working · 1 of 2 complete')
      expect(chatTurnLabel(current, false)).toBe('Reconnecting…')
      await engine.jobs.queue.fail(second.id, { error: { message: 'Conversion failed' }, allowRetry: false })
      current = observeChatWork(current, engine.jobs.queue.list())
      expect(current).toMatchObject({ status: 'failed', reply: 'Conversion failed' })
    } finally {
      await engine.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('waits for a notebook run output after the queue parent has completed', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'videobook-chat-run-'))
    const engine = createEngine({ rootDir, initialBookName: 'chat-run' })
    try {
      const created = await engine.notebooks.create('Chat')
      if (!created.ok) throw new Error(created.error.message)
      const notebook = created.value
      const job = engine.jobs.queue.enqueue({ type: 'run_notebook', initialState: 'running', payload: { runId: 'run-one' } }).job
      await engine.jobs.queue.complete(job.id, { result: {} })
      const current: ChatTurn = {
        ...turn(1, 'Generate'), notebookId: notebook.id,
        work: chatResultWork('run_notebook_cell', { cell_id: 'generation' }, { job_id: job.operationId, run_id: 'run-one' }),
      }
      const waiting = observeChatWork(current, engine.jobs.queue.list(), notebook)
      expect(waiting.status).toBe('working')
      const finished = observeChatWork(waiting, engine.jobs.queue.list(), {
        ...notebook, execution: { generation: { runId: 'run-one', status: 'completed' } },
      })
      expect(finished.status).toBe('completed')
    } finally {
      await engine.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('keeps an older active message and places its calls under that message', () => {
    const active = turn(1, 'Still running')
    const completed = { ...turn(3, 'Second request'), status: 'completed' as const }
    const latest = turn(5, 'Latest request')
    const calls = beginMcpCall(emptyMcpCallLog, { id: 2, turnId: active.id, tool: 'chat', args: [] })
    const rows = composerHistory([], calls, [active, completed, latest])
    expect(rows.map(row => row.sequence)).toEqual([1, 3, 5])
    expect(rows[0]).toMatchObject({ kind: 'caption', turn: active, calls: [{ id: 2 }] })
    expect(composerHistory([], calls, [{ ...active, status: 'completed' }, completed, latest]).map(row => row.sequence)).toEqual([3, 5])
  })

  it('rejects late preview and review updates while allowing current results', () => {
    let current = true
    const shown: string[] = []
    const execution: ChatExecution = {
      id: 1, isCurrent: () => current, isInScope: () => true,
      working: () => undefined, accept: () => undefined, finish: () => undefined,
      review: open => shown.push(`review:${open}`),
    }
    presentChat(execution, () => shown.push('newest preview'))
    current = false
    presentChat(execution, () => shown.push('old preview'))
    reviewChat(execution, true, () => shown.push('old review'))
    expect(shown).toEqual(['newest preview'])
  })
})
