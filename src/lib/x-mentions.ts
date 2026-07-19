/** Extract unique X handles from post text. Mirrors the server's
 *  extractXMentions in server/src/tools/verify-x-mentions.ts: X usernames are
 *  1-15 chars of [A-Za-z0-9_]; tokens followed by a hyphen (asset slugs like
 *  @vid-clip) and email-style @s preceded by a word character are excluded. */
export function extractXMentions(text: string): string[] {
  const handles: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/(^|[^\w@])@([A-Za-z0-9_]{1,15})(?![\w-])/g)) {
    const handle = match[2];
    const key = handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    handles.push(handle);
  }
  return handles;
}
