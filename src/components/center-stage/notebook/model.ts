import { deriveStripSlots, routeDrop } from '@/components/gen/ui/media-strip'
import type { ModelOption } from '@/components/gen/types'
import type {
  JsonRecord,
  NotebookMediaItem,
  NotebookPlanDefinition,
  NotebookPlanStep,
  NotebookRunStatus,
  NotebookToolboxStep,
} from './types'

export const CONNECTION_OWNED_PARAMS = ['image_slugs', 'video_slug', 'first_frame_slug'] as const

export interface StepPosition {
  x: number
  y: number
}

export interface GraphLayoutBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export const notebookNodeSizes: Record<NotebookPlanStep['type'], { width: number; height: number }> = {
  prompt: { width: 200, height: 124 },
  image: { width: 220, height: 248 },
  video: { width: 220, height: 248 },
  asset: { width: 200, height: 142 },
}

export const NOTEBOOK_TRACK_ORIGIN_X = 80
export const NOTEBOOK_TRACK_ORIGIN_Y = 48
export const NOTEBOOK_TRACK_SLOT_PITCH = 268
export const NOTEBOOK_TRACK_ROW_PITCH = 320
export const NOTEBOOK_TRACK_SLOT_WIDTH = 220

export interface NotebookTrackRow {
  depth: number
  y: number
  stepIds: string[]
}

export interface NotebookTrackLayout {
  rows: NotebookTrackRow[]
  positions: ReadonlyMap<string, StepPosition>
  depths: ReadonlyMap<string, number>
  width: number
  height: number
}

export interface NotebookDropTarget {
  position: StepPosition
  parentId: string | null
  depth: number
  slot: number
}

function record(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : {}
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function stringProperty(properties: JsonRecord, key: string): string | null {
  const value = properties[key]
  return typeof value === 'string' ? value : null
}

function valuesOf(step: NotebookPlanStep): JsonRecord {
  return record(step.properties.values)
}

function stepAssetIds(step: NotebookPlanStep): string[] {
  return stringArray(step.properties.asset_ids)
}

function isGenerationStep(step: NotebookPlanStep): step is NotebookPlanStep & { type: 'image' | 'video' } {
  return step.type === 'image' || step.type === 'video'
}

function normalizedSlug(slug: string): string {
  return slug.startsWith('@') ? slug.slice(1) : slug
}

function slugWithPrefix(slug: string): string {
  return slug.startsWith('@') ? slug : `@${slug}`
}

function copyStep(step: NotebookPlanStep, properties: JsonRecord): NotebookPlanStep {
  return { ...step, properties }
}

function setStep(
  definition: NotebookPlanDefinition,
  stepId: string,
  transform: (step: NotebookPlanStep) => NotebookPlanStep,
): NotebookPlanDefinition {
  let changed = false
  const sequence = definition.sequence.map((step) => {
    if (step.id !== stepId) return step
    const next = transform(step)
    changed ||= next !== step
    return next
  })
  return changed ? { ...definition, sequence } : definition
}

export function createEmptyDefinition(): NotebookPlanDefinition {
  return { properties: {}, sequence: [] }
}

export const toolboxStepSeeds: NotebookToolboxStep[] = [
  {
    componentType: 'task',
    type: 'prompt',
    name: 'Prompt',
    properties: { text: '' },
  },
  {
    componentType: 'task',
    type: 'image',
    name: 'Image',
    properties: { model: '', provider: '', values: {}, asset_ids: [] },
  },
  {
    componentType: 'task',
    type: 'video',
    name: 'Video',
    properties: { model: '', provider: '', values: {}, asset_ids: [] },
  },
]

export function stepPosition(step: NotebookPlanStep): StepPosition | null {
  const position = record(step.properties.position)
  const x = position.x
  const y = position.y
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null
  }
  return { x, y }
}

export function stepInputs(step: NotebookPlanStep): string[] {
  return stringArray(step.properties.inputs)
}

