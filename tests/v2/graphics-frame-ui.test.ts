import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { ORIGINAL_GRAPHICS_FRAME } from '../../server/src/graphics/frame'
import { GraphicsFrameControl } from '../../src/components/videobook/graphics/GraphicsFrameControl'
import { graphicsFocusPoint } from '../../src/videobook/graphics-pointer'

it('shows all frame choices and accessible crop focus controls', () => {
  const html = renderToStaticMarkup(createElement(GraphicsFrameControl, {
    frame: { ...ORIGINAL_GRAPHICS_FRAME, aspect: '9:16' }, source: { width: 640, height: 360 }, mediaUrl: '/source.mp4', disabled: false, onChange: () => undefined,
  }))
  for (const label of ['Original', '9:16', '1:1', '4:5', '16:9', 'Crop', 'Blur', 'Horizontal crop focus', 'Vertical crop focus']) expect(html).toContain(label)
  expect(graphicsFocusPoint({ x: 70, y: 50 }, { left: 20, top: 10, width: 100, height: 80 })).toEqual({ x: 0.5, y: 0.5 })
  expect(graphicsFocusPoint({ x: -1, y: 300 }, { left: 20, top: 10, width: 100, height: 80 })).toEqual({ x: 0, y: 1 })
})

it('explains and locks the subtitle canvas when rendering both together', () => {
  const html = renderToStaticMarkup(createElement(GraphicsFrameControl, {
    frame: { ...ORIGINAL_GRAPHICS_FRAME, aspect: '4:5', fit: 'blur' }, source: { width: 640, height: 360 }, mediaUrl: '/source.mp4', disabled: true, subtitleAspect: '4:5', onChange: () => undefined,
  }))
  expect(html).toContain('disabled=""')
  expect(html).toContain('subtitle draft’s 4:5 frame')
  expect(html).not.toContain('Horizontal crop focus')
})
