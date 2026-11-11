import { describe, expect, it } from 'vitest'
import { mcpToolRequestTimeout } from './mcp-client'

describe('mcpToolRequestTimeout', () => {
  it('keeps the watermark request alive through placement, burn, and reprocessing', () => {
    expect(mcpToolRequestTimeout('apply_watermark')).toBe(21 * 60_000)
  })

  it('waits for the graphics editor to find faces and on-screen text', () => {
    expect(mcpToolRequestTimeout('video_graphics', { op: 'detect_regions' })).toBe(6 * 60_000)
    expect(mcpToolRequestTimeout('video_graphics', { op: 'check_placement' })).toBeUndefined()
  })

  it('leaves ordinary tool calls on the SDK default', () => {
    expect(mcpToolRequestTimeout('list_assets')).toBeUndefined()
    expect(mcpToolRequestTimeout('video_graphics')).toBeUndefined()
  })
})
