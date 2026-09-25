const EXPORT_SEQUENCE_USAGE = 'Usage: /export-sequence --aspect 16:9|9:16|1:1 --captions burned|sidecar|omit'

type ExportSequenceRequest = {
  orientation: 'landscape' | 'portrait' | 'square'
  captions: 'burn-in' | 'sidecar' | 'omit'
}

export function parseExportSequenceCommand(
  restParts: readonly string[],
  sequenceId: string,
): { ok: true } & ExportSequenceRequest | { ok: false; message: string } {
  const aspectIndex = restParts.findIndex((value) => value.toLowerCase() === '--aspect')
  const captionsIndex = restParts.findIndex((value) => value.toLowerCase() === '--captions')
  const aspect = (aspectIndex >= 0 ? restParts[aspectIndex + 1] : '16:9')?.trim().toLowerCase()
  const captionValue = (captionsIndex >= 0 ? restParts[captionsIndex + 1] : 'burned')?.trim().toLowerCase()
  const orientation = aspect === '9:16'
    ? 'portrait'
    : aspect === '1:1'
      ? 'square'
      : aspect === '16:9'
        ? 'landscape'
        : null
  const captions = captionValue === 'burned' || captionValue === 'burn-in'
    ? 'burn-in'
    : captionValue === 'sidecar' || captionValue === 'omit'
      ? captionValue
      : null
  const consumed = new Set<number>()
  if (aspectIndex >= 0) {
    consumed.add(aspectIndex)
    consumed.add(aspectIndex + 1)
  }
  if (captionsIndex >= 0) {
    consumed.add(captionsIndex)
    consumed.add(captionsIndex + 1)
  }
  const positional = restParts.filter((_, index) => !consumed.has(index))
  if (
    !orientation
    || !captions
    || positional.some((value) => value !== '@sequence-main' && value !== `@${sequenceId}`)
  ) {
    return { ok: false, message: EXPORT_SEQUENCE_USAGE }
  }
  return { ok: true, orientation, captions }
}
