import type { NotebookDocument } from 'videobook-engine'
import { notebookGrid } from './notebook-grid'

/* Three bus lanes across the gutter, at quarter, half and three-quarter
   depth. Derived from the gap so a density change moves the lanes with it
   instead of pushing the outer lane inside the neighbouring cell. */
export const notebookGutterLaneOffsets: readonly [number, number, number] = [
  notebookGrid.gap * 0.25,
  notebookGrid.gap * 0.5,
  notebookGrid.gap * 0.75,
]
export const notebookSourcePortOffsets = [0.25, 0.5, 0.75] as const

type NotebookRiverSide = 'left' | 'right'
export type NotebookSourceSide = NotebookRiverSide | 'bottom'
type NotebookTargetSide = 'top' | 'left'

export interface NotebookBusRiverRoute extends Record<string, unknown> {
  sourceSide: NotebookSourceSide
  sourcePortIndex: number
  targetSide: NotebookTargetSide
  targetPortIndex: number
  sourceBusOffset: number
  targetBusOffset: number
  riverOffset: number
  riverSide: NotebookRiverSide
  directRowGutter: boolean
  targetPrimary: boolean
}

interface NotebookBusRiverCoordinates {
  sourceX: number
  sourceY: number
  targetX: number
  targetY: number
  sourceLeftX: number
  sourceRightX: number
  sourceBottomY: number
  targetLeftX: number
  targetTopY: number
  targetHeight: number
}

export interface NotebookBusRiverPoint {
  x: number
  y: number
}

interface RouteCandidate {
  id: string
  sourceId: string
  targetId: string
  sourceRow: number
  sourceColumn: number
  targetRow: number
  targetColumn: number
  targetInput: string
}

type GutterAssignments = ReadonlyMap<string, ReadonlyMap<string, number>>

interface HorizontalRouteUnit {
  id: string
  column: number
  kind: 'source' | 'target'
  candidates: RouteCandidate[]
}

interface HorizontalAssignments {
  source: ReadonlyMap<string, number>
  target: ReadonlyMap<string, number>
}

export const defaultNotebookBusRiverRoute: NotebookBusRiverRoute = {
  sourceSide: 'bottom',
  sourcePortIndex: 1,
  targetSide: 'top',
  targetPortIndex: 1,
  sourceBusOffset: notebookGutterLaneOffsets[1],
  targetBusOffset: notebookGutterLaneOffsets[1],
  riverOffset: notebookGutterLaneOffsets[1],
  riverSide: 'right',
  directRowGutter: false,
  targetPrimary: true,
}

function compareCandidates(left: RouteCandidate, right: RouteCandidate): number {
  return left.sourceRow - right.sourceRow
    || left.sourceColumn - right.sourceColumn
    || left.targetRow - right.targetRow
    || left.targetColumn - right.targetColumn
    || left.targetInput.localeCompare(right.targetInput)
    || left.id.localeCompare(right.id)
}

function preferredIndex(index: number, count: number): number {
  if (count === 1) return 1
  if (count === 2) {
    return index % 2 === 0 ? 0 : 2
  }
  return index % notebookGutterLaneOffsets.length
}

function preferredLaneOffset(index: number, count: number): number {
  return notebookGutterLaneOffsets[preferredIndex(index, count)]
}

function assignGutterOffsets(
  candidates: readonly RouteCandidate[],
  keysFor: (candidate: RouteCandidate) => readonly string[],
): GutterAssignments {
  const groups = new Map<string, Map<string, RouteCandidate>>()
  for (const candidate of candidates) {
    for (const key of keysFor(candidate)) {
      const group = groups.get(key) ?? new Map<string, RouteCandidate>()
      group.set(candidate.id, candidate)
      groups.set(key, group)
    }
  }

  const assignments = new Map<string, ReadonlyMap<string, number>>()
  for (const [key, group] of groups) {
    const sorted = [...group.values()].sort(compareCandidates)
    assignments.set(
      key,
      new Map(sorted.map((candidate, index) => [
        candidate.id,
        preferredLaneOffset(index, sorted.length),
      ])),
    )
  }
  return assignments
}

