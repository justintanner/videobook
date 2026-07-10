/** Strip the leading `@` from an asset slug (no-op if absent). */
export function stripSlugPrefix(slug: string): string {
  return slug.startsWith('@') ? slug.slice(1) : slug;
}

/** True when two slug strings refer to the same asset (ignores leading `@`). */
export function sameAssetSlug(a: string, b: string): boolean {
  return stripSlugPrefix(a) === stripSlugPrefix(b);
}

/** Find an asset whose slug matches (with or without `@`). */
export function findByAssetSlug<T extends { slug: string }>(
  slug: string,
  assets: readonly T[],
): T | undefined {
  const clean = stripSlugPrefix(slug);
  return assets.find((a) => stripSlugPrefix(a.slug) === clean);
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
