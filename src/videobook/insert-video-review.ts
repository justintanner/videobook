import { insertVideoTimingError, isInsertVideoModel } from '../../server/src/media/insert-video-timing'

type InsertSource = {
  type: string
  targetInput?: string
  asset: { duration: number | null } | null
}

export function insertVideoSource<T extends InsertSource>(sources: readonly T[]): T | undefined {
  return sources.find((source) => source.targetInput === 'video')
    ?? sources.find((source) => source.type === 'video' || source.type === 'final')
}

export function insertVideoReviewError(model: string, settings: Record<string, unknown>, sources: readonly InsertSource[]): string | null {
  if (!isInsertVideoModel(model)) return null
  const source = insertVideoSource(sources)
  if (!source) return 'Connect the original video to choose the section to replace.'
  const duration = source.asset?.duration
  if (!duration || !Number.isFinite(duration)) return 'The original video duration is unavailable. Wait for the source to finish processing.'
  return insertVideoTimingError(settings, duration)
}
