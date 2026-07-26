import { describe, expect, it } from 'vitest'
import {
  computeGutterRoutes,
  computeTrunkGroups,
  columnGutterLaneX,
  gutterRoutePath,
  trunkBusY,
  trunkStubPath,
  trunkSharedPath,
  trunkDot,
  trunkEdgeDataEqual,
  ROW_GUTTER,
  ROW_GUTTER_LANES,
} from './trunk-edges.js'
import { connectSteps, setStepDepthOverride, snapDefinitionToTracks } from './model.js'
import type { NotebookPlanDefinition } from './types.js'

describe('trunk-edges', () => {
  it('groups fan-in and fan-out properly', () => {
    let def: NotebookPlanDefinition = {
      properties: {},
      sequence: [
        { id: 'prompt-1', componentType: 'task', type: 'prompt', name: 'p1', properties: { position: { x: 0, y: 0 } } },
        { id: 'prompt-2', componentType: 'task', type: 'prompt', name: 'p2', properties: { position: { x: 0, y: 0 } } },
        { id: 'prompt-3', componentType: 'task', type: 'prompt', name: 'p3', properties: { position: { x: 0, y: 0 } } },
        { id: 'image-1', componentType: 'task', type: 'generate_image', name: 'i1', properties: { media_type: 'image', position: { x: 0, y: 0 } } },
        
        { id: 'image-2', componentType: 'task', type: 'generate_image', name: 'i2', properties: { media_type: 'image', position: { x: 0, y: 0 } } },
        { id: 'video-1', componentType: 'task', type: 'generate_video', name: 'v1', properties: { media_type: 'video', position: { x: 0, y: 0 } } },
        { id: 'video-2', componentType: 'task', type: 'generate_video', name: 'v2', properties: { media_type: 'video', position: { x: 0, y: 0 } } },
        
        { id: 'prompt-4', componentType: 'task', type: 'prompt', name: 'p4', properties: { position: { x: 0, y: 0 } } },
        { id: 'video-3', componentType: 'task', type: 'generate_video', name: 'v3', properties: { media_type: 'video', position: { x: 0, y: 0 } } },
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
    expect(trunkBusY(200, 0)).toBe(200 - ROW_GUTTER + ROW_GUTTER_LANES[0])
    expect(trunkBusY(200, 1)).toBe(200 - ROW_GUTTER + ROW_GUTTER_LANES[1])
    expect(trunkBusY(200, 2)).toBe(200 - ROW_GUTTER + ROW_GUTTER_LANES[2])
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
      kind: 'text' as const,
      pinned: false,
      groupId: 'in:abc',
      groupKind: 'fan-in' as const,
      groupSize: 2,
      isPrimary: true,
      siblingIds: ['a', 'b'],
      staggerIndex: 0,
      groupActive: false,
      groupRunning: false,
      route: { multiRow: false, outLane: 0, inLane: 0, gutterX: 0 },
      busSiblingIds: ['a', 'b'],
    }
    expect(trunkEdgeDataEqual(a, a)).toBe(true)
    expect(trunkEdgeDataEqual(a, { ...a })).toBe(true)
    expect(trunkEdgeDataEqual(a, { ...a, groupActive: true })).toBe(false)
    expect(trunkEdgeDataEqual(a, { ...a, siblingIds: ['a', 'c'] })).toBe(false)
    expect(trunkEdgeDataEqual(a, { ...a, busSiblingIds: ['a'] })).toBe(false)
    expect(trunkEdgeDataEqual(a, { ...a, route: { ...a.route, gutterX: 426 } })).toBe(false)
  })

  it('routes multi-row edges through column gutters', () => {
    let def: NotebookPlanDefinition = {
      properties: {},
      sequence: [
        { id: 'prompt-1', componentType: 'task', type: 'prompt', name: 'p1', properties: { position: { x: 0, y: 0 } } },
        { id: 'prompt-2', componentType: 'task', type: 'prompt', name: 'p2', properties: { position: { x: 348, y: 0 } } },
        { id: 'image-1', componentType: 'task', type: 'generate_image', name: 'i1', properties: { media_type: 'image', position: { x: 0, y: 0 } } },
        { id: 'image-2', componentType: 'task', type: 'generate_image', name: 'i2', properties: { media_type: 'image', position: { x: 348, y: 0 } } },
        { id: 'video-1', componentType: 'task', type: 'generate_video', name: 'v1', properties: { media_type: 'video', position: { x: 0, y: 0 } } },
      ],
    }

    def = connectSteps(def, 'prompt-1', 'image-1')
    def = connectSteps(def, 'prompt-2', 'image-2')
    def = connectSteps(def, 'image-1', 'video-1')
    def = setStepDepthOverride(def, 'image-1', 2)
    def = setStepDepthOverride(def, 'image-2', 2)
    def = snapDefinitionToTracks(def)

    const routes = computeGutterRoutes(def)

    expect(routes.get('image-1->video-1')?.multiRow).toBe(false)

    const routeA = routes.get('prompt-1->image-1')
    const routeB = routes.get('prompt-2->image-2')
    expect(routeA?.multiRow).toBe(true)
    expect(routeB?.multiRow).toBe(true)

    // Both verticals must sit inside the 48px gutter between slots 0 and 1
    // (x in [412, 460]) and on distinct lanes.
    expect(routeA?.gutterX).toBe(columnGutterLaneX(0, 0))
    expect(routeB?.gutterX).toBe(columnGutterLaneX(0, 1))
    expect(routeA?.gutterX).not.toBe(routeB?.gutterX)
    for (const route of [routeA, routeB]) {
      expect(route?.gutterX).toBeGreaterThan(412)
      expect(route?.gutterX).toBeLessThan(460)
    }
  })

  it('builds an orthogonal gutter polyline', () => {
    const coords = { sourceX: 100, sourceY: 50, targetX: 200, targetY: 690 }
    const route = { multiRow: true, outLane: 0, inLane: 0, gutterX: 426 }
    const outY = 50 + ROW_GUTTER_LANES[0]
    const inY = 690 - ROW_GUTTER + ROW_GUTTER_LANES[0]
    expect(gutterRoutePath(coords, route)).toBe(
      `M 100 50 V ${outY} H 426 V ${inY} H 200 V 690`,
    )
  })
})
