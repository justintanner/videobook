import { describe, expect, it } from 'vitest'
import { createZoomPlan, zoomScaleAt, zoomWindowAt } from '../../server/src/zoom'
import type { ZoomInput } from '../../server/src/zoom'
import { zoomPlayRange, zoomPreview, zoomPreviewStyle } from '../../src/videobook/zoom-preview'

const clip = { duration: 4, fps: 30 }

function draft(zoom: ZoomInput): Record<string, unknown> {
  return { asset_id: 'video-1', zooms: [zoom] }
}

function planned(zoom: ZoomInput) {
  const preview = zoomPreview(draft(zoom), clip)
  if (!preview.ok) throw new Error(preview.message)
  return preview
}

describe('zoom preview', () => {
  it('builds the plan and the sound cues the render uses from the sheet values', () => {
    const zoom: ZoomInput = { start_seconds: 1, end_seconds: 2.5, scale: 1.5, focus_x: 0.25, focus_y: 0.75, sound: 'zoom_in', return_sound: 'zoom_out' }
    const preview = planned(zoom)
    expect(preview.plan).toEqual(createZoomPlan({ sourceDuration: 4, sourceFps: 30, zooms: [zoom] }))
    expect(preview.cues.map((cue) => cue.sound)).toEqual(['zoom_in', 'zoom_out'])
    expect(preview.cues[0]!.startSeconds).toBeCloseTo(0.89, 9)
    expect(preview.cues[1]!.startSeconds).toBeCloseTo(2.2, 9)
  })

  it('scales the picture around the focus point by the render curve, so the visible window is the render window', () => {
    const { plan } = planned({ start_seconds: 1, end_seconds: 2.5, scale: 1.5, focus_x: 0.25, focus_y: 0.75 })
    expect(zoomPreviewStyle(plan, 0.5)).toEqual({ transform: 'scale(1)', transformOrigin: '25% 75%' })
    expect(zoomPreviewStyle(plan, 1.75)).toEqual({ transform: 'scale(1.5)', transformOrigin: '25% 75%' })
    for (const seconds of [1.1, 1.15, 1.75, 2.3, 2.45]) {
      const scale = zoomScaleAt(plan, seconds)
      expect(zoomPreviewStyle(plan, seconds).transform).toBe(`scale(${scale})`)
      const window = zoomWindowAt(plan, seconds)
      expect(window.x).toBeCloseTo(0.25 * (1 - 1 / scale), 12)
      expect(window.y).toBeCloseTo(0.75 * (1 - 1 / scale), 12)
      expect(window.width).toBeCloseTo(1 / scale, 12)
    }
  })

  it('plays from a second before the zoom to a second after it, inside the clip', () => {
    expect(zoomPlayRange(planned({ start_seconds: 1, end_seconds: 2.5 }).plan)).toEqual({ from: 0, to: 3.5 })
    expect(zoomPlayRange(planned({ start_seconds: 0.5, end_seconds: 3.5 }).plan)).toEqual({ from: 0, to: 4 })
    expect(zoomPlayRange(planned({ start_seconds: 2 }).plan)).toEqual({ from: 1, to: 4 })
  })

  it('reports why there is nothing to animate', () => {
    expect(zoomPreview(draft({ start_seconds: 1, scale: 5 }), clip)).toEqual({ ok: false, message: 'Zoom 1 scale must be from 1.05 to 3; got 5' })
    expect(zoomPreview(draft({ start_seconds: 1, return_sound: 'zoom_out' }), clip)).toMatchObject({ ok: false, message: expect.stringContaining('return_sound but no end_seconds') })
    expect(zoomPreview({ asset_id: 'video-1' }, clip)).toEqual({ ok: false, message: 'Set a start time to preview the zoom.' })
    expect(zoomPreview(draft({ start_seconds: 1 }), { duration: null, fps: 30 })).toEqual({ ok: false, message: 'Loading the clip…' })
  })

  it('assumes 30 fps when the clip does not say', () => {
    const preview = zoomPreview(draft({ start_seconds: 1.01 }), { duration: 4, fps: null })
    expect(preview.ok && preview.plan.sourceFps).toBe(30)
    expect(preview.ok && preview.plan.zooms[0]!.startSeconds).toBe(1)
  })
})
