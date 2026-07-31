import { formatMediaTime } from '@/videobook/notebook-cell-presentation'

type NotebookMediaMetadataProps = {
  className: string
  width: number | null
  height: number | null
  durationSeconds: number | null
  fallbackLabel?: string
}

function positiveFinite(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0
}

export function NotebookMediaMetadata({
  className,
  width,
  height,
  durationSeconds,
  fallbackLabel,
}: NotebookMediaMetadataProps) {
  const dimensions = positiveFinite(width) && positiveFinite(height)
    ? `${width}×${height}`
    : fallbackLabel ?? null
  const duration = positiveFinite(durationSeconds)
    ? formatMediaTime(durationSeconds)
    : null

  if (!dimensions && !duration) return null

  return (
    <span className={`notebook-media-metadata ${className}`}>
      {dimensions && <span>{dimensions}</span>}
      {duration && (
        <time dateTime={`PT${durationSeconds}S`} aria-label={`Duration ${duration}`}>
          {duration}
        </time>
      )}
    </span>
  )
}