export function notebookTrackDepths(definition: NotebookPlanDefinition): ReadonlyMap<string, number> {
  const byId = new Map(definition.sequence.map((step) => [step.id, step]))
  const depths = new Map<string, number>()
  const depthOf = (id: string, stack: Set<string>): number => {
    const cached = depths.get(id)
    if (cached !== undefined) return cached
    if (stack.has(id)) return 0
    const step = byId.get(id)
    if (!step) return 0
    stack.add(id)
    const parents = stepInputs(step).filter((inputId) => byId.has(inputId))
    const depth = parents.length === 0
      ? 0
      : Math.max(...parents.map((parentId) => depthOf(parentId, stack))) + 1
    stack.delete(id)
    depths.set(id, depth)
    return depth
  }
  for (const step of definition.sequence) depthOf(step.id, new Set())
  return depths
}

function positionForTrackSlot(step: NotebookPlanStep, depth: number, slot: number): StepPosition {
  const size = notebookNodeSizes[step.type]
  return {
    x: NOTEBOOK_TRACK_ORIGIN_X
      + slot * NOTEBOOK_TRACK_SLOT_PITCH
      + (NOTEBOOK_TRACK_SLOT_WIDTH - size.width) / 2,
    y: NOTEBOOK_TRACK_ORIGIN_Y + depth * NOTEBOOK_TRACK_ROW_PITCH,
  }
}

function orderedStepsByDepth(
  definition: NotebookPlanDefinition,
  depths: ReadonlyMap<string, number>,
): Map<number, NotebookPlanStep[]> {
  const sequenceIndex = new Map(definition.sequence.map((step, index) => [step.id, index]))
  const rows = new Map<number, NotebookPlanStep[]>()
  for (const step of definition.sequence) {
    const depth = depths.get(step.id) ?? 0
    const row = rows.get(depth) ?? []
    row.push(step)
    rows.set(depth, row)
  }
  for (const row of rows.values()) {
    row.sort((left, right) => {
      const leftX = stepPosition(left)?.x ?? (sequenceIndex.get(left.id) ?? 0) * NOTEBOOK_TRACK_SLOT_PITCH
      const rightX = stepPosition(right)?.x ?? (sequenceIndex.get(right.id) ?? 0) * NOTEBOOK_TRACK_SLOT_PITCH
      return leftX - rightX || (sequenceIndex.get(left.id) ?? 0) - (sequenceIndex.get(right.id) ?? 0)
    })
  }
  return rows
}

function trackLayoutFromRows(
  depths: ReadonlyMap<string, number>,
  rowsByDepth: ReadonlyMap<number, ReadonlyArray<NotebookPlanStep>>,
): NotebookTrackLayout {
  const positions = new Map<string, StepPosition>()
  const rows: NotebookTrackRow[] = []
  const sortedDepths = [...rowsByDepth.keys()].sort((left, right) => left - right)
  let maxSlots = 1
  for (const depth of sortedDepths) {
    const steps = rowsByDepth.get(depth) ?? []
    maxSlots = Math.max(maxSlots, steps.length)
    steps.forEach((step, slot) => positions.set(step.id, positionForTrackSlot(step, depth, slot)))
    rows.push({
      depth,
      y: NOTEBOOK_TRACK_ORIGIN_Y + depth * NOTEBOOK_TRACK_ROW_PITCH,
      stepIds: steps.map((step) => step.id),
    })
  }
  const maxDepth = sortedDepths.at(-1) ?? 0
  return {
    rows,
    positions,
    depths,
    width: NOTEBOOK_TRACK_ORIGIN_X * 2
      + maxSlots * NOTEBOOK_TRACK_SLOT_PITCH
      - (NOTEBOOK_TRACK_SLOT_PITCH - NOTEBOOK_TRACK_SLOT_WIDTH),
    height: NOTEBOOK_TRACK_ORIGIN_Y * 2 + maxDepth * NOTEBOOK_TRACK_ROW_PITCH + 248,
  }
}

export function notebookTrackLayout(definition: NotebookPlanDefinition): NotebookTrackLayout {
  const depths = notebookTrackDepths(definition)
  return trackLayoutFromRows(depths, orderedStepsByDepth(definition, depths))
}

