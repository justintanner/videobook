import {
  NOTEBOOK_TRACK_ORIGIN_X,
  NOTEBOOK_TRACK_ROW_PITCH,
  NOTEBOOK_TRACK_SLOT_PITCH,
  NOTEBOOK_TRACK_SLOT_WIDTH,
  generationMediaType,
  notebookNodeSizes,
  notebookTrackLayout,
  stepInputs,
} from './model.js'
import type { NotebookPlanDefinition } from './types.js'

const MAX_CARD_HEIGHT = Math.max(...Object.values(notebookNodeSizes).map((size) => size.height))

/** Empty band between two rows: row pitch minus the tallest card (100px). */
export const ROW_GUTTER = NOTEBOOK_TRACK_ROW_PITCH - MAX_CARD_HEIGHT

/** Horizontal lane offsets inside a row gutter, measured from the upper card bottom. */
export const ROW_GUTTER_LANES = [28, 50, 72] as const

/** Vertical lane offsets inside a 48px column gutter, measured from the gutter's left edge. */
export const COL_GUTTER_LANES = [14, 24, 34] as const

export type TrunkGroupKind = 'fan-in' | 'fan-out'

export interface GroupAssignment {
  groupId: string
  groupKind: TrunkGroupKind
  groupSize: number
  isPrimary: boolean
  siblingIds: string[]
  staggerIndex: number
}

export interface GutterRoute {
  multiRow: boolean
  outLane: number
  inLane: number
  gutterX: number
}

export interface TrunkEdgeData extends GroupAssignment, Record<string, unknown> {
  kind: 'note' | 'ref'
  pinned: boolean
  groupActive: boolean
  groupRunning: boolean
  route: GutterRoute
  busSiblingIds: string[]
}

interface TempGroup {
  id: string
  kind: TrunkGroupKind
  edges: { source: string; target: string; isPrimary: boolean }[]
  targetDepth: number
  anchorId: string
}

export function computeTrunkGroups(definition: NotebookPlanDefinition): ReadonlyMap<string, GroupAssignment> {
  const layout = notebookTrackLayout(definition)
  const steps = new Map(definition.sequence.map((s) => [s.id, s]))

  const tempGroups = new Map<string, TempGroup>()

  for (const target of definition.sequence) {
    if (!generationMediaType(target)) continue
    const inputs = stepInputs(target).filter((id) => steps.has(id))
    if (inputs.length === 0) continue

    const targetDepth = layout.depths.get(target.id) ?? 0

    if (inputs.length >= 2) {
      const groupId = `in:${target.id}`
      tempGroups.set(groupId, {
        id: groupId,
        kind: 'fan-in',
        edges: inputs.map((source, idx) => ({ source, target: target.id, isPrimary: idx === 0 })),
        targetDepth,
        anchorId: target.id,
      })
    } else {
      const source = inputs[0]
      if (!source) continue
      const groupId = `out:${source}:${targetDepth}`
      let group = tempGroups.get(groupId)
      if (!group) {
        group = {
          id: groupId,
          kind: 'fan-out',
          edges: [],
          targetDepth,
          anchorId: source,
        }
        tempGroups.set(groupId, group)
      }
      group.edges.push({ source, target: target.id, isPrimary: group.edges.length === 0 })
    }
  }

  const groupsByDepth = new Map<number, TempGroup[]>()
  for (const group of tempGroups.values()) {
    const list = groupsByDepth.get(group.targetDepth) ?? []
    list.push(group)
    groupsByDepth.set(group.targetDepth, list)
  }

  const result = new Map<string, GroupAssignment>()

  for (const groups of groupsByDepth.values()) {
    groups.sort((a, b) => {
      const ax = layout.positions.get(a.anchorId)?.x ?? 0
      const bx = layout.positions.get(b.anchorId)?.x ?? 0
      return ax - bx
    })

    groups.forEach((group, idx) => {
      const staggerIndex = idx % 3
      const siblingIds = group.kind === 'fan-in'
        ? group.edges.map((e) => e.source)
        : group.edges.map((e) => e.target)

      for (const edge of group.edges) {
        result.set(`${edge.source}->${edge.target}`, {
          groupId: group.id,
          groupKind: group.kind,
          groupSize: group.edges.length,
          isPrimary: edge.isPrimary,
          siblingIds,
          staggerIndex,
        })
      }
    })
  }

  return result
}

