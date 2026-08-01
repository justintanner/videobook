export function hasExactCommandSuggestion(
  input: string,
  suggestions: readonly { label: string }[],
): boolean {
  const value = input.trim()
  return suggestions.some((suggestion) => suggestion.label === value)
}

export function commandSuggestionCandidates<T extends { command: string }>(
  commands: readonly T[],
  filter: string,
  limit = 12,
): T[] {
  const normalized = filter.toLowerCase()
  const matches = commands.filter((command) =>
    command.command.slice(1).toLowerCase().includes(normalized))
  if (normalized || matches.length <= limit) return matches.slice(0, limit)
  const download = matches.find((command) => command.command === '/download')
  if (!download) return matches.slice(0, limit)
  return [
    download,
    ...matches.filter((command) => command !== download),
  ].slice(0, limit)
}