export function snapDefinitionToTracks(definition: NotebookPlanDefinition): NotebookPlanDefinition {
  const layout = notebookTrackLayout(definition)
  return moveSteps(definition, definition.sequence.flatMap((step) => {
    const position = layout.positions.get(step.id)
    return position ? [{ id: step.id, position }] : []
  }))
}

function nearestTrackSlot(step: NotebookPlanStep, x: number): number {
  const size = notebookNodeSizes[step.type]
  const offset = (NOTEBOOK_TRACK_SLOT_WIDTH - size.width) / 2
  return Math.max(0, Math.round((x - NOTEBOOK_TRACK_ORIGIN_X - offset) / NOTEBOOK_TRACK_SLOT_PITCH))
}

export function reorderStepsOnTracks(
  definition: NotebookPlanDefinition,
  moves: ReadonlyArray<{ id: string; position: StepPosition }>,
): NotebookPlanDefinition {
  if (moves.length === 0) return snapDefinitionToTracks(definition)
  const byId = new Map(definition.sequence.map((step) => [step.id, step]))
  const layout = notebookTrackLayout(definition)
  const rowsByDepth = new Map<number, NotebookPlanStep[]>()
  const movesByDepth = new Map<number, Array<{ step: NotebookPlanStep; slot: number }>>()
  for (const row of layout.rows) {
    rowsByDepth.set(row.depth, row.stepIds.flatMap((id) => {
      const step = byId.get(id)
      return step ? [step] : []
    }))
  }
  for (const move of moves) {
    const step = byId.get(move.id)
    if (!step) continue
    const depth = layout.depths.get(step.id) ?? 0
    const rowMoves = movesByDepth.get(depth) ?? []
    rowMoves.push({ step, slot: nearestTrackSlot(step, move.position.x) })
    movesByDepth.set(depth, rowMoves)
  }
  for (const [depth, rowMoves] of movesByDepth) {
    const row = rowsByDepth.get(depth) ?? []
    const currentIndex = new Map(row.map((step, index) => [step.id, index]))
    const movingIds = new Set(rowMoves.map(({ step }) => step.id))
    const moving = rowMoves
      .slice()
      .sort((left, right) => (currentIndex.get(left.step.id) ?? 0) - (currentIndex.get(right.step.id) ?? 0))
    const remaining = row.filter((step) => !movingIds.has(step.id))
    const anchor = Math.min(...moving.map(({ slot }) => slot))
    remaining.splice(Math.min(anchor, remaining.length), 0, ...moving.map(({ step }) => step))
    rowsByDepth.set(depth, remaining)
  }
  const nextLayout = trackLayoutFromRows(layout.depths, rowsByDepth)
  return moveSteps(definition, definition.sequence.flatMap((step) => {
    const position = nextLayout.positions.get(step.id)
    return position ? [{ id: step.id, position }] : []
  }))
}

export function nextNotebookTrackPosition(
  definition: NotebookPlanDefinition,
  type: NotebookPlanStep['type'],
  depth = 0,
): StepPosition {
  const layout = notebookTrackLayout(definition)
  const slot = layout.rows.find((row) => row.depth === depth)?.stepIds.length ?? 0
  const seed = toolboxStepSeeds.find((step) => step.type === type)
  const step: NotebookPlanStep = seed
    ? { ...seed, id: '', type }
    : { id: '', componentType: 'task', type, name: type, properties: {} }
  return positionForTrackSlot(step, depth, slot)
}

