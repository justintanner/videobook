export function hasExactCommandSuggestion(
  input: string,
  suggestions: readonly { label: string; aliases?: readonly string[] }[],
): boolean {
  const value = input.trim().toLowerCase()
  return suggestions.some((suggestion) => [suggestion.label, ...(suggestion.aliases ?? [])].some((name) => name.toLowerCase() === value))
}

export { isSpeakCommandPreview } from './speak-preview'

export function commandSuggestionCandidates<T extends { command: string; aliases?: readonly string[]; description?: string }>(
  commands: readonly T[],
  filter: string,
  limit = Number.POSITIVE_INFINITY,
): T[] {
  const normalized = filter.toLowerCase()
  const matches = commands.filter((command) => [command.command, ...(command.aliases ?? []), command.description ?? '']
    .join(' ').toLowerCase().includes(normalized)).sort((left, right) => {
      const exact = (command: T) => [command.command, ...(command.aliases ?? [])].some((name) => name.slice(1).toLowerCase() === normalized)
      return Number(exact(right)) - Number(exact(left))
    })
  if (normalized) return matches.slice(0, limit)
  const download = matches.find((command) => command.command === '/download')
  if (!download) return matches.slice(0, limit)
  return [
    download,
    ...matches.filter((command) => command !== download),
  ].slice(0, limit)
}
