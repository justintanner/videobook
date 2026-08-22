type ImageEditBox = {
  x: number
  y: number
  width: number
  height: number
}

export type ImageEditRegion = {
  id: string
  box: ImageEditBox
  matchedSubjectId?: string
}

type ImageEditSubjectBox = {
  id: string
  box: ImageEditBox | null
}

export type ImageEditSelection = {
  subjectIds: string[]
  regions: Array<{
    id: string
    box: ImageEditBox
    matchedSubjectId?: string
  }>
}

export type ImageRegionReplacement = {
  box?: ImageEditBox
  subjectId?: string
  replacementArtifactId: string
  note?: string
}

export const SUBJECT_BOX_IOU_THRESHOLD = 0.25
const MIN_REGION_EDGE = 0.01

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function roundUnit(value: number): number {
  return Math.round(clampUnit(value) * 1e6) / 1e6
}

export function boxIou(left: ImageEditBox, right: ImageEditBox): number {
  const x1 = Math.max(left.x, right.x)
  const y1 = Math.max(left.y, right.y)
  const x2 = Math.min(left.x + left.width, right.x + right.width)
  const y2 = Math.min(left.y + left.height, right.y + right.height)
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const union = left.width * left.height + right.width * right.height - overlap
  return union > 0 ? overlap / union : 0
}

export function regionBoxFromDrag(
  start: { x: number; y: number },
  end: { x: number; y: number },
): ImageEditBox | null {
  const x = roundUnit(Math.min(start.x, end.x))
  const y = roundUnit(Math.min(start.y, end.y))
  const width = roundUnit(Math.min(1 - x, Math.abs(end.x - start.x)))
  const height = roundUnit(Math.min(1 - y, Math.abs(end.y - start.y)))
  if (width < MIN_REGION_EDGE || height < MIN_REGION_EDGE) return null
  return { x, y, width, height }
}

export function pointerToNormalizedPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 }
  return {
    x: clampUnit((clientX - rect.left) / rect.width),
    y: clampUnit((clientY - rect.top) / rect.height),
  }
}

export function bestSubjectSnap(
  box: ImageEditBox,
  subjects: readonly ImageEditSubjectBox[],
  threshold: number = SUBJECT_BOX_IOU_THRESHOLD,
): { subjectId: string; iou: number; box: ImageEditBox } | null {
  const matches = subjects.flatMap((subject) => {
    if (!subject.box) return []
    const iou = boxIou(box, subject.box)
    return iou >= threshold ? [{ subjectId: subject.id, iou, box: subject.box }] : []
  }).sort((left, right) => right.iou - left.iou)
  return matches[0] ?? null
}

export function snapRegionToSubject(
  region: ImageEditRegion,
  subjects: readonly ImageEditSubjectBox[],
  threshold: number = SUBJECT_BOX_IOU_THRESHOLD,
): ImageEditRegion {
  const match = bestSubjectSnap(region.box, subjects, threshold)
  if (!match) return region
  return {
    ...region,
    box: match.box,
    matchedSubjectId: match.subjectId,
  }
}

export function imageEditSelectionPayload(
  selectedSubjectIds: readonly string[],
  regions: readonly ImageEditRegion[],
): ImageEditSelection {
  return {
    subjectIds: [...selectedSubjectIds],
    regions: regions.map((region) => ({
      id: region.id,
      box: region.box,
      ...(region.matchedSubjectId ? { matchedSubjectId: region.matchedSubjectId } : {}),
    })),
  }
}

type ImageReplacementTarget = {
  key: string
  box?: ImageEditBox
  subjectId?: string
  label: string
}

export function imageReplacementTargets(
  regions: readonly ImageEditRegion[],
  selectedSubjects: readonly { id: string; label: string; box: ImageEditBox | null }[],
): ImageReplacementTarget[] {
  const matchedSubjectIds = new Set(
    regions.flatMap((region) => region.matchedSubjectId ? [region.matchedSubjectId] : []),
  )
  const regionTargets = regions.map((region, index) => ({
    key: region.id,
    box: region.box,
    ...(region.matchedSubjectId ? { subjectId: region.matchedSubjectId } : {}),
    label: region.matchedSubjectId
      ? selectedSubjects.find((subject) => subject.id === region.matchedSubjectId)?.label
        ?? `Region ${index + 1}`
      : `Region ${index + 1}`,
  }))
  const subjectTargets = selectedSubjects.flatMap((subject) => {
    if (matchedSubjectIds.has(subject.id)) return []
    return [{
      key: subject.id,
      ...(subject.box ? { box: subject.box } : {}),
      subjectId: subject.id,
      label: subject.label,
    }]
  })
  return [...regionTargets, ...subjectTargets]
}

export function canSubmitRegionReplacements(
  targets: readonly ImageReplacementTarget[],
  replacements: Readonly<Record<string, string>>,
): boolean {
  return targets.length > 0
    && targets.every((target) => Boolean(replacements[target.key]?.trim()))
}

export function regionReplacementPayload(
  targets: readonly ImageReplacementTarget[],
  replacements: Readonly<Record<string, string>>,
): ImageRegionReplacement[] {
  return targets.flatMap((target) => {
    const replacementArtifactId = replacements[target.key]?.trim()
    if (!replacementArtifactId) return []
    return [{
      replacementArtifactId,
      ...(target.box ? { box: target.box } : {}),
      ...(target.subjectId ? { subjectId: target.subjectId } : {}),
    }]
  })
}

export function nextRegionId(existing: readonly ImageEditRegion[]): string {
  return `region-${existing.length + 1}-${Math.random().toString(36).slice(2, 8)}`
}
