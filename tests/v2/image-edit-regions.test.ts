import { describe, expect, it } from 'vitest'
import {
  SUBJECT_BOX_IOU_THRESHOLD,
  bestSubjectSnap,
  boxIou,
  canSubmitRegionReplacements,
  imageEditSelectionPayload,
  imageReplacementTargets,
  pointerToNormalizedPoint,
  regionBoxFromDrag,
  regionReplacementPayload,
  snapRegionToSubject,
} from '../../src/videobook/image-edit-regions'

describe('image edit regions', () => {
  it('computes IoU and snaps a drawn region onto a detected subject', () => {
    const drawn = { x: 0.18, y: 0.08, width: 0.38, height: 0.82 }
    const person = { x: 0.2, y: 0.1, width: 0.35, height: 0.8 }
    const object = { x: 0.6, y: 0.6, width: 0.25, height: 0.2 }
    expect(boxIou(drawn, person)).toBeGreaterThan(SUBJECT_BOX_IOU_THRESHOLD)
    expect(boxIou(drawn, object)).toBeLessThan(SUBJECT_BOX_IOU_THRESHOLD)
    const snap = bestSubjectSnap(drawn, [
      { id: 'person-1', box: person },
      { id: 'object-1', box: object },
    ])
    expect(snap).toEqual({
      subjectId: 'person-1',
      iou: boxIou(drawn, person),
      box: person,
    })
    expect(snapRegionToSubject({
      id: 'region-1',
      box: drawn,
    }, [
      { id: 'person-1', box: person },
      { id: 'object-1', box: object },
    ])).toEqual({
      id: 'region-1',
      box: person,
      matchedSubjectId: 'person-1',
    })
  })

  it('normalizes a drag into a clamped box and ignores tiny drags', () => {
    expect(regionBoxFromDrag({ x: 0.4, y: 0.4 }, { x: 0.1, y: 0.2 })).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.2,
    })
    expect(regionBoxFromDrag({ x: 0.9, y: 0.9 }, { x: 1.4, y: 1.2 })).toEqual({
      x: 0.9,
      y: 0.9,
      width: 0.1,
      height: 0.1,
    })
    expect(regionBoxFromDrag({ x: 0.5, y: 0.5 }, { x: 0.504, y: 0.504 })).toBeNull()
    expect(pointerToNormalizedPoint(150, 250, {
      left: 50,
      top: 50,
      width: 200,
      height: 400,
    })).toEqual({ x: 0.5, y: 0.5 })
  })

  it('builds a selection payload with normalized boxes and optional subject matches', () => {
    expect(imageEditSelectionPayload(['person-1'], [
      {
        id: 'region-1',
        box: { x: 0.2, y: 0.1, width: 0.35, height: 0.8 },
        matchedSubjectId: 'person-1',
      },
      {
        id: 'region-2',
        box: { x: 0.6, y: 0.6, width: 0.25, height: 0.2 },
      },
    ])).toEqual({
      subjectIds: ['person-1'],
      regions: [
        {
          id: 'region-1',
          box: { x: 0.2, y: 0.1, width: 0.35, height: 0.8 },
          matchedSubjectId: 'person-1',
        },
        {
          id: 'region-2',
          box: { x: 0.6, y: 0.6, width: 0.25, height: 0.2 },
        },
      ],
    })
  })

  it('requires a replacement for every selected region before submit', () => {
    const targets = imageReplacementTargets(
      [
        {
          id: 'region-1',
          box: { x: 0.1, y: 0.1, width: 0.2, height: 0.4 },
          matchedSubjectId: 'person-1',
        },
        {
          id: 'region-2',
          box: { x: 0.6, y: 0.2, width: 0.2, height: 0.5 },
        },
      ],
      [
        {
          id: 'person-1',
          label: 'Person',
          box: { x: 0.1, y: 0.1, width: 0.2, height: 0.4 },
        },
        {
          id: 'person-2',
          label: 'Second person',
          box: { x: 0.4, y: 0.2, width: 0.15, height: 0.5 },
        },
      ],
    )
    expect(targets.map((target) => target.key)).toEqual([
      'region-1',
      'region-2',
      'person-2',
    ])
    expect(canSubmitRegionReplacements(targets, {
      'region-1': 'art-d1',
      'region-2': 'art-d2',
    })).toBe(false)
    const replacements = {
      'region-1': 'art-d1',
      'region-2': 'art-d2',
      'person-2': 'art-d3',
    }
    expect(canSubmitRegionReplacements(targets, replacements)).toBe(true)
    expect(regionReplacementPayload(targets, replacements)).toEqual([
      {
        replacementArtifactId: 'art-d1',
        box: { x: 0.1, y: 0.1, width: 0.2, height: 0.4 },
        subjectId: 'person-1',
      },
      {
        replacementArtifactId: 'art-d2',
        box: { x: 0.6, y: 0.2, width: 0.2, height: 0.5 },
      },
      {
        replacementArtifactId: 'art-d3',
        box: { x: 0.4, y: 0.2, width: 0.15, height: 0.5 },
        subjectId: 'person-2',
      },
    ])
  })
})
