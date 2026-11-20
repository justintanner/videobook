import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ImageEditorWorkspace } from '../../src/components/videobook/ImageEditorWorkspace'
import type { ImageEditModelOption } from '../../src/videobook/use-image-edit-models'
import type { ImageSubjectMap } from '../../src/videobook/image-subject-map'

const capabilities = { semantic: true, regionReplace: true, wholeImage: true, exactMask: false }

function editModel(
  id: string,
  family: string,
  provider: 'kie' | 'fal',
  overrides: Partial<ImageEditModelOption> = {},
): ImageEditModelOption {
  return {
    id,
    label: family,
    family: { id: `image:${family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, title: family },
    provider,
    providerLabel: provider === 'kie' ? 'Kie' : 'Fal',
    operation: 'edit_image',
    frontier: [],
    capabilities,
    maxInputImages: 10,
    available: true,
    ...overrides,
  }
}

function editRanking(priceLabel: string) {
  return {
    type: 'i2i' as const,
    rank: 9,
    elo: 1152,
    priceLabel,
    sourceUrl: 'https://artificialanalysis.ai/image/leaderboard/editing',
    capturedOn: '2026-11-16',
  }
}

const models: ImageEditModelOption[] = [
  editModel('flux-3/klein-edit-image', 'FLUX 3 Klein', 'kie'),
  editModel('nano-banana-2-1', 'Nano Banana 2.1', 'kie', { frontier: [editRanking('0.02-0.045 USD/image')] }),
  editModel('google/nano-banana-2.1/edit', 'Nano Banana 2.1', 'fal', {
    frontier: [editRanking('dynamic')],
    available: false,
  }),
  editModel('seedream/5-pro-image-to-image', 'Seedream 5 Pro', 'kie'),
  editModel('alibaba/qwen-image-3/edit', 'Qwen Image 3', 'fal', { maxInputImages: 3, available: false }),
  editModel('text-only-model', 'Text-only Model', 'kie', {
    capabilities: { ...capabilities, regionReplace: false },
    maxInputImages: 1,
  }),
]

const subjectMap: ImageSubjectMap = {
  status: 'ready',
  artifactId: 'artifact-1',
  objectHash: 'hash-1',
  width: 100,
  height: 100,
  baseUrl: null,
  jobId: 'job-1',
  startedAt: '2026-10-02T05:28:02Z',
  error: null,
  subjects: [{
    id: 'person',
    label: 'Foreground person',
    description: 'Person nearest the camera',
    color: '#ef4444',
    box: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 },
    layerUrl: 'https://example.test/person.png',
    thumbnailUrl: 'https://example.test/person.png',
    zIndex: 1,
    removable: true,
    exactEdit: false,
  }],
}

function renderEditor(overrides: {
  instruction?: string
  imageEditModels?: readonly ImageEditModelOption[]
  imageEditModelsLoading?: boolean
  defaultImageEditModelId?: string | null
  initialRegions?: readonly { id: string, box: { x: number, y: number, width: number, height: number } }[]
}) {
  return renderToStaticMarkup(createElement(ImageEditorWorkspace, {
    instruction: '',
    onInstructionChange: () => undefined,
    address: 'c3',
    mediaUrl: 'https://example.test/source.png',
    width: 100,
    height: 100,
    details: null,
    subjectMap,
    subjectMapLoading: false,
    analysisUnavailableReason: null,
    replacementCandidates: [],
    closeRef: { current: null },
    onBack: () => undefined,
    onClose: () => undefined,
    ...overrides,
  }))
}

function selectMarkup(html: string, label: string): string {
  const match = html.match(new RegExp(`<select[^>]*aria-label="${label}"[^>]*>.*?</select>`))
  expect(match, label).not.toBeNull()
  return match![0]
}

function optionText(select: string, value: string): string {
  const match = select.match(new RegExp(`<option value="${value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"[^>]*>(.*?)</option>`))
  return match?.[1]?.replace(/<!-- -->/g, '') ?? ''
}

describe('image editor model picker', () => {
  it('renders Model and Provider selects between the instruction and Apply', () => {
    const html = renderEditor({ imageEditModels: models })
    expect(html).toContain('>Model</label>')
    expect(html).toContain('>Provider</label>')
    const family = selectMarkup(html, 'Generation model')
    expect(family.match(/<option /g)).toHaveLength(5)
    expect(optionText(family, 'image:nano-banana-2-1')).toBe('#9 · Nano Banana 2.1 · Elo 1152')
    expect(optionText(family, 'image:seedream-5-pro')).toBe('Seedream 5 Pro')
    expect(family.indexOf('Frontier models')).toBeLessThan(family.indexOf('Other models'))
    expect(family.indexOf('Other models')).toBeLessThan(family.indexOf('Unavailable · provider not configured'))
    expect(family.indexOf('Unavailable · provider not configured')).toBeLessThan(family.indexOf('image:qwen-image-3'))
    expect(html.indexOf('image-editor-model')).toBeGreaterThan(html.indexOf('What should change?'))
    expect(html.indexOf('image-editor-model')).toBeLessThan(html.indexOf('image-editor-submit'))
  })

  it('prefills Nano Banana 2.1 on Kie from the catalog default and offers Fal beside it', () => {
    const html = renderEditor({
      imageEditModels: models,
      defaultImageEditModelId: 'nano-banana-2-1',
    })
    expect(selectMarkup(html, 'Generation model')).toMatch(/value="image:nano-banana-2-1"[^>]*selected/)
    const provider = selectMarkup(html, 'Generation provider')
    expect(provider).not.toMatch(/<select[^>]*disabled/)
    expect(provider).toMatch(/value="nano-banana-2-1"[^>]*selected/)
    expect(optionText(provider, 'nano-banana-2-1')).toBe('Kie · 0.02-0.045 USD/image')
    expect(optionText(provider, 'google/nano-banana-2.1/edit')).toBe('Fal · dynamic · not configured')
  })

  it('keeps a saved Fal endpoint selected in its family', () => {
    const html = renderEditor({
      imageEditModels: models,
      defaultImageEditModelId: 'google/nano-banana-2.1/edit',
    })
    expect(selectMarkup(html, 'Generation model')).toMatch(/value="image:nano-banana-2-1"[^>]*selected/)
    expect(selectMarkup(html, 'Generation provider')).toMatch(/value="google\/nano-banana-2.1\/edit"[^>]*selected/)
  })

  it('disables the Provider select for a single-provider model', () => {
    const html = renderEditor({ imageEditModels: models, defaultImageEditModelId: 'seedream/5-pro-image-to-image' })
    const provider = selectMarkup(html, 'Generation provider')
    expect(provider).toMatch(/<select[^>]*disabled/)
    expect(provider.match(/<option /g)).toHaveLength(1)
    expect(optionText(provider, 'seedream/5-pro-image-to-image')).toBe('Kie')
  })

  it('allows every model to edit a drawn region without a replacement reference', () => {
    const html = renderEditor({
      imageEditModels: models,
      initialRegions: [{
        id: 'region-1',
        box: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 },
      }],
    })
    expect(html).not.toContain('incompatible')
    expect(html).toContain('Apply edit')
  })

  it('marks models that cannot replace a region with a reference image', () => {
    const html = renderEditor({
      imageEditModels: models,
      instruction: 'Swap in @a2',
      defaultImageEditModelId: 'text-only-model',
    })
    const family = selectMarkup(html, 'Generation model')
    expect(family).toMatch(/value="image:text-only-model" disabled/)
    expect(optionText(family, 'image:text-only-model')).toBe('Text-only Model · incompatible')
    expect(optionText(selectMarkup(html, 'Generation provider'), 'text-only-model')).toBe('Kie · incompatible')
  })

  it('shows the estimate placeholder until a provider cost resolves', () => {
    const html = renderEditor({ imageEditModels: models })
    expect(html).toContain('Cost estimate unavailable')
  })

  it('shows a loading state and hides the picker without a catalog', () => {
    const loading = renderEditor({ imageEditModels: [], imageEditModelsLoading: true })
    expect(loading).not.toContain('>Model</label>')
    expect(loading).not.toContain('image-editor-model')
    const empty = renderEditor({})
    expect(empty).not.toContain('>Model</label>')
  })
})
