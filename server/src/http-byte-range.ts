export type HttpByteRangeResult =
  | { ok: true; end: number; start: number }
  | { ok: false }

export function parseHttpByteRange(
  value: string,
  size: number,
): HttpByteRangeResult {
  if (!Number.isSafeInteger(size) || size < 1) return { ok: false }
  const match = value.trim().match(/^bytes=(\d*)-(\d*)$/u)
  if (!match || (!match[1] && !match[2])) return { ok: false }
  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) {
      return { ok: false }
    }
    return {
      ok: true,
      end: size - 1,
      start: Math.max(0, size - suffixLength),
    }
  }
  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(requestedEnd)
    || start >= size
    || requestedEnd < start
  ) {
    return { ok: false }
  }
  return {
    ok: true,
    end: Math.min(requestedEnd, size - 1),
    start,
  }
}
