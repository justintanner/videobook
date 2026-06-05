/** Strip the leading `@` from an asset slug (no-op if absent). */
export function stripSlugPrefix(slug: string): string {
  return slug.startsWith('@') ? slug.slice(1) : slug;
}

const assetTagPattern = /(^|\s)@(?:img|vid|aud|script|plan|char|final)-[a-z0-9][a-z0-9_-]*[,.!?;:]?(?=\s|$)/gi
const slotTagPattern = /(^|\s)@s\d{1,3}[,.!?;:]?(?=\s|$)/gi

export function stripAssetTagsFromText(text: string): string {
  return text
    .replace(assetTagPattern, '$1')
    .replace(slotTagPattern, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}
