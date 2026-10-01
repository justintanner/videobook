import type { ImageReplacementTarget } from '@/videobook/image-edit-regions'
import type { ImageSubject } from '@/videobook/image-subject-map'

/* Fullscreen opens either to look at the media or straight into the editor. */
export type MediaFullscreenMode = 'view' | 'edit'

/* What the instruction will act on, in the words the panel shows above it. */
export function imageEditTargetSummary(
  subjects: readonly ImageSubject[],
  replacementTargets: readonly ImageReplacementTarget[],
): string | null {
  if (replacementTargets.length > 0) {
    return `${replacementTargets.map((target) => target.label).join(', ')} · replaced with another image`
  }
  if (subjects.length === 0) return null
  const names = subjects.slice(0, 3).map((subject) => subject.label).join(', ')
  return subjects.length > 3 ? `${names} +${subjects.length - 3}` : names
}

export function imageEditInstructionPlaceholder(
  subjects: readonly ImageSubject[],
  replacementTargets: readonly ImageReplacementTarget[],
): string {
  if (replacementTargets.length > 0) {
    return 'Optional notes for the replacement. Pick an image below, or mention one like @g7.'
  }
  if (subjects.length === 0) {
    return 'Describe a whole-image edit, e.g. "make it look like a snowy night", or select a subject to scope the change.'
  }
  return `Describe how to change ${subjects.slice(0, 2).map((subject) => subject.label).join(' and ')}, e.g. "make it smooth porcelain".`
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

/* The facts a viewer wants about the file on screen, in the order they read. */
export function mediaDetailParts(asset: {
  type: string
  width: number | null
  height: number | null
  duration: number | null
}): string[] {
  const parts: string[] = []
  if (asset.width && asset.height) parts.push(`${asset.width} × ${asset.height}`)
  if (asset.duration && asset.type !== 'image') parts.push(formatDuration(asset.duration))
  parts.push(asset.type === 'final' ? 'VIDEO' : asset.type.toUpperCase())
  return parts
}

