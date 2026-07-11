import { describe, expect, it } from 'vitest'
import {
  computeTrunkGroups,
  trunkBusY,
  trunkStubPath,
  trunkSharedPath,
  trunkDot,
  trunkEdgeDataEqual,
} from './trunk-edges.js'
import { connectSteps, snapDefinitionToTracks } from './model.js'
import type { NotebookPlanDefinition } from './types.js'

describe('trunk-edges', () => {
  it('groups fan-in and fan-out properly', () => {
    let def: NotebookPlanDefinition = {
      properties: {},
      sequence: [
        { id: 'prompt-1', componentType: 'task', type: 'prompt', name: 'p1', properties: { position: { x: 0, y: 0 } } },
        { id: 'prompt-2', componentType: 'task', type: 'prompt', name: 'p2', properties: { position: { x: 0, y: 0 } } },
        { id: 'prompt-3', componentType: 'task', type: 'prompt', name: 'p3', properties: { position: { x: 0, y: 0 } } },
        { id: 'image-1', componentType: 'task', type: 'image', name: 'i1', properties: { position: { x: 0, y: 0 } } },
        
        { id: 'image-2', componentType: 'task', type: 'image', name: 'i2', properties: { position: { x: 0, y: 0 } } },
        { id: 'video-1', componentType: 'task', type: 'video', name: 'v1', properties: { position: { x: 0, y: 0 } } },
        { id: 'video-2', componentType: 'task', type: 'video', name: 'v2', properties: { position: { x: 0, y: 0 } } },
        
        { id: 'prompt-4', componentType: 'task', type: 'prompt', name: 'p4', properties: { position: { x: 0, y: 0 } } },
        { id: 'video-3', componentType: 'task', type: 'video', name: 'v3', properties: { position: { x: 0, y: 0 } } },
      ],
    }

    def = connectSteps(def, 'prompt-1', 'image-1')
    def = connectSteps(def, 'prompt-2', 'image-1')
    def = connectSteps(def, 'prompt-3', 'image-1')

    def = connectSteps(def, 'image-2', 'video-1')
    def = connectSteps(def, 'image-2', 'video-2')

    def = connectSteps(def, 'prompt-4', 'video-3')

    def = snapDefinitionToTracks(def)

    const groups = computeTrunkGroups(def)

    expect(groups.get('prompt-1->image-1')).toMatchObject({
      groupId: 'in:image-1',
      groupKind: 'fan-in',
      groupSize: 3,
      isPrimary: true,
      siblingIds: ['prompt-1', 'prompt-2', 'prompt-3'],
    })
    expect(groups.get('prompt-2->image-1')?.isPrimary).toBe(false)
    expect(groups.get('prompt-3->image-1')?.isPrimary).toBe(false)

    expect(groups.get('image-2->video-1')).toMatchObject({
      groupId: 'out:image-2:1',
      groupKind: 'fan-out',
      groupSize: 2,
      isPrimary: true,
      siblingIds: ['video-1', 'video-2'],
    })
    expect(groups.get('image-2->video-2')).toMatchObject({
      groupId: 'out:image-2:1',
      groupKind: 'fan-out',
      groupSize: 2,
      isPrimary: false,
      siblingIds: ['video-1', 'video-2'],
    })

    expect(groups.get('prompt-4->video-3')).toMatchObject({
      groupId: 'out:prompt-4:1',
      groupKind: 'fan-out',
      groupSize: 1,
      isPrimary: true,
      siblingIds: ['video-3'],
    })
  })

  it('computes correct busY', () => {
    expect(trunkBusY(200, 0)).toBe(200 - 56 - 10)
    expect(trunkBusY(200, 1)).toBe(200 - 56)
    expect(trunkBusY(200, 2)).toBe(200 - 56 + 10)
  })

  it('computes paths correctly', () => {
    const coords = { sourceX: 100, sourceY: 50, targetX: 200, targetY: 250, busY: 150 }

    expect(trunkStubPath('fan-in', coords)).toBe('M 100 50 V 150')
    expect(trunkStubPath('fan-out', coords)).toBe('M 200 150 V 250')

    const sharedFanIn = trunkSharedPath('fan-in', { ...coords, siblingXs: [100, 300] })
    expect(sharedFanIn).toBe('M 100 150 H 300 M 200 150 V 250')

    const sharedFanOut = trunkSharedPath('fan-out', { ...coords, siblingXs: [200, 400] })
    expect(sharedFanOut).toBe('M 100 50 V 150 M 100 150 H 400')
  })

  it('computes dot correctly', () => {
    expect(trunkDot('fan-in', { sourceX: 100, targetX: 200, busY: 150, groupSize: 1 })).toBeNull()
    expect(trunkDot('fan-in', { sourceX: 100, targetX: 200, busY: 150, groupSize: 2 })).toEqual({ x: 200, y: 150 })
    expect(trunkDot('fan-out', { sourceX: 100, targetX: 200, busY: 150, groupSize: 3 })).toEqual({ x: 100, y: 150 })
  })

  it('checks data equality correctly', () => {
    const a = {
      kind: 'prompt' as const,
      pinned: false,
      groupId: 'in:abc',
      groupKind: 'fan-in' as const,
      groupSize: 2,
      isPrimary: true,
      siblingIds: ['a', 'b'],
      staggerIndex: 0,
      groupActive: false,
      groupRunning: false,
    }
    expect(trunkEdgeDataEqual(a, a)).toBe(true)
    expect(trunkEdgeDataEqual(a, { ...a })).toBe(true)
    expect(trunkEdgeDataEqual(a, { ...a, groupActive: true })).toBe(false)
    expect(trunkEdgeDataEqual(a, { ...a, siblingIds: ['a', 'c'] })).toBe(false)
  })
})
