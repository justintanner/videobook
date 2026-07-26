import type { NotebookDocument } from 'videobook-engine'
import { notebookGrid } from './notebook-grid'

export const notebookGutterLaneOffsets = [10, 20, 30] as const

export type NotebookRiverSide = 'left' | 'right'

export interface NotebookBusRiverRoute extends Record<string, unknown> {
  sourceBusOffset: number
  targetBusOffset: number
  riverOffset: number
  riverSide: NotebookRiverSide
}

export interface NotebookBusRiverCoordinates {
  sourceX: number
  sourceY: number
  targetX: number
  targetY: number
  sourceLeftX: number
  sourceRightX: number
  sourceBottomY: number
  targetTopY: number
}

export interface NotebookBusRiverPoint {
  x: number
  y: number
}

interface RouteCandidate {
  id: string
  sourceRow: number
  sourceColumn: number
  targetRow: number
  targetColumn: number
  targetInput: string
}

type GutterAssignments = ReadonlyMap<string, ReadonlyMap<string, number>>

export const defaultNotebookBusRiverRoute: NotebookBusRiverRoute = {
  sourceBusOffset: notebookGutterLaneOffsets[1],
  targetBusOffset: notebookGutterLaneOffsets[1],
  riverOffset: notebookGutterLaneOffsets[1],
  riverSide: 'right',
}

function compareCandidates(left: RouteCandidate, right: RouteCandidate): number {
  return left.sourceRow - right.sourceRow
    || left.sourceColumn - right.sourceColumn
    || left.targetRow - right.targetRow
    || left.targetColumn - right.targetColumn
    || left.targetInput.localeCompare(right.targetInput)
    || left.id.localeCompare(right.id)
}

function preferredLaneOffset(index: number, count: number): number {
  if (count === 1) return notebookGutterLaneOffsets[1]
  if (count === 2) {
    return index % 2 === 0
      ? notebookGutterLaneOffsets[0]
      : notebookGutterLaneOffsets[2]
  }
  return notebookGutterLaneOffsets[index % notebookGutterLaneOffsets.length]
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

function riverSide(candidate: RouteCandidate): NotebookRiverSide {
  return candidate.targetColumn >= candidate.sourceColumn ? 'right' : 'left'
}

function riverGutter(candidate: RouteCandidate): number {
  return riverSide(candidate) === 'right'
    ? candidate.sourceColumn
    : candidate.sourceColumn - 1
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
      sourceRow: source.slot.row,
      sourceColumn: source.slot.column,
      targetRow: target.slot.row,
      targetColumn: target.slot.column,
      targetInput: edge.targetInput,
    }]
  })
  const horizontalAssignments = assignGutterOffsets(
    candidates,
    (candidate) => [
      String(candidate.sourceRow),
      String(candidate.targetRow - 1),
    ],
  )
  const verticalAssignments = assignGutterOffsets(
    candidates,
    (candidate) => [String(riverGutter(candidate))],
  )
  const routes = new Map<string, NotebookBusRiverRoute>()

  for (const candidate of candidates) {
    routes.set(candidate.id, {
      sourceBusOffset: assignedOffset(
        horizontalAssignments,
        candidate.sourceRow,
        candidate.id,
      ),
      targetBusOffset: assignedOffset(
        horizontalAssignments,
        candidate.targetRow - 1,
        candidate.id,
      ),
      riverOffset: assignedOffset(
        verticalAssignments,
        riverGutter(candidate),
        candidate.id,
      ),
      riverSide: riverSide(candidate),
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

  return [
    { x: coordinates.sourceX, y: coordinates.sourceY },
    { x: coordinates.sourceX, y: sourceBusY },
    { x: riverX, y: sourceBusY },
    { x: riverX, y: targetBusY },
    { x: coordinates.targetX, y: targetBusY },
    { x: coordinates.targetX, y: coordinates.targetY },
  ]
}

export function notebookBusRiverPath(
  coordinates: NotebookBusRiverCoordinates,
  route: NotebookBusRiverRoute,
): string {
  const points = notebookBusRiverPoints(coordinates, route)
  return [
    `M ${points[0].x} ${points[0].y}`,
    `V ${points[1].y}`,
    `H ${points[2].x}`,
    `V ${points[3].y}`,
    `H ${points[4].x}`,
    `V ${points[5].y}`,
  ].join(' ')
}
