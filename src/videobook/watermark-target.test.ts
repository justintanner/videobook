import { describe, expect, it } from 'vitest'
import { resolveWatermarkTarget } from './watermark-target'

const assets = [
  { artifactId: 'vid-1', type: 'video' },
  { artifactId: 'img-1', type: 'image' },
  { artifactId: 'vid-2', type: 'video' },
]
const addresses = new Map([
  ['vid-1', 'a1'],
  ['img-1', 'b2'],
])

describe('resolveWatermarkTarget', () => {
  it('prefers the explicit asset ref and labels it with the cell address', () => {
    const result = resolveWatermarkTarget('vid-1', { outputArtifactId: 'vid-2' }, assets, addresses)
    expect(result).toEqual({ ok: true, artifactId: 'vid-1', label: '@a1' })
  })

  it('falls back to the selected cell output artifact', () => {
    const result = resolveWatermarkTarget(undefined, { outputArtifactId: 'vid-2' }, assets, addresses)
    expect(result).toEqual({ ok: true, artifactId: 'vid-2', label: 'vid-2' })
  })

  it('errors when nothing is targeted', () => {
    const result = resolveWatermarkTarget(undefined, null, assets, addresses)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('/watermark @a1')
  })

  it('errors when the ref is unknown', () => {
    const result = resolveWatermarkTarget('vid-missing', null, assets, addresses)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('vid-missing')
  })

  it('rejects non-video assets by cell address', () => {
    const result = resolveWatermarkTarget('img-1', null, assets, addresses)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('b2 is image')
  })

  it('treats a blank ref as absent', () => {
    const result = resolveWatermarkTarget('  ', { outputArtifactId: 'vid-1' }, assets, addresses)
    expect(result).toEqual({ ok: true, artifactId: 'vid-1', label: '@a1' })
  })
})