export function notebookDropTarget(
  definition: NotebookPlanDefinition,
  type: Extract<NotebookPlanStep['type'], 'prompt' | 'image' | 'video'>,
  pointer: StepPosition,
  selectedStepId: string | null,
): NotebookDropTarget {
  const seed = toolboxStepSeeds.find((step) => step.type === type)
  const previewStep: NotebookPlanStep = seed
    ? { ...seed, id: '' }
    : { id: '', componentType: 'task', type, name: type, properties: {} }
  const requestedDepth = type === 'prompt'
    ? 0
    : Math.max(0, Math.round((pointer.y - NOTEBOOK_TRACK_ORIGIN_Y) / NOTEBOOK_TRACK_ROW_PITCH))
  const slot = nearestTrackSlot(previewStep, pointer.x)
  if (type === 'prompt' || requestedDepth === 0) {
    return { position: positionForTrackSlot(previewStep, 0, slot), parentId: null, depth: 0, slot }
  }
  const layout = notebookTrackLayout(definition)
  const selectedDepth = selectedStepId ? layout.depths.get(selectedStepId) : undefined
  const selectedParent = selectedStepId && selectedDepth === requestedDepth - 1
    ? definition.sequence.find((step) => step.id === selectedStepId) ?? null
    : null
  const parentRow = layout.rows.find((row) => row.depth === requestedDepth - 1)
  const byId = new Map(definition.sequence.map((step) => [step.id, step]))
  const candidates = parentRow?.stepIds.flatMap((id) => {
    const step = byId.get(id)
    const position = layout.positions.get(id)
    if (!step || !position) return []
    const center = position.x + notebookNodeSizes[step.type].width / 2
    const pointerCenter = pointer.x + notebookNodeSizes[type].width / 2
    return [{ step, distance: Math.abs(center - pointerCenter) }]
  }).sort((left, right) => left.distance - right.distance) ?? []
  const nearest = candidates[0]
  const tied = nearest && candidates[1]?.distance === nearest.distance
  const parent = selectedParent ?? (!tied ? nearest?.step ?? null : null)
  const depth = parent ? requestedDepth : 0
  return {
    position: positionForTrackSlot(previewStep, depth, slot),
    parentId: parent?.id ?? null,
    depth,
    slot,
  }
}

export function assetSlugKind(slug: string): 'image' | 'video' | 'audio' | 'character' | null {
  const bare = normalizedSlug(slug)
  if (bare.startsWith('img-')) return 'image'
  if (bare.startsWith('vid-')) return 'video'
  if (bare.startsWith('aud-')) return 'audio'
  if (bare.startsWith('char-')) return 'character'
  return null
}

export function latestAssetId(step: NotebookPlanStep): string | null {
  const assetIds = stepAssetIds(step)
  return assetIds.at(-1) ?? null
}

/** Ordered non-prompt media inputs for generation canvas cards. */
export interface ConnectedMediaInput {
  sourceId: string
  kind: 'image' | 'video' | 'audio' | 'unknown'
  thumbnailSrc: string | null
  label: string
}

export function connectedMediaInputs(
  definition: NotebookPlanDefinition,
  step: NotebookPlanStep,
  mediaItems: ReadonlyArray<{ id: string; thumbnailSrc?: string | null }>,
): ConnectedMediaInput[] {
  if (!isGenerationStep(step)) return []
  const steps = new Map(definition.sequence.map((candidate) => [candidate.id, candidate]))
  const strip: ConnectedMediaInput[] = []
  for (const inputId of stepInputs(step)) {
    const source = steps.get(inputId)
    if (!source || source.type === 'prompt') continue
    const assetId = source.type === 'asset'
      ? normalizedSlug(stringProperty(source.properties, 'slug') ?? '')
      : latestAssetId(source)
    const asset = assetId ? mediaItems.find((item) => item.id === assetId) : undefined
    const slug = source.type === 'asset'
      ? (stringProperty(source.properties, 'slug') ?? '')
      : assetId
        ? slugWithPrefix(assetId)
        : ''
    const kindFromSlug = slug ? assetSlugKind(slug) : null
    const kind: ConnectedMediaInput['kind'] =
      kindFromSlug === 'image' || kindFromSlug === 'video' || kindFromSlug === 'audio'
        ? kindFromSlug
        : source.type === 'image'
          ? 'image'
          : source.type === 'video'
            ? 'video'
            : 'unknown'
    const model = stringProperty(source.properties, 'model')
    const label = source.type === 'asset'
      ? (slug || source.name)
      : (model || source.name || source.type)
    strip.push({
      sourceId: inputId,
      kind,
      thumbnailSrc: asset?.thumbnailSrc ?? null,
      label,
    })
  }
  return strip
}