export function trunkBusY(targetTopY: number, staggerIndex: number): number {
  return targetTopY - ROW_GUTTER + ROW_GUTTER_LANES[staggerIndex % ROW_GUTTER_LANES.length]
}

interface Coords {
  sourceX: number
  sourceY: number
  targetX: number
  targetY: number
}

export function trunkStubPath(kind: TrunkGroupKind, p: Coords & { busY: number }): string {
  if (kind === 'fan-in') {
    return `M ${p.sourceX} ${p.sourceY} V ${p.busY}`
  } else {
    return `M ${p.targetX} ${p.busY} V ${p.targetY}`
  }
}

export function trunkSharedPath(kind: TrunkGroupKind, p: Coords & { busY: number; siblingXs: number[] }): string {
  const xs = [...p.siblingXs]
  if (kind === 'fan-in') xs.push(p.targetX)
  else xs.push(p.sourceX)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)

  if (kind === 'fan-in') {
    return `M ${minX} ${p.busY} H ${maxX} M ${p.targetX} ${p.busY} V ${p.targetY}`
  } else {
    return `M ${p.sourceX} ${p.sourceY} V ${p.busY} M ${minX} ${p.busY} H ${maxX}`
  }
}

export function trunkDot(
  kind: TrunkGroupKind,
  p: { sourceX: number; targetX: number; busY: number; groupSize: number },
): { x: number; y: number } | null {
  if (p.groupSize === 1) return null
  if (kind === 'fan-in') {
    return { x: p.targetX, y: p.busY }
  } else {
    return { x: p.sourceX, y: p.busY }
  }
}

interface RouteCandidate {
  id: string
  sourceDepth: number
  targetDepth: number
  sourceSlot: number
  targetSlot: number
  gutterSlot: number
}

/** Absolute x of a vertical lane inside the gutter between slot `gutterSlot` and `gutterSlot + 1`. */
export function columnGutterLaneX(gutterSlot: number, lane: number): number {
  return NOTEBOOK_TRACK_ORIGIN_X
    + gutterSlot * NOTEBOOK_TRACK_SLOT_PITCH
    + NOTEBOOK_TRACK_SLOT_WIDTH
    + COL_GUTTER_LANES[lane % COL_GUTTER_LANES.length]
}

function assignLanes(
  candidates: RouteCandidate[],
  keyOf: (candidate: RouteCandidate) => number,
): Map<string, number> {
  const groups = new Map<number, RouteCandidate[]>()
  for (const candidate of candidates) {
    const key = keyOf(candidate)
    const list = groups.get(key) ?? []
    list.push(candidate)
    groups.set(key, list)
  }
  const lanes = new Map<string, number>()
  for (const list of groups.values()) {
    list.sort((a, b) =>
      a.sourceDepth - b.sourceDepth
      || a.sourceSlot - b.sourceSlot
      || a.targetDepth - b.targetDepth
      || a.targetSlot - b.targetSlot
      || a.id.localeCompare(b.id))
    list.forEach((candidate, idx) => lanes.set(candidate.id, idx % ROW_GUTTER_LANES.length))
  }
  return lanes
}

/**
 * Assigns gutter lanes to edges. Edges spanning a single row ride the shared
 * trunk bus inside the row gutter (see trunkBusY) and need no column gutter.
 * Edges spanning multiple rows get a deterministic vertical lane inside a
 * column gutter so their long verticals never cross a card or each other.
 */