function sourceSide(candidate: RouteCandidate): NotebookSourceSide {
  if (candidate.targetColumn < candidate.sourceColumn) return 'left'
  if (candidate.targetColumn > candidate.sourceColumn) return 'right'
  return 'bottom'
}

function sourcePortAssignments(
  candidates: readonly RouteCandidate[],
): ReadonlyMap<string, number> {
  const groups = new Map<string, RouteCandidate[]>()
  for (const candidate of candidates) {
    const key = `${candidate.sourceId}:${sourceSide(candidate)}`
    const group = groups.get(key) ?? []
    group.push(candidate)
    groups.set(key, group)
  }

  const assignments = new Map<string, number>()
  for (const group of groups.values()) {
    group.sort(compareCandidates)
    group.forEach((candidate, index) => {
      assignments.set(candidate.id, preferredIndex(index, group.length))
    })
  }
  return assignments
}

function targetSide(candidate: RouteCandidate): NotebookTargetSide {
  return candidate.sourceColumn < candidate.targetColumn ? 'left' : 'top'
}

function targetPortAssignments(
  candidates: readonly RouteCandidate[],
): ReadonlyMap<string, number> {
  const groups = new Map<string, RouteCandidate[]>()
  for (const candidate of candidates) {
    const key = `${candidate.targetId}:${targetSide(candidate)}`
    const group = groups.get(key) ?? []
    group.push(candidate)
    groups.set(key, group)
  }

  const assignments = new Map<string, number>()
  for (const group of groups.values()) {
    group.sort(compareCandidates)
    group.forEach((candidate, index) => {
      assignments.set(candidate.id, preferredIndex(index, group.length))
    })
  }
  return assignments
}

function targetPrimaryAssignments(
  candidates: readonly RouteCandidate[],
): ReadonlySet<string> {
  const groups = new Map<string, RouteCandidate[]>()
  for (const candidate of candidates) {
    const group = groups.get(candidate.targetId) ?? []
    group.push(candidate)
    groups.set(candidate.targetId, group)
  }

  const assignments = new Set<string>()
  for (const group of groups.values()) {
    group.sort(compareCandidates)
    const primary = group[0]
    if (primary) assignments.add(primary.id)
  }
  return assignments
}

function bottomRiverAssignments(
  candidates: readonly RouteCandidate[],
): ReadonlyMap<string, NotebookRiverSide> {
  const groups = new Map<string, RouteCandidate[]>()
  for (const candidate of candidates) {
    if (sourceSide(candidate) !== 'bottom') continue
    const group = groups.get(candidate.sourceId) ?? []
    group.push(candidate)
    groups.set(candidate.sourceId, group)
  }

  const assignments = new Map<string, NotebookRiverSide>()
  for (const group of groups.values()) {
    group.sort(compareCandidates)
    group.forEach((candidate, index) => {
      assignments.set(
        candidate.id,
        group.length === 1 || index % 2 === 1 ? 'right' : 'left',
      )
    })
  }
  return assignments
}

function riverSide(
  candidate: RouteCandidate,
  bottomAssignments: ReadonlyMap<string, NotebookRiverSide>,
): NotebookRiverSide {
  const side = sourceSide(candidate)
  return side === 'bottom'
    ? bottomAssignments.get(candidate.id) ?? 'right'
    : side
}

function riverGutter(
  candidate: RouteCandidate,
  bottomAssignments: ReadonlyMap<string, NotebookRiverSide>,
): number {
  return riverSide(candidate, bottomAssignments) === 'right'
    ? candidate.sourceColumn
    : candidate.sourceColumn - 1
}

function directRowGutter(candidate: RouteCandidate): boolean {
  return candidate.targetRow === candidate.sourceRow + 1
    && candidate.targetColumn === candidate.sourceColumn
}

