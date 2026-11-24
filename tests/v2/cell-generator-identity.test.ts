import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import { CellNode } from '../../src/components/videobook/NotebookCanvasNodes'
import type { CanvasCellData, CanvasNode } from '../../src/videobook/notebook-canvas'
import { generationIdentity } from '../../src/videobook/output-generation'
import type { AssetRecord } from '../../src/videobook/workspace-responses'

const css = readFileSync(new URL('../../src/index.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  const openAt = css.indexOf(`\n${selector} {`)
  if (openAt < 0) throw new Error(`missing rule ${selector}`)
  const bodyStart = css.indexOf('{', openAt)
  return css.slice(bodyStart + 1, css.indexOf('}', bodyStart))
}

function declaration(block: string, property: string): string | null {
  return block.match(new RegExp(`(?:^|\\n)\\s*${property}:\\s*([^;]+);`))?.[1] ?? null
}

function videoAsset(): AssetRecord {
  return {
    id: 'asset-d1',
    artifactId: 'artifact-d1',
    label: 'pier',
    objectHash: null,
    type: 'video',
    createdAt: '2026-11-20T12:00:00.000Z',
    mediaUrl: '/media/d1.mp4',
    thumbnailUrl: '/media/d1.jpg',
    status: 'ready',
    origin: null,
    prompt: null,
    width: 720,
    height: 1280,
    duration: 13,
    fps: 24,
    waveform: null,
    audioInfo: null,
    analysisInfo: null,
    transcript: null,
    visionAnalysis: null,
    tags: null,
  }
}

function generatedVideo(overrides: Partial<CanvasCellData> = {}): CanvasCellData {
  return {
    kind: 'video',
    subtitle: 'VIDEO · CELL',
    slot: { row: 3, column: 0 },
    status: 'ready',
    provider: 'kie',
    model: 'kie:bytedance/seedance-2-5',
    outputArtifactId: 'artifact-d1',
    inputs: { mediaRole: 'generate-video-output', producerCellId: 'producer-b4' },
    asset: videoAsset(),
    videoAspectRatio: '9:16',
    videoDurationSeconds: 13,
    ...overrides,
  }
}

function renderTile(data: CanvasCellData): string {
  const props: NodeProps<CanvasNode> = {
    id: 'cell-d1',
    data,
    type: 'cell',
    dragging: false,
    zIndex: 0,
    selectable: true,
    deletable: true,
    selected: false,
    draggable: true,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  }
  return renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(CellNode, props)))
}

describe('generationIdentity', () => {
  it('names the provider once and drops its prefix from the model', () => {
    expect(generationIdentity('kie', 'kie:minimax-h3/reference-to-video')).toEqual({
      provider: 'Kie',
      model: 'minimax-h3/reference-to-video',
      label: 'Kie · minimax-h3/reference-to-video',
    })
    expect(generationIdentity('wavespeed', 'wavespeed:skyreels/v4/image-to-video')?.label)
      .toBe('WaveSpeed · skyreels/v4/image-to-video')
  })

  it('keeps a model that carries no prefix of its provider', () => {
    expect(generationIdentity('fal', 'bytedance/seedance-2-5')?.model).toBe('bytedance/seedance-2-5')
    expect(generationIdentity('fal', 'kie:bytedance/seedance-2-5')?.model).toBe('kie:bytedance/seedance-2-5')
  })

  it('names whichever half is known and nothing when neither is', () => {
    expect(generationIdentity(null, 'kie:bytedance/seedance-2-5')).toEqual({
      provider: null,
      model: 'kie:bytedance/seedance-2-5',
      label: 'kie:bytedance/seedance-2-5',
    })
    expect(generationIdentity('kie', undefined)).toEqual({ provider: 'Kie', model: null, label: 'Kie' })
    expect(generationIdentity(undefined, undefined)).toBeNull()
    expect(generationIdentity('', '')).toBeNull()
  })
})