export function computeGutterRoutes(definition: NotebookPlanDefinition): ReadonlyMap<string, GutterRoute> {
  const layout = notebookTrackLayout(definition)
  const steps = new Map(definition.sequence.map((step) => [step.id, step]))
  const slotOf = (id: string): number => {
    const step = steps.get(id)
    const position = layout.positions.get(id)
    if (!step || !position) return 0
    const size = notebookNodeSizes[step.type]
    return Math.round(
      (position.x + size.width / 2 - NOTEBOOK_TRACK_ORIGIN_X - NOTEBOOK_TRACK_SLOT_WIDTH / 2)
      / NOTEBOOK_TRACK_SLOT_PITCH,
    )
  }

  const result = new Map<string, GutterRoute>()
  const multiRow: RouteCandidate[] = []

  for (const target of definition.sequence) {
    if (!generationMediaType(target)) continue
    const targetDepth = layout.depths.get(target.id) ?? 0
    for (const source of stepInputs(target)) {
      if (!steps.has(source)) continue
      const id = `${source}->${target.id}`
      const sourceDepth = layout.depths.get(source) ?? 0
      if (targetDepth <= sourceDepth + 1) {
        result.set(id, { multiRow: false, outLane: 0, inLane: 0, gutterX: 0 })
        continue
      }
      const sourceSlot = slotOf(source)
      const targetSlot = slotOf(target.id)
      const gutterSlot = targetSlot > sourceSlot ? sourceSlot : Math.max(0, sourceSlot - 1)
      multiRow.push({ id, sourceDepth, targetDepth, sourceSlot, targetSlot, gutterSlot })
    }
  }

  const colLanes = assignLanes(multiRow, (candidate) => candidate.gutterSlot)
  const outLanes = assignLanes(multiRow, (candidate) => candidate.sourceDepth)
  const inLanes = assignLanes(multiRow, (candidate) => candidate.targetDepth - 1)

  for (const candidate of multiRow) {
    result.set(candidate.id, {
      multiRow: true,
      outLane: outLanes.get(candidate.id) ?? 0,
      inLane: inLanes.get(candidate.id) ?? 0,
      gutterX: columnGutterLaneX(candidate.gutterSlot, colLanes.get(candidate.id) ?? 0),
    })
  }

  return result
}

/** Orthogonal polyline: row gutter below source → column gutter → row gutter above target. */
export function gutterRoutePath(p: Coords, route: GutterRoute): string {
  const outY = p.sourceY + ROW_GUTTER_LANES[route.outLane % ROW_GUTTER_LANES.length]
  const inY = p.targetY - ROW_GUTTER + ROW_GUTTER_LANES[route.inLane % ROW_GUTTER_LANES.length]
  return `M ${p.sourceX} ${p.sourceY} V ${outY} H ${route.gutterX} V ${inY} H ${p.targetX} V ${p.targetY}`
}

export function trunkEdgeDataEqual(a?: TrunkEdgeData, b?: TrunkEdgeData): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.kind === b.kind &&
    a.pinned === b.pinned &&
    a.groupId === b.groupId &&
    a.groupKind === b.groupKind &&
    a.groupSize === b.groupSize &&
    a.isPrimary === b.isPrimary &&
    a.staggerIndex === b.staggerIndex &&
    a.groupActive === b.groupActive &&
    a.groupRunning === b.groupRunning &&
    a.route.multiRow === b.route.multiRow &&
    a.route.outLane === b.route.outLane &&
    a.route.inLane === b.route.inLane &&
    a.route.gutterX === b.route.gutterX &&
    a.busSiblingIds.length === b.busSiblingIds.length &&
    a.busSiblingIds.every((id, i) => id === b.busSiblingIds[i]) &&
    a.siblingIds.length === b.siblingIds.length &&
    a.siblingIds.every((id, i) => id === b.siblingIds[i])
  )
}
