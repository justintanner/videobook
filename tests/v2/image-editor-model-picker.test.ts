import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ImageEditorWorkspace } from '../../src/components/videobook/ImageEditorWorkspace'
import type { ImageEditModelOption } from '../../src/videobook/use-image-edit-models'
import type { ImageSubjectMap } from '../../src/videobook/image-subject-map'

const models: ImageEditModelOption[] = [
  {
    id: 'flux-3/klein-edit-image',
    label: 'FLUX 3 Klein Edit',
    provider: 'kie',
    capabilities: { semantic: true, regionReplace: true, wholeImage: true, exactMask: false },
    maxInputImages: 10,
    available: true,
  },
  {
    id: 'nano-banana-2-1',
    label: 'Nano Banana 2.1 Edit',
    provider: 'kie',
    capabilities: { semantic: true, regionReplace: true, wholeImage: true, exactMask: false },
    maxInputImages: 10,
    available: true,
  },
  {
    id: 'seedream/5-pro-image-to-image',
    label: 'Seedream 5 Pro',
    provider: 'kie',
    capabilities: { semantic: true, regionReplace: true, wholeImage: true, exactMask: false },
    maxInputImages: 10,
    available: true,
  },
  {
    id: 'alibaba/qwen-image-3/edit',
    label: 'Qwen 3.0 Edit',
    provider: 'fal',
    capabilities: { semantic: true, regionReplace: true, wholeImage: true, exactMask: false },
    maxInputImages: 3,
    available: false,
  },
  {
    id: 'text-only-model',
    label: 'Text-only Model',
    provider: 'kie',
    capabilities: { semantic: true, regionReplace: false, wholeImage: true, exactMask: false },
    maxInputImages: 1,
    available: true,
  },
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

describe('image editor model picker', () => {
  it('renders the labelled model select with catalog options between the instruction and Apply', () => {
    const html = renderEditor({ imageEditModels: models })
    expect(html).toContain('>Model</label>')
    for (const model of models) {
      expect(html).toContain(`value="${model.id}"`)
      expect(html).toContain(model.label)
    }
    expect(html).toContain('seedream/5-pro-image-to-image')
    expect(html.indexOf('image-editor-model')).toBeGreaterThan(html.indexOf('What should change?'))
    expect(html.indexOf('image-editor-model')).toBeLessThan(html.indexOf('image-editor-submit'))
  })

  it('prefills Nano Banana 2.1 from the catalog default', () => {
    const html = renderEditor({
      imageEditModels: models,
      defaultImageEditModelId: 'nano-banana-2-1',
    })
    expect(html).toMatch(/value="nano-banana-2-1"[^>]*selected/)
  })

  it('disables models that cannot serve the current target', () => {
    const html = renderEditor({ imageEditModels: models })
    // semantic target: every model supports semantic, nothing disabled
    expect(html).not.toContain('cannot edit this target')
  })

  it('allows semantic models to edit a drawn region without a replacement reference', () => {
    const html = renderEditor({
      imageEditModels: models,
      initialRegions: [{
        id: 'region-1',
        box: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 },
      }],
    })
    expect(html).not.toContain('cannot edit this target')
    expect(html).not.toContain('value="text-only-model" disabled')
    expect(html).toContain('Apply edit')
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