describe('a generated output tile', () => {
  it('names the provider and model in the source chip on the top edge, not on the picture', () => {
    const html = renderTile(generatedVideo())

    expect(html).toContain('class="cell-route-badge cell-route-badge-incoming"')
    expect(html).toContain('class="cell-route-generator" title="Kie · bytedance/seedance-2-5"')
    expect(html).toContain('<span class="cell-generator-provider">Kie</span>')
    expect(html).toContain('<span class="cell-generator-model">bytedance/seedance-2-5</span>')
    expect(html).toContain('<span class="sr-only">Made with Kie · bytedance/seedance-2-5</span>')
    expect(html).not.toContain('kie:bytedance')
    expect(html).not.toContain('cell-generator-chip')
    expect(html).not.toContain('cell-media-badge-wide')
    expect(html).toContain('>9:16</span>')
  })

  it('follows the gen cell link with the generator in one chip', () => {
    const html = renderTile(generatedVideo({
      incomingRoutes: [{ address: '@b4', tokens: [], type: 'generate_video' }],
    }))

    expect(html).toContain('<span class="sr-only">Fed by @b4 · Made with Kie · bytedance/seedance-2-5</span>')
    expect(html).toMatch(/<span class="cell-route-address">b4<\/span><\/span><span class="cell-route-detail"><span class="cell-route-generator"/u)
  })

  it('falls back to the producer when the output cell names no generator', () => {
    const html = renderTile(generatedVideo({
      provider: undefined,
      model: undefined,
      producerProvider: 'machgen',
      producerModel: 'machgen:gemini-omni-1-2-flash',
    }))

    expect(html).toContain('class="cell-route-generator" title="MachGen · gemini-omni-1-2-flash"')
  })

  it('keeps the generator in the chip while the output generates or after it fails', () => {
    for (const status of ['generating', 'error']) {
      const html = renderTile(generatedVideo({ status, statusError: 'Provider output failed' }))
      expect(html).toContain('<span class="cell-generator-model">bytedance/seedance-2-5</span>')
      expect(html).not.toContain('cell-state-meta')
    }
  })

  it('shortens the mode phrase in the chip and keeps the full name in its title', () => {
    const html = renderTile(generatedVideo({ model: 'kie:minimax-h3/reference-to-video' }))

    expect(html).toContain('class="cell-route-generator" title="Kie · minimax-h3/reference-to-video"')
    expect(html).toContain('<span class="cell-generator-model">minimax-h3/R2V</span>')
  })

  it('moves an imported video\'s model into the chip and keeps the footer to shape and length', () => {
    const html = renderTile(generatedVideo({
      inputs: {},
      model: 'veo-3-fast',
      provider: undefined,
    }))

    expect(html).toContain('class="cell-route-generator" title="veo-3-fast"')
    expect(html).not.toContain('cell-media-badge-wide')
    expect(html).toContain('<time class="cell-node-footer-meter" dateTime="PT13S" title="Duration">0:13</time>')
  })

  it('names the source clip and the moment for a frame pulled from a video', () => {
    const html = renderTile(generatedVideo({
      kind: 'image',
      inputs: { mediaRole: 'extract-frame-output' },
      provider: undefined,
      model: undefined,
      asset: { ...videoAsset(), type: 'image', duration: null },
      frameProvenance: { sourceAddress: '@d3', atSeconds: 7 },
    }))

    expect(html).toContain('<span class="cell-route-time">d3 · 0:07</span>')
    expect(html).toContain('<span class="sr-only">Frame at 0:07</span>')
  })

  it('lets the generator shrink inside the chip while the provider stays whole', () => {
    const detail = rule('.cell-route-detail')
    expect(declaration(detail, 'min-width')).toBe('0')
    expect(declaration(detail, 'pointer-events')).toBe('auto')
    expect(declaration(rule('.cell-route-generator'), 'overflow')).toBe('hidden')
    expect(declaration(rule('.cell-generator-provider'), 'flex')).toBe('none')
    expect(declaration(rule('.cell-generator-model'), 'text-overflow')).toBe('ellipsis')
    expect(css).not.toContain('.cell-generator-chip')
    expect(css).not.toContain('.cell-state-meta')
  })
})
