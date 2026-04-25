export function trimToHeadClause(value: string): string {
  if (!value) return value;
  const head = value.split(/[,;.]/)[0] ?? value;
  return head.trim().replace(/\s+/g, " ");
}
