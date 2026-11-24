import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import { CellStateOverlay } from '../../src/components/videobook/cell-overlays/CellStateOverlay'
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
  it('shows the provider and model under the clock while it generates', () => {
    const html = renderToStaticMarkup(createElement(CellStateOverlay, {
      kind: 'video',
      address: 'd2',
      status: 'generating',
      icon: null,
      generator: generationIdentity('kie', 'kie:minimax-h3/reference-to-video'),
      generation: true,
    }))

    expect(html).toContain('class="cell-state-meta" title="Kie · minimax-h3/reference-to-video"')
    expect(html).toContain('<span class="cell-generator-provider">Kie</span>')
    expect(html).toContain('<span class="cell-generator-model">minimax-h3/reference-to-video</span>')
    expect(html).not.toContain('kie:')
  })

  it('wears a provider and model chip on the finished preview instead of a footer badge', () => {
    const html = renderTile(generatedVideo())

    expect(html).toContain('class="cell-generator-chip" title="Kie · bytedance/seedance-2-5"')
    expect(html).toContain('<span class="cell-generator-provider">Kie</span>')
    expect(html).toContain('<span class="cell-generator-model">bytedance/seedance-2-5</span>')
    expect(html).not.toContain('kie:bytedance')
    expect(html).not.toContain('cell-media-badge-wide')
    expect(html).toContain('>9:16</span>')
  })

  it('falls back to the producer when the output cell names no generator', () => {
    const html = renderTile(generatedVideo({
      provider: undefined,
      model: undefined,
      producerProvider: 'machgen',
      producerModel: 'machgen:gemini-omni-1-2-flash',
    }))

    expect(html).toContain('class="cell-generator-chip" title="MachGen · gemini-omni-1-2-flash"')
  })

  it('leaves the chip off while the output generates or after it fails', () => {
    for (const status of ['generating', 'error']) {
      const html = renderTile(generatedVideo({ status, statusError: 'Provider output failed' }))
      expect(html).not.toContain('cell-generator-chip')
      expect(html).toContain('<span class="cell-generator-model">bytedance/seedance-2-5</span>')
    }
  })

  it('keeps an imported video free of the chip and keeps its footer generator badge', () => {
    const html = renderTile(generatedVideo({
      inputs: {},
      model: 'veo-3-fast',
      provider: undefined,
    }))

    expect(html).not.toContain('cell-generator-chip')
    expect(html).toContain('cell-media-badge cell-media-badge-wide')
  })

  it('starts the chip on the cell gutter and clips a long model instead of the provider', () => {
    const chip = rule('.cell-generator-chip')
    expect(declaration(chip, 'position')).toBe('absolute')
    expect(declaration(chip, 'left')).toBe('var(--cell-gutter)')
    expect(declaration(chip, 'bottom')).toBe('8px')
    expect(declaration(chip, 'max-width')).toBe('calc(100% - var(--cell-gutter) - 8px)')
    expect(declaration(chip, 'font-size')).toBe('var(--cell-label-font-size)')
    expect(declaration(rule('.cell-generator-provider'), 'flex')).toBe('none')
    expect(declaration(rule('.cell-generator-model'), 'text-overflow')).toBe('ellipsis')
    expect(declaration(rule('.cell-state-meta'), 'text-overflow')).toBeNull()
  })

  it('keeps the provider line whole while the generating stack tightens its gaps', () => {
    const meta = rule('.cell-state-clock-body > .cell-state-meta')
    expect(declaration(meta, 'flex')).toBe('none')
    expect(Number(declaration(meta, 'line-height'))).toBeGreaterThan(1)
    expect(declaration(rule('.cell-state-clock-body'), 'gap'))
      .toBe('min(calc(11px * var(--notebook-detail-scale, 1)), 11%)')
  })
})
