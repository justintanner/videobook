export function parseNotebookGenerationCellCommand(
  input: string,
): string | null {
  const match = input.match(
    /^\s*(?:please\s+)?(?:generate|run)\s+(?:(?:the\s+)?cell\s+@?|@)([a-z0-9-]+)\s*[.!]?\s*$/iu,
  )
  return match?.[1].toLowerCase() ?? null
}
