import { recordValue } from './value-decoders'

export type ImageSubjectMapStatus = 'idle' | 'analyzing' | 'ready' | 'failed'

type ImageSubjectBox = {
  x: number
  y: number
  width: number
  height: number
}

export type ImageSubject = {
  id: string
  label: string
  description: string | null
  color: string
  box: ImageSubjectBox | null
  layerUrl: string | null
  thumbnailUrl: string | null
  zIndex: number
  removable: boolean
  exactEdit: boolean
}

export type ImageSubjectMap = {
  status: ImageSubjectMapStatus
  artifactId: string | null
  objectHash: string | null
  width: number | null
  height: number | null
  baseUrl: string | null
  jobId: string | null
  startedAt: string | null
  error: string | null
  subjects: ImageSubject[]
}

const subjectColors = [
  '#65e6a5',
  '#ffbd5c',
  '#69b7ff',
  '#ff7f9c',
  '#c58cff',
  '#50d7dc',
  '#f38d58',
  '#d2e466',
] as const

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function boundedUnit(value: number): number {
  const normalized = value > 1 ? value / 1000 : value
  return Math.min(1, Math.max(0, normalized))
}

function normalizedBox(value: unknown): ImageSubjectBox | null {
  if (Array.isArray(value) && value.length >= 4) {
    const x1 = numberValue(value[0])
    const y1 = numberValue(value[1])
    const x2 = numberValue(value[2])
    const y2 = numberValue(value[3])
    if (x1 === null || y1 === null || x2 === null || y2 === null) return null
    const x = boundedUnit(x1)
    const y = boundedUnit(y1)
    return {
      x,
      y,
      width: Math.max(0, boundedUnit(x2) - x),
      height: Math.max(0, boundedUnit(y2) - y),
    }
  }
  const box = recordValue(value)
  if (!box) return null
  const x = numberValue(box.x ?? box.left ?? box.x1)
  const y = numberValue(box.y ?? box.top ?? box.y1)
  const width = numberValue(box.width)
  const height = numberValue(box.height)
  const right = numberValue(box.right ?? box.x2)
  const bottom = numberValue(box.bottom ?? box.y2)
  if (x === null || y === null) return null
  const normalizedX = boundedUnit(x)
  const normalizedY = boundedUnit(y)
  const normalizedWidth = width === null
    ? right === null ? null : boundedUnit(right) - normalizedX
    : boundedUnit(width)
  const normalizedHeight = height === null
    ? bottom === null ? null : boundedUnit(bottom) - normalizedY
    : boundedUnit(height)
  if (normalizedWidth === null || normalizedHeight === null) return null
  return {
    x: normalizedX,
    y: normalizedY,
    width: Math.max(0, Math.min(1 - normalizedX, normalizedWidth)),
    height: Math.max(0, Math.min(1 - normalizedY, normalizedHeight)),
  }
}

function imageSubjectColor(id: string, index: number): string {
  let hash = index
  for (const character of id) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0
  return subjectColors[Math.abs(hash) % subjectColors.length]
}

function asSubject(value: unknown, index: number): ImageSubject | null {
  const item = recordValue(value)
  if (!item) return null
  const id = stringValue(item.id ?? item.subject_id ?? item.region_id)
    ?? (numberValue(item.index) === null ? null : `subject-${numberValue(item.index)}`)
  if (!id) return null
  const capabilities = recordValue(item.capabilities)
  const boundingBox = recordValue(item.bounding_box ?? item.boundingBox)
  return {
    id,
    label: stringValue(item.label ?? item.name) ?? `Subject ${index + 1}`,
    description: stringValue(item.description),
    color: stringValue(item.color) ?? imageSubjectColor(id, index),
    box: normalizedBox(
      item.normalized_box
      ?? item.normalizedBox
      ?? boundingBox?.normalized
      ?? item.box,
    ),
    layerUrl: stringValue(
      item.layer_url
      ?? item.layerUrl
      ?? item.mask_url
      ?? item.maskUrl
      ?? item.url,
    ),
    thumbnailUrl: stringValue(item.thumbnail_url ?? item.thumbnailUrl),
    zIndex: numberValue(item.z_index ?? item.zIndex) ?? index + 1,
    removable: booleanValue(
      capabilities?.remove ?? item.removable,
      true,
    ),
    exactEdit: booleanValue(
      capabilities?.exact_edit ?? capabilities?.exactEdit ?? item.exact_edit,
      false,
    ),
  }
}

function mapStatus(value: unknown, fallback: ImageSubjectMapStatus): ImageSubjectMapStatus {
  return value === 'idle'
    || value === 'analyzing'
    || value === 'ready'
    || value === 'failed'
    ? value
    : fallback
}

export function asImageSubjectMap(value: unknown): ImageSubjectMap {
  const envelope = recordValue(value)
  const nestedPayload = recordValue(
    envelope?.subject_map
    ?? envelope?.subjectMap
    ?? envelope?.map,
  )
  const payload = nestedPayload ?? envelope
  const subjectValues = Array.isArray(payload?.subjects)
    ? payload.subjects
    : Array.isArray(payload?.regions)
      ? payload.regions
      : Array.isArray(payload?.layers)
        ? payload.layers
        : []
  const subjects = subjectValues.flatMap((subject, index) => {
    const parsed = asSubject(subject, index)
    return parsed ? [parsed] : []
  }).sort((left, right) => left.zIndex - right.zIndex)
  const error = stringValue(payload?.error ?? envelope?.error)
  const fallbackStatus: ImageSubjectMapStatus = error
    ? 'failed'
    : subjects.length > 0
      ? 'ready'
      : 'idle'
  return {
    status: mapStatus(payload?.status ?? envelope?.status, fallbackStatus),
    artifactId: stringValue(
      payload?.artifact_id
      ?? payload?.artifactId
      ?? envelope?.artifact_id
      ?? envelope?.artifactId,
    ),
    objectHash: stringValue(
      payload?.object_hash
      ?? payload?.objectHash
      ?? envelope?.object_hash
      ?? envelope?.objectHash,
    ),
    width: numberValue(payload?.width ?? envelope?.width),
    height: numberValue(payload?.height ?? envelope?.height),
    baseUrl: stringValue(
      payload?.base_url
      ?? payload?.baseUrl
      ?? envelope?.base_url
      ?? envelope?.baseUrl,
    ),
    jobId: stringValue(payload?.job_id ?? payload?.jobId ?? envelope?.job_id ?? envelope?.jobId),
    startedAt: stringValue(
      payload?.started_at
      ?? payload?.startedAt
      ?? envelope?.started_at
      ?? envelope?.startedAt,
    ),
    error,
    subjects,
  }
}
