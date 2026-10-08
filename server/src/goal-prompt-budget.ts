export const GOAL_PROMPT_BUDGET = { title: 6, continuity: 30, frame: 20, storyboard: 32, ending: 12, video: 12 } as const;

export function goalPromptWords(value: string): number {
  return value.trim().split(/\s+/u).filter(Boolean).length;
}
