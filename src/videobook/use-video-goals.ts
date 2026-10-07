import { useCallback, useRef, useState } from 'react'
import { asGoal, asGoals, goalStatusLine, goalWake, type GoalSnapshot } from './goals'
import { jsonEqual } from './notebook-canvas'
import type { ChatExecution } from './chat-turns'
import { COMPOSER_HISTORY_CAP, type ComposerStatusRow } from './composer-history'
import { nextHistorySequence } from './history-sequence'

type GoalToolCall = (
  tool: string,
  args: Record<string, unknown>,
  options?: { background?: boolean; chat?: ChatExecution },
) => Promise<unknown>

export type GoalScope = { bookId: string, notebookId: string }

type GoalListState = { key: string, goals: GoalSnapshot[], events: ComposerStatusRow[] }

const NO_GOALS: GoalSnapshot[] = []
const NO_EVENTS: ComposerStatusRow[] = []

function goalScopeKey(scope: GoalScope | null): string {
  return scope ? `${scope.bookId}:${scope.notebookId}` : ''
}

function upsertGoal(goals: GoalSnapshot[], goal: GoalSnapshot): GoalSnapshot[] {
  return goals.some((entry) => entry.goalId === goal.goalId)
    ? goals.map((entry) => entry.goalId === goal.goalId ? goal : entry)
    : [goal, ...goals]
}

export function useVideoGoals(call: GoalToolCall, scope: GoalScope | null) {
  const [state, setState] = useState<GoalListState>({ key: '', goals: NO_GOALS, events: NO_EVENTS })
  const stateRef = useRef(state)
  const key = goalScopeKey(scope)
  const goals = state.key === key ? state.goals : NO_GOALS
  const events = state.key === key ? state.events : NO_EVENTS

  const update = useCallback((targetKey: string, incoming: GoalSnapshot[], created = false) => {
    const current = stateRef.current
    const previous = current.key === targetKey ? current.goals : NO_GOALS
    const next = incoming.map(goal => {
      const known = previous.find(entry => entry.goalId === goal.goalId)
      return known && known.updatedAt > goal.updatedAt ? known : goal
    })
    if (current.key === targetKey && jsonEqual(current.goals, next)) return
    const added = next.flatMap(goal => {
      const before = previous.find(entry => entry.goalId === goal.goalId)
      const wake = before ? goalWake(before, goal) : created && goal.status === 'review'
        ? { from: 'Plan ready' } : null
      if (!wake) return []
      return [{ kind: 'status' as const, sequence: nextHistorySequence(), goalId: goal.goalId,
        text: `Goal woke up · ${wake.from} · ${goalStatusLine(goal).text}${goal.address ? ` · ${goal.address}` : ''}` }]
    })
    const events = [...(current.key === targetKey ? current.events : NO_EVENTS), ...added].slice(-COMPOSER_HISTORY_CAP)
    const updated = { key: targetKey, goals: next, events }
    stateRef.current = updated
    setState(updated)
  }, [])

  const accept = useCallback((target: GoalScope, value: unknown) => {
    const next = asGoals(value)
    const targetKey = goalScopeKey(target)
    update(targetKey, next)
  }, [update])

  const refresh = useCallback(async (target: GoalScope) => {
    accept(target, await call('video_goal', {
      book_id: target.bookId,
      notebook_id: target.notebookId,
      action: 'list',
    }, { background: true }))
  }, [accept, call])

  const act = useCallback(async (
    target: GoalScope,
    args: Record<string, unknown>,
    chat?: ChatExecution,
  ) => {
    const goal = asGoal(await call('video_goal', {
      ...args,
      book_id: target.bookId,
      notebook_id: target.notebookId,
    }, chat ? { chat } : { background: true }))
    const targetKey = goalScopeKey(target)
    const current = stateRef.current
    if (current.key === targetKey || current.key === '') update(targetKey, upsertGoal(current.key === targetKey ? current.goals : NO_GOALS, goal), args.action === 'create')
    return goal
  }, [call, update])

  return { goals, events, accept, refresh, act }
}
