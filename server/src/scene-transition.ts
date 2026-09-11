export const MIN_TRANSITION_SECONDS = 0.05;

export function fixedTransitionSeconds(
  firstDuration: number,
  secondDuration: number,
  requested?: number,
): number {
  const available = Math.min(firstDuration, secondDuration);
  const transition = requested ?? Math.max(MIN_TRANSITION_SECONDS, Math.min(0.35, available / 2));
  if (!Number.isFinite(transition) || transition < MIN_TRANSITION_SECONDS) {
    throw new Error(`Transition must be at least ${MIN_TRANSITION_SECONDS} seconds`);
  }
  if (!Number.isFinite(available) || transition >= available) {
    throw new Error("Transition must be shorter than both video clips");
  }
  return transition;
}