function horizontalAssignments(
  candidates: readonly RouteCandidate[],
): HorizontalAssignments {
  const gutters = new Map<number, Map<string, HorizontalRouteUnit>>()
  const addUnit = (
    gutter: number,
    id: string,
    column: number,
    kind: HorizontalRouteUnit['kind'],
    candidate: RouteCandidate,
  ) => {
    const units = gutters.get(gutter) ?? new Map<string, HorizontalRouteUnit>()
    const unit = units.get(id) ?? { id, column, kind, candidates: [] }
    unit.candidates.push(candidate)
    units.set(id, unit)
    gutters.set(gutter, units)
  }

  for (const candidate of candidates) {
    if (
      sourceSide(candidate) === 'bottom'
      && !directRowGutter(candidate)
    ) {
      addUnit(
        candidate.sourceRow,
        `source:${candidate.id}`,
        candidate.sourceColumn,
        'source',
        candidate,
      )
    }
    if (targetSide(candidate) === 'top') {
      addUnit(
        candidate.targetRow - 1,
        `target:${candidate.targetId}`,
        candidate.targetColumn,
        'target',
        candidate,
      )
    }
  }

  const source = new Map<string, number>()
  const target = new Map<string, number>()
  for (const units of gutters.values()) {
    const sorted = [...units.values()].sort((left, right) =>
      left.column - right.column
      || left.kind.localeCompare(right.kind)
      || left.id.localeCompare(right.id))
    sorted.forEach((unit, index) => {
      const offset = preferredLaneOffset(index, sorted.length)
      for (const candidate of unit.candidates) {
        if (unit.kind === 'source') source.set(candidate.id, offset)
        else target.set(candidate.id, offset)
      }
    })
  }

  for (const candidate of candidates) {
    if (!directRowGutter(candidate)) continue
    source.set(
      candidate.id,
      target.get(candidate.id) ?? notebookGutterLaneOffsets[1],
    )
  }

  return { source, target }
}

function assignedOffset(
  assignments: GutterAssignments,
  gutter: number,
  edgeId: string,
): number {
  return assignments.get(String(gutter))?.get(edgeId)
    ?? notebookGutterLaneOffsets[1]
}

export function notebookBusRiverRoutes(
  document: NotebookDocument,
): ReadonlyMap<string, NotebookBusRiverRoute> {
  const cells = new Map(document.cells.map((cell) => [cell.id, cell]))
  const candidates = document.edges.flatMap((edge) => {
    const source = cells.get(edge.source)
    const target = cells.get(edge.target)
    if (!source || !target) return []
    return [{
      id: edge.id,
      sourceId: source.id,
      targetId: target.id,
      sourceRow: source.slot.row,
      sourceColumn: source.slot.column,
      targetRow: target.slot.row,
      targetColumn: target.slot.column,
      targetInput: edge.targetInput,
    }]
  })
  const sourcePorts = sourcePortAssignments(candidates)
  const targetPorts = targetPortAssignments(candidates)
  const targetPrimaries = targetPrimaryAssignments(candidates)
  const bottomAssignments = bottomRiverAssignments(candidates)
  const horizontal = horizontalAssignments(candidates)
  const verticalAssignments = assignGutterOffsets(
    candidates.filter((candidate) => !directRowGutter(candidate)),
    (candidate) => [String(targetSide(candidate) === 'left'
      ? candidate.targetColumn - 1
      : riverGutter(candidate, bottomAssignments))],
  )
  const routes = new Map<string, NotebookBusRiverRoute>()

  for (const candidate of candidates) {
    const candidateRiverSide = riverSide(candidate, bottomAssignments)
    const candidateTargetSide = targetSide(candidate)
    const candidateRiverGutter = candidateTargetSide === 'left'
      ? candidate.targetColumn - 1
      : riverGutter(candidate, bottomAssignments)
    routes.set(candidate.id, {
      sourceSide: sourceSide(candidate),
      sourcePortIndex: sourcePorts.get(candidate.id) ?? 1,
      targetSide: candidateTargetSide,
      targetPortIndex: targetPorts.get(candidate.id) ?? 1,
      sourceBusOffset: horizontal.source.get(candidate.id)
        ?? notebookGutterLaneOffsets[1],
      targetBusOffset: horizontal.target.get(candidate.id)
        ?? notebookGutterLaneOffsets[1],
      riverOffset: assignedOffset(
        verticalAssignments,
        candidateRiverGutter,
        candidate.id,
      ),
      riverSide: candidateRiverSide,
      directRowGutter: directRowGutter(candidate),
      targetPrimary: targetPrimaries.has(candidate.id),
    })
  }

  return routes
}

