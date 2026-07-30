export function hasExactCommandSuggestion(
  input: string,
  suggestions: readonly { label: string }[],
): boolean {
  const value = input.trim()
  return suggestions.some((suggestion) => suggestion.label === value)
}