export function appendRunAsset(
  definition: NotebookPlanDefinition,
  stepId: string,
  assetId: string,
  ran?: { model: string; provider: string },
): NotebookPlanDefinition {
  return setStep(definition, stepId, (step) => copyStep(step, {
    ...step.properties,
    ...(ran ? { model: ran.model, provider: ran.provider } : {}),
    asset_ids: [...stepAssetIds(step), assetId],
  }))
}

export function stepRunStatus(
  step: NotebookPlanStep,
  mediaItems: NotebookMediaItem[],
): NotebookRunStatus {
  const assetId = latestAssetId(step)
  if (!assetId) return { state: 'idle', assetId: null }
  const asset = mediaItems.find((item) => item.id === assetId)
  if (!asset) return { state: 'missing', assetId }
  if (asset.status === 'error') return { state: 'error', assetId, message: asset.failedMessage }
  if (asset.status === 'ready') return { state: 'ready', assetId }
  return { state: 'pending', assetId }
}

function positionForMissingStep(step: NotebookPlanStep, y: number): StepPosition {
  const existing = stepPosition(step)
  return existing ?? { x: 320, y }
}

function withPosition(step: NotebookPlanStep, position: StepPosition): NotebookPlanStep {
  return copyStep(step, { ...step.properties, position: { x: position.x, y: position.y } })
}

function sourceForSlug(
  sequence: NotebookPlanStep[],
  targetIndex: number,
  slug: string,
): string | null {
  const bare = normalizedSlug(slug)
  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    const candidate = sequence[index]
    if (isGenerationStep(candidate) && latestAssetId(candidate) === bare) return candidate.id
  }
  return null
}

