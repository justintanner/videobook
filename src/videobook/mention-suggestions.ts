interface AssetMentionSuggestion {
  value: string
  label: string
  description: string
  type: 'asset'
}

export function assetMentionSuggestions(
  assetSlugs: string[],
  input: string,
): AssetMentionSuggestion[] {
  const match = input.match(/@([\w-]*)$/)
  if (!match) return []
  const filter = match[1].toLowerCase()
  return assetSlugs
    .filter((slug) => slug.toLowerCase().includes(filter))
    .slice(0, 12)
    .map((slug) => ({
      value: `@${slug}`,
      label: `@${slug}`,
      description: 'project asset',
      type: 'asset',
    }))
}
