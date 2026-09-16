let next = 0

/** Monotonic client-side sequence shared by captions and MCP call rows. */
export function nextHistorySequence(): number {
  next += 1
  return next
}

export function resetHistorySequence(value = 0): void {
  next = value
}
