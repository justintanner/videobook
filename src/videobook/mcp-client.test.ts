import { describe, expect, it } from 'vitest'
import { mcpToolRequestTimeout } from './mcp-client'

describe('mcpToolRequestTimeout', () => {
  it('keeps the watermark request alive through placement, burn, and reprocessing', () => {
    expect(mcpToolRequestTimeout('apply_watermark')).toBe(21 * 60_000)
  })

  it('leaves ordinary tool calls on the SDK default', () => {
    expect(mcpToolRequestTimeout('list_assets')).toBeUndefined()
  })
})
