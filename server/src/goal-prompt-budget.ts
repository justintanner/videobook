export const GOAL_PROMPT_BUDGET = { title: 8, continuity: 80, frame: 50, storyboard: 40, ending: 30, video: 50 } as const;

export function goalPromptWords(value: string): number {
  return value.trim().split(/\s+/u).filter(Boolean).length;
}
