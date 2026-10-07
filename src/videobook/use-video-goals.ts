import { useCallback, useState } from 'react'
import { asGoal, asGoals, type GoalSnapshot } from './goals'
import { jsonEqual } from './notebook-canvas'
import type { ChatExecution } from './chat-turns'

type GoalToolCall = (
  tool: string,
  args: Record<string, unknown>,
  options?: { background?: boolean; chat?: ChatExecution },
) => Promise<unknown>

export type GoalScope = { bookId: string; notebookId: string }

type GoalListState = { key: string; goals: GoalSnapshot[] }

const NO_GOALS: GoalSnapshot[] = []

function goalScopeKey(scope: GoalScope | null): string {
  return scope ? `${scope.bookId}:${scope.notebookId}` : ''
}

function upsertGoal(goals: GoalSnapshot[], goal: GoalSnapshot): GoalSnapshot[] {
  return goals.some((entry) => entry.goalId === goal.goalId)
    ? goals.map((entry) => entry.goalId === goal.goalId ? goal : entry)
    : [goal, ...goals]
}

export function useVideoGoals(call: GoalToolCall, scope: GoalScope | null) {
  const [state, setState] = useState<GoalListState>({ key: '', goals: NO_GOALS })
  const key = goalScopeKey(scope)
  const goals = state.key === key ? state.goals : NO_GOALS

  const accept = useCallback((target: GoalScope, value: unknown) => {
    const next = asGoals(value)
    const targetKey = goalScopeKey(target)
    setState((current) => current.key === targetKey && jsonEqual(current.goals, next)
      ? current
      : { key: targetKey, goals: next })
  }, [])

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
    setState((current) => current.key === targetKey || current.key === ''
      ? { key: targetKey, goals: upsertGoal(current.key === targetKey ? current.goals : NO_GOALS, goal) }
      : current)
    return goal
  }, [call])

  return { goals, accept, refresh, act }
}
