/** Strip the leading `@` from an asset slug (no-op if absent). */
export function stripSlugPrefix(slug: string): string {
  return slug.startsWith('@') ? slug.slice(1) : slug;
}

/** Ensure a slug has the leading `@` prefix (no-op if already present). */
export function ensureSlugPrefix(slug: string): string {
  return slug.startsWith('@') ? slug : `@${slug}`;
}