export function notebookBusRiverPoints(
  coordinates: NotebookBusRiverCoordinates,
  route: NotebookBusRiverRoute,
): readonly NotebookBusRiverPoint[] {
  const sourceBusY = coordinates.sourceBottomY + route.sourceBusOffset
  const targetBusY = coordinates.targetTopY - notebookGrid.gap + route.targetBusOffset
  const riverX = route.riverSide === 'right'
    ? coordinates.sourceRightX + route.riverOffset
    : coordinates.sourceLeftX - notebookGrid.gap + route.riverOffset

  if (route.targetSide === 'left') {
    if (coordinates.sourceY === coordinates.targetY) {
      return [
        { x: coordinates.sourceX, y: coordinates.sourceY },
        { x: coordinates.targetX, y: coordinates.targetY },
      ]
    }
    const targetApproachX = coordinates.targetLeftX
      - notebookGrid.gap
      + route.riverOffset
    return [
      { x: coordinates.sourceX, y: coordinates.sourceY },
      { x: targetApproachX, y: coordinates.sourceY },
      { x: targetApproachX, y: coordinates.targetY },
      { x: coordinates.targetX, y: coordinates.targetY },
    ]
  }

  if (
    route.directRowGutter
    && coordinates.targetTopY > coordinates.sourceBottomY
  ) {
    const gap = coordinates.targetTopY - coordinates.sourceBottomY
    const busY = coordinates.sourceBottomY
      + gap * (route.targetBusOffset / notebookGrid.gap)
    return [
      { x: coordinates.sourceX, y: coordinates.sourceY },
      { x: coordinates.sourceX, y: busY },
      { x: coordinates.targetX, y: busY },
      { x: coordinates.targetX, y: coordinates.targetY },
    ]
  }

  if (route.sourceSide !== 'bottom') {
    return [
      { x: coordinates.sourceX, y: coordinates.sourceY },
      { x: riverX, y: coordinates.sourceY },
      { x: riverX, y: targetBusY },
      { x: coordinates.targetX, y: targetBusY },
      { x: coordinates.targetX, y: coordinates.targetY },
    ]
  }

  return [
    { x: coordinates.sourceX, y: coordinates.sourceY },
    { x: coordinates.sourceX, y: sourceBusY },
    { x: riverX, y: sourceBusY },
    { x: riverX, y: targetBusY },
    { x: coordinates.targetX, y: targetBusY },
    { x: coordinates.targetX, y: coordinates.targetY },
  ]
}

const notebookEdgeBendRadius = 8

function lineCommand(
  from: NotebookBusRiverPoint,
  to: NotebookBusRiverPoint,
): string {
  if (to.x === from.x) return `V ${to.y}`
  if (to.y === from.y) return `H ${to.x}`
  return `L ${to.x} ${to.y}`
}

export function notebookBusRiverPath(
  coordinates: NotebookBusRiverCoordinates,
  route: NotebookBusRiverRoute,
): string {
  const points = notebookBusRiverPoints(coordinates, route)
  const parts = [`M ${points[0].x} ${points[0].y}`]
  let cursor = points[0]
  for (let index = 1; index < points.length - 1; index += 1) {
    const corner = points[index]
    const next = points[index + 1]
    const inLength = Math.hypot(corner.x - cursor.x, corner.y - cursor.y)
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y)
    const radius = Math.min(notebookEdgeBendRadius, inLength / 2, outLength / 2)
    if (radius < 1) {
      parts.push(lineCommand(cursor, corner))
      cursor = corner
      continue
    }
    const before = {
      x: corner.x - ((corner.x - cursor.x) / inLength) * radius,
      y: corner.y - ((corner.y - cursor.y) / inLength) * radius,
    }
    const after = {
      x: corner.x + ((next.x - corner.x) / outLength) * radius,
      y: corner.y + ((next.y - corner.y) / outLength) * radius,
    }
    parts.push(
      lineCommand(cursor, before),
      `Q ${corner.x} ${corner.y} ${after.x} ${after.y}`,
    )
    cursor = after
  }
  parts.push(lineCommand(cursor, points[points.length - 1]))
  return parts.join(' ')
}

export function notebookSourcePortId(
  side: NotebookSourceSide,
  index: number,
): string {
  return `route-${side}-${index % notebookSourcePortOffsets.length}`
}
