import { notebookTrackLayout, stepInputs } from './model.js'
import type { NotebookPlanDefinition } from './types.js'

export const TRUNK_BUS_GAP = 56
export const TRUNK_BUS_STAGGER = 10

export type TrunkGroupKind = 'fan-in' | 'fan-out'

export interface GroupAssignment {
  groupId: string
  groupKind: TrunkGroupKind
  groupSize: number
  isPrimary: boolean
  siblingIds: string[]
  staggerIndex: number
}

export interface TrunkEdgeData extends GroupAssignment, Record<string, unknown> {
  kind: 'prompt' | 'ref'
  pinned: boolean
  groupActive: boolean
  groupRunning: boolean
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
    if (target.type !== 'image' && target.type !== 'video') continue
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
  return targetTopY - TRUNK_BUS_GAP + (staggerIndex - 1) * TRUNK_BUS_STAGGER
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
    a.siblingIds.length === b.siblingIds.length &&
    a.siblingIds.every((id, i) => id === b.siblingIds[i])
  )
}
