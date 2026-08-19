type ComposerInputOutcome = {
  ok: boolean
  nextInput?: string
  selectInput?: boolean
}

type ComposerInputDecision = {
  value: string
  select: boolean
}

type PendingApplyCommand = {
  promptOverride: string | null
}

export function parsePendingApplyCommand(input: string): PendingApplyCommand | null {
  const match = input.match(/^\s*\/apply(?:\s+([\s\S]*?))?\s*$/iu)
  if (!match) return null
  const promptOverride = match[1]?.trim() ?? ''
  return { promptOverride: promptOverride || null }
}

export function composerInputAfterOutcome(
  outcome: ComposerInputOutcome,
  pendingInput?: string,
): ComposerInputDecision | null {
  const value = outcome.nextInput
    ?? (!outcome.ok ? pendingInput : undefined)
  if (value === undefined) return null
  return {
    value,
    select: outcome.selectInput ?? !outcome.ok,
  }
}