function assetStepId(slug: string, sequence: NotebookPlanStep[]): string {
  const base = `asset-${normalizedSlug(slug)}`
  if (!sequence.some((step) => step.id === base)) return base
  let suffix = 2
  while (sequence.some((step) => step.id === `${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}

function findAssetStep(sequence: NotebookPlanStep[], slug: string): NotebookPlanStep | null {
  const bare = normalizedSlug(slug)
  return sequence.find((step) => (
    step.type === 'asset' && stringProperty(step.properties, 'slug') === slugWithPrefix(bare)
  )) ?? null
}

function migrateSlugToInput(
  sequence: NotebookPlanStep[],
  targetIndex: number,
  slug: string,
): { sourceId: string; sequence: NotebookPlanStep[] } {
  const generatedSource = sourceForSlug(sequence, targetIndex, slug)
  if (generatedSource) return { sourceId: generatedSource, sequence }
  const existingAsset = findAssetStep(sequence, slug)
  if (existingAsset) return { sourceId: existingAsset.id, sequence }
  const target = sequence[targetIndex]
  const targetPosition = stepPosition(target) ?? { x: 320, y: 80 }
  const id = assetStepId(slug, sequence)
  const asset: NotebookPlanStep = {
    id,
    componentType: 'task',
    type: 'asset',
    name: 'Asset',
    properties: {
      slug: slugWithPrefix(slug),
      position: { x: targetPosition.x - 248, y: targetPosition.y },
    },
  }
  return { sourceId: id, sequence: [...sequence, asset] }
}

export function normalizeDefinition(definition: NotebookPlanDefinition): {
  definition: NotebookPlanDefinition
  changed: boolean
} {
  let changed = false
  let y = 80
  let sequence = definition.sequence.map((step) => {
    const position = positionForMissingStep(step, y)
    y += notebookNodeSizes[step.type].height + 48
    if (stepPosition(step)) return step
    changed = true
    return withPosition(step, position)
  })
  const originalCount = sequence.length

  for (let index = 0; index < originalCount; index += 1) {
    const step = sequence[index]
    if (!isGenerationStep(step)) continue
    const values = valuesOf(step)
    const hasConnectionValues = CONNECTION_OWNED_PARAMS.some((param) => Object.hasOwn(values, param))
    if (!hasConnectionValues) continue
    let inputs = stepInputs(step)
    let firstFrameSource = stringProperty(step.properties, 'first_frame_source')
    for (const slug of stringArray(values.image_slugs)) {
      const migrated = migrateSlugToInput(sequence, index, slug)
      sequence = migrated.sequence
      if (!inputs.includes(migrated.sourceId)) inputs = [...inputs, migrated.sourceId]
    }
    for (const param of ['video_slug', 'first_frame_slug'] as const) {
      const slug = values[param]
      if (typeof slug !== 'string' || !slug) continue
      const migrated = migrateSlugToInput(sequence, index, slug)
      sequence = migrated.sequence
      if (!inputs.includes(migrated.sourceId)) inputs = [...inputs, migrated.sourceId]
      if (param === 'first_frame_slug') firstFrameSource = migrated.sourceId
    }
    const nextValues: JsonRecord = { ...values }
    for (const param of CONNECTION_OWNED_PARAMS) delete nextValues[param]
    sequence[index] = copyStep(sequence[index], {
      ...sequence[index].properties,
      values: nextValues,
      ...(inputs.length > 0 ? { inputs } : {}),
      ...(firstFrameSource ? { first_frame_source: firstFrameSource } : {}),
    })
    changed = true
  }

  const normalized = changed ? { ...definition, sequence } : definition
  const tracked = snapDefinitionToTracks(normalized)
  return tracked === definition
    ? { definition, changed: false }
    : { definition: tracked, changed: true }
}

export function wouldCreateCycle(
  definition: NotebookPlanDefinition,
  sourceId: string,
  targetId: string,
): boolean {
  if (sourceId === targetId) return true
  const steps = new Map(definition.sequence.map((step) => [step.id, step]))
  const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (id === targetId) return true
    if (visited.has(id)) return false
    visited.add(id)
    const step = steps.get(id)
    return step ? stepInputs(step).some(visit) : false
  }
  return visit(sourceId)
}

export function canConnect(
  definition: NotebookPlanDefinition,
  sourceId: string,
  targetId: string,
): boolean {
  const source = definition.sequence.find((step) => step.id === sourceId)
  const target = definition.sequence.find((step) => step.id === targetId)
  if (!source || !target || !isGenerationStep(target)) return false
  if (stepInputs(target).includes(sourceId)) return false
  return !wouldCreateCycle(definition, sourceId, targetId)
}

export function connectSteps(
  definition: NotebookPlanDefinition,
  sourceId: string,
  targetId: string,
): NotebookPlanDefinition {
  if (!canConnect(definition, sourceId, targetId)) return definition
  return setStep(definition, targetId, (step) => copyStep(step, {
    ...step.properties,
    inputs: [...stepInputs(step), sourceId],
  }))
}

export function disconnectSteps(
  definition: NotebookPlanDefinition,
  sourceId: string,
  targetId: string,
): NotebookPlanDefinition {
  const target = definition.sequence.find((step) => step.id === targetId)
  if (!target || !stepInputs(target).includes(sourceId)) return definition
  return setStep(definition, targetId, (step) => {
    const nextInputs = stepInputs(step).filter((input) => input !== sourceId)
    const nextProperties: JsonRecord = { ...step.properties, inputs: nextInputs }
    if (stringProperty(step.properties, 'first_frame_source') === sourceId) {
      delete nextProperties.first_frame_source
    }
    return copyStep(step, nextProperties)
  })
}

export function setFirstFrameSource(
  definition: NotebookPlanDefinition,
  targetId: string,
  sourceId: string | null,
): NotebookPlanDefinition {
  const target = definition.sequence.find((step) => step.id === targetId)
  if (!target) return definition
  if (sourceId !== null && !stepInputs(target).includes(sourceId)) return definition
  const current = stringProperty(target.properties, 'first_frame_source')
  if (current === sourceId) return definition
  return setStep(definition, targetId, (step) => {
    const properties: JsonRecord = { ...step.properties }
    if (sourceId) properties.first_frame_source = sourceId
    else delete properties.first_frame_source
    return copyStep(step, properties)
  })
}

export function moveSteps(
  definition: NotebookPlanDefinition,
  moves: ReadonlyArray<{ id: string; position: StepPosition }>,
): NotebookPlanDefinition {
  const positions = new Map(moves.map((move) => [move.id, {
    x: Math.round(move.position.x),
    y: Math.round(move.position.y),
  }]))
  let changed = false
  const sequence = definition.sequence.map((step) => {
    const position = positions.get(step.id)
    if (!position) return step
    const current = stepPosition(step)
    if (current?.x === position.x && current.y === position.y) return step
    changed = true
    return withPosition(step, position)
  })
  return changed ? { ...definition, sequence } : definition
}

export function addStep(
  definition: NotebookPlanDefinition,
  seed: NotebookToolboxStep,
  position: StepPosition,
): NotebookPlanDefinition {
  const step: NotebookPlanStep = {
    ...seed,
    id: crypto.randomUUID(),
    properties: { ...seed.properties, position: { x: Math.round(position.x), y: Math.round(position.y) } },
  }
  return { ...definition, sequence: [...definition.sequence, step] }
}

export function addAssetStep(
  definition: NotebookPlanDefinition,
  slug: string,
  position: StepPosition,
): { definition: NotebookPlanDefinition; stepId: string } {
  const existing = findAssetStep(definition.sequence, slug)
  if (existing) return { definition, stepId: existing.id }
  const stepId = assetStepId(slug, definition.sequence)
  const step: NotebookPlanStep = {
    id: stepId,
    componentType: 'task',
    type: 'asset',
    name: 'Asset',
    properties: {
      slug: slugWithPrefix(slug),
      position: { x: Math.round(position.x), y: Math.round(position.y) },
    },
  }
  return { definition: { ...definition, sequence: [...definition.sequence, step] }, stepId }
}

export function removeSteps(
  definition: NotebookPlanDefinition,
  ids: ReadonlyArray<string>,
): NotebookPlanDefinition {
  const removed = new Set(ids)
  if (!definition.sequence.some((step) => removed.has(step.id))) return definition
  return {
    ...definition,
    sequence: definition.sequence
      .filter((step) => !removed.has(step.id))
      .map((step) => {
        const inputs = stepInputs(step)
        const nextInputs = inputs.filter((input) => !removed.has(input))
        const pin = stringProperty(step.properties, 'first_frame_source')
        if (nextInputs.length === inputs.length && (!pin || !removed.has(pin))) return step
        const properties: JsonRecord = { ...step.properties, inputs: nextInputs }
        if (pin && removed.has(pin)) delete properties.first_frame_source
        return copyStep(step, properties)
      }),
  }
}

export function updateStepProperties(
  definition: NotebookPlanDefinition,
  stepId: string,
  patch: JsonRecord,
): NotebookPlanDefinition {
  return setStep(definition, stepId, (step) => copyStep(step, { ...step.properties, ...patch }))
}

function sourceSlug(step: NotebookPlanStep): string | null {
  if (step.type === 'asset') return stringProperty(step.properties, 'slug')
  const output = latestAssetId(step)
  return output ? slugWithPrefix(output) : null
}

export function resolveEffectiveValues(
  definition: NotebookPlanDefinition,
  step: NotebookPlanStep,
  option: ModelOption,
): { values: Record<string, unknown>; warnings: string[]; promptFromInputs: string | null } {
  const persisted = valuesOf(step)
  const values: Record<string, unknown> = { ...persisted }
  for (const param of CONNECTION_OWNED_PARAMS) delete values[param]
  const warnings: string[] = []
  const prompts: string[] = []
  let hasPromptInput = false
  const steps = new Map(definition.sequence.map((candidate) => [candidate.id, candidate]))
  const slots = deriveStripSlots(option)
  const firstFrameSource = stringProperty(step.properties, 'first_frame_source')
  const routedStringSources = new Set<string>()

  for (const inputId of stepInputs(step)) {
    const input = steps.get(inputId)
    if (!input) {
      warnings.push(`Connected node ${inputId} no longer exists.`)
      continue
    }
    if (input.type === 'prompt') {
      hasPromptInput = true
      const text = stringProperty(input.properties, 'text') ?? ''
      prompts.push(text)
      continue
    }
    const slug = sourceSlug(input)
    if (!slug) {
      warnings.push(`${input.name} has no ready output yet.`)
      continue
    }
    const kind = assetSlugKind(slug)
    if (!kind || kind === 'character') {
      warnings.push(`${input.name} does not provide a usable media reference.`)
      continue
    }
    const route = inputId === firstFrameSource && option.schema.properties.first_frame_slug
      ? { param: 'first_frame_slug' }
      : routeDrop(kind, slots)
    const schema = option.schema.properties[route.param]
    if (!route.param || !schema) {
      warnings.push(`${input.name} cannot be routed to this model.`)
      continue
    }
    if (schema.type === 'array') {
      const current = stringArray(values[route.param])
      if (current.includes(slug)) continue
      const max = slots.find((slot) => slot.param === route.param)?.max
      if (max !== null && max !== undefined && current.length >= max) {
        warnings.push(`${route.param} accepts at most ${max} connected references.`)
        continue
      }
      values[route.param] = [...current, slug]
      continue
    }
    if (routedStringSources.has(route.param)) {
      warnings.push(`${route.param} accepts one connected reference; keeping the first.`)
      continue
    }
    values[route.param] = slug
    routedStringSources.add(route.param)
  }

  const promptFromInputs = hasPromptInput ? prompts.join('\n\n') : null
  if (promptFromInputs !== null) values.prompt = promptFromInputs
  return { values, warnings, promptFromInputs }
}

export function stepInputReadiness(
  definition: NotebookPlanDefinition,
  step: NotebookPlanStep,
  mediaItems: NotebookMediaItem[],
): { ready: boolean; reasons: string[] } {
  const sources = new Map(definition.sequence.map((candidate) => [candidate.id, candidate]))
  const reasons: string[] = []
  for (const inputId of stepInputs(step)) {
    const input = sources.get(inputId)
    if (!input) {
      reasons.push(`Connected node ${inputId} was removed.`)
      continue
    }
    if (input.type === 'prompt') {
      if (!(stringProperty(input.properties, 'text') ?? '').trim()) reasons.push(`${input.name} is empty.`)
      continue
    }
    const assetId = input.type === 'asset'
      ? normalizedSlug(stringProperty(input.properties, 'slug') ?? '')
      : latestAssetId(input)
    const asset = assetId ? mediaItems.find((item) => item.id === assetId) : null
    if (!asset || asset.status !== 'ready') reasons.push(`${input.name} is not ready.`)
  }
  return { ready: reasons.length === 0, reasons }
}

export function stepInvalidReason(
  definition: NotebookPlanDefinition,
  step: NotebookPlanStep,
): string | null {
  if (step.type === 'asset') return null
  if (step.type === 'prompt') return (stringProperty(step.properties, 'text') ?? '').trim() ? null : 'Prompt is empty.'
  const prompt = stringProperty(valuesOf(step), 'prompt') ?? ''
  const hasPromptInput = stepInputs(step).some((inputId) => (
    definition.sequence.find((candidate) => candidate.id === inputId)?.type === 'prompt'
  ))
  return prompt.trim() || hasPromptInput ? null : 'Connect a prompt or write one.'
}

export function graphLayoutBounds(definition: NotebookPlanDefinition): GraphLayoutBounds {
  if (definition.sequence.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  return definition.sequence.reduce<GraphLayoutBounds>((bounds, step) => {
    const position = stepPosition(step) ?? { x: 0, y: 0 }
    const size = notebookNodeSizes[step.type]
    return {
      minX: Math.min(bounds.minX, position.x),
      minY: Math.min(bounds.minY, position.y),
      maxX: Math.max(bounds.maxX, position.x + size.width),
      maxY: Math.max(bounds.maxY, position.y + size.height),
    }
  }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
}

export function autoLayout(definition: NotebookPlanDefinition): NotebookPlanDefinition {
  return snapDefinitionToTracks(definition)
}
