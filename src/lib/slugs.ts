/** Strip the leading `@` from an asset slug (no-op if absent). */
export function stripSlugPrefix(slug: string): string {
  return slug.startsWith('@') ? slug.slice(1) : slug;
}
