import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { nextHistorySequence } from './history-sequence'
import {
  chatResultWork,
  chatTurnActive,
  mergeChatWork,
  observeChatWork,
  settleChatTurn,
  type ChatExecution,
  type ChatJob,
  type ChatTurn,
} from './chat-turns'
import type { NotebookDocument } from 'videobook-engine'

export function useChatTurns(bookId: string, notebookId: string | null) {
  const [turns, setTurns] = useState<readonly ChatTurn[]>([])
  const turnsRef = useRef(turns)
  const scopeRef = useRef({ bookId, notebookId })
  const scopeVersionRef = useRef(0)
  const executions = useRef(new Map<number, ChatExecution>())
  const latestRef = useRef<number | null>(null)
  const reviewRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    scopeRef.current = { bookId, notebookId }
    scopeVersionRef.current += 1
    latestRef.current = turnsRef.current.filter(turn => turn.bookId === bookId && turn.notebookId === notebookId).at(-1)?.id ?? null
    reviewRef.current = null
  }, [bookId, notebookId])

  const update = useCallback((change: (current: readonly ChatTurn[]) => readonly ChatTurn[]) => {
    const next = change(turnsRef.current)
    if (JSON.stringify(next) === JSON.stringify(turnsRef.current)) return
    turnsRef.current = next
    setTurns(next)
  }, [])

  const begin = useCallback((text: string): ChatExecution => {
    const pending = reviewRef.current === null ? undefined : executions.current.get(reviewRef.current)
    if (/^\/(?:apply|cancel)(?:\s|$)/iu.test(text) && pending?.isInScope()) {
      update(turns => turns.map(turn => turn.id === pending.id ? { ...turn, status: 'working', executing: true } : turn))
      return pending
    }
    const scope = { ...scopeRef.current }
    const scopeVersion = scopeVersionRef.current
    const id = nextHistorySequence()
    latestRef.current = id
    reviewRef.current = null
    update(turns => [...turns.map(turn => turn.bookId === scope.bookId && turn.notebookId === scope.notebookId && turn.status === 'review'
      ? { ...turn, status: 'cancelled' as const } : turn), {
      id, ...scope, text, status: 'sending' as const, reply: '', work: [], executing: true,
    }].filter((turn, index, all) => index >= all.length - 256 || chatTurnActive(turn)))
    const change = (fn: (turn: ChatTurn) => ChatTurn) => update(turns => turns.map(turn => turn.id === id ? fn(turn) : turn))
    const isInScope = () => scopeVersionRef.current === scopeVersion && scopeRef.current.bookId === scope.bookId && scopeRef.current.notebookId === scope.notebookId
    const execution: ChatExecution = {
      id,
      isInScope,
      isCurrent: () => isInScope() && latestRef.current === id && turnsRef.current.find(turn => turn.id === id)?.status !== 'cancelled',
      working: () => change(turn => ({ ...turn, status: 'working' })),
      review: open => {
        if (open && execution.isCurrent()) reviewRef.current = id
        else if (reviewRef.current === id) reviewRef.current = null
        change(turn => ({ ...turn, status: open ? 'review' : 'working' }))
      },
      accept: (tool, args, value) => {
        const work = chatResultWork(tool, args, value)
        if (work.length) change(turn => settleChatTurn({ ...turn, work: mergeChatWork(turn.work, work) }))
      },
      finish: outcome => change(turn => turn.status === 'cancelled' ? turn : settleChatTurn({
        ...turn,
        reply: outcome.message,
        executing: false,
        status: outcome.status ?? (reviewRef.current === id ? 'review' : !outcome.ok ? 'failed' : 'completed'),
      })),
    }
    executions.current.set(id, execution)
    for (const key of executions.current.keys()) {
      if (!turnsRef.current.some(turn => turn.id === key)) executions.current.delete(key)
    }
    return execution
  }, [update])

  const claimVoice = useCallback((): ChatExecution => {
    const id = nextHistorySequence()
    const scopeVersion = scopeVersionRef.current
    latestRef.current = id
    let cancelled = false
    for (const [key, value] of executions.current) {
      if (value.visible === false && key !== reviewRef.current) executions.current.delete(key)
    }
    const execution: ChatExecution = {
      id, visible: false,
      isInScope: () => scopeVersionRef.current === scopeVersion,
      isCurrent: () => !cancelled && scopeVersionRef.current === scopeVersion && latestRef.current === id,
      working: () => undefined,
      accept: () => undefined,
      finish: outcome => { if (outcome.status === 'cancelled') cancelled = true },
      review: open => {
        if (open && execution.isCurrent()) reviewRef.current = id
        else if (reviewRef.current === id) reviewRef.current = null
      },
    }
    executions.current.set(id, execution)
    return execution
  }, [])

  const observe = useCallback((
    targetBookId: string,
    jobs: readonly ChatJob[],
    notebook?: NotebookDocument,
    assets?: readonly { artifactId: string; status: string; mediaUrl: string | null }[],
  ) => {
    update(turns => turns.map(turn => turn.bookId === targetBookId && (!notebook || turn.notebookId === notebook.id) && chatTurnActive(turn)
      ? observeChatWork(turn, jobs, notebook, assets) : turn))
  }, [update])

  const cancelReview = useCallback(() => {
    const id = reviewRef.current
    reviewRef.current = null
    if (id !== null) executions.current.get(id)?.finish({ ok: true, status: 'cancelled', message: 'Pending action cancelled.' })
    if (id !== null) update(turns => turns.map(turn => turn.id === id ? { ...turn, status: 'cancelled' } : turn))
  }, [update])

  return {
    turns: turns.filter(turn => turn.bookId === bookId && turn.notebookId === notebookId),
    begin,
    observe,
    cancelReview,
    claimVoice,
  }
}
