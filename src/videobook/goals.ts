import type { GoalSnapshot } from '../../server/src/tools/goal'
import type { GoalPlan } from '../../server/src/goal-plan'

export function goalPlansEqual(left: GoalPlan, right: GoalPlan): boolean {
  return left.title === right.title && left.continuity === right.continuity
    && left.aspectRatio === right.aspectRatio && left.shots.length === right.shots.length
    && left.shots.every((shot, index) => shot.title === right.shots[index]?.title
      && shot.prompt === right.shots[index]?.prompt && shot.durationSeconds === right.shots[index]?.durationSeconds)
}

export function asGoal(value: unknown): GoalSnapshot {
  if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'video-goal') {
    throw new Error('The server returned an invalid video goal')
  }
  return value as GoalSnapshot
}

export function asGoals(value: unknown): GoalSnapshot[] {
  if (!value || typeof value !== 'object' || !('goals' in value) || !Array.isArray(value.goals)) {
    throw new Error('The server returned an invalid goal list')
  }
  return value.goals.map(asGoal)
}

export function goalStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    planning: 'Planning shots', review: 'Ready for review', running: 'Generating',
    completed: 'Complete', failed: 'Needs attention', interrupted: 'Interrupted',
    cancelled: 'Stopped', pending: 'Waiting', skipped: 'Not started', approved: 'Ready',
  }
  return labels[status] ?? status
}
