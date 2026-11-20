import { DEFAULT_IMAGE_EDIT_MODEL_ID } from '../../server/src/image-edit-default'
import type { ModelFrontierRanking } from '../../server/src/media/frontier'
import { useCallback, useRef, useState } from 'react'
import { parseFrontierRankings } from './generation-frontier'
import type { GenerationFamily } from './notebook-generation-actions'
import { nonBlankStringValue, recordValue } from './value-decoders'

export interface ImageEditModelOption {
  id: string
  label: string
  family: GenerationFamily
  variant?: string
  provider: 'kie' | 'fal'
  providerLabel: string
  operation: 'edit_image'
  frontier: ModelFrontierRanking[]
  capabilities: {
    semantic: boolean
    regionReplace: boolean
    wholeImage: boolean
    exactMask: boolean
  }
  maxInputImages: number | null
  available: boolean
}

export interface ImageEditModelCatalog {
  models: ImageEditModelOption[]
  defaultModelId: string
  lastUsedModelId: string | null
}

type ImageEditModelsCallTool = (
  tool: string,
  args: Record<string, unknown>,
  options?: { background?: boolean },
) => Promise<unknown>

export interface ImageEditModelsState extends ImageEditModelCatalog {
  loading: boolean
  error: string | null
  ensureLoaded: (bookId: string) => void
}

const providerLabels = { kie: 'Kie', fal: 'Fal' } as const

function parseModelFamily(value: unknown, id: string, label: string): GenerationFamily {
  const record = recordValue(value)
  const familyId = nonBlankStringValue(record?.id)
  const title = nonBlankStringValue(record?.title)
  return familyId && title ? { id: familyId, title } : { id, title: label }
}

function parseModelCapabilities(value: unknown): ImageEditModelOption['capabilities'] | null {
  const record = recordValue(value)
  if (!record) return null
  const flag = (name: string) => record[name] === true
  return {
    semantic: flag('semantic'),
    regionReplace: flag('regionReplace'),
    wholeImage: flag('wholeImage'),
    exactMask: flag('exactMask'),
  }
}

function parseImageEditModelCatalog(payload: unknown): ImageEditModelCatalog {
  const record = recordValue(payload)
  const rawModels = Array.isArray(record?.models) ? record.models : []
  const models: ImageEditModelOption[] = []
  for (const entry of rawModels) {
    const item = recordValue(entry)
    const id = nonBlankStringValue(item?.id)
    const label = nonBlankStringValue(item?.label)
    const provider = nonBlankStringValue(item?.provider)
    const capabilities = parseModelCapabilities(item?.capabilities)
    if (!id || !label || (provider !== 'kie' && provider !== 'fal') || !capabilities) continue
    const maxInputImages = typeof item?.max_input_images === 'number'
      && Number.isFinite(item.max_input_images)
      ? item.max_input_images
      : null
    const variant = nonBlankStringValue(item?.variant)
    models.push({
      id,
      label,
      family: parseModelFamily(item?.family, id, label),
      ...(variant ? { variant } : {}),
      provider,
      providerLabel: providerLabels[provider],
      operation: 'edit_image',
      frontier: parseFrontierRankings(item?.frontier),
      capabilities,
      maxInputImages,
      available: item?.available === true,
    })
  }
  return {
    models,
    defaultModelId: nonBlankStringValue(record?.default_model) ?? models[0]?.id ?? DEFAULT_IMAGE_EDIT_MODEL_ID,
    lastUsedModelId: nonBlankStringValue(record?.last_used_model),
  }
}

export function useImageEditModels({
  callTool,
  ready,
}: {
  callTool: ImageEditModelsCallTool
  ready: boolean
}): ImageEditModelsState {
  const [catalog, setCatalog] = useState<ImageEditModelCatalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlightRef = useRef<Promise<void> | null>(null)
  const loadedBookRef = useRef<string | null>(null)

  const ensureLoaded = useCallback((bookId: string) => {
    if (!ready) return
    if (inFlightRef.current) return
    if (loadedBookRef.current === bookId && catalog) return
    setLoading(true)
    setError(null)
    const request = callTool('list_image_edit_models', { book_id: bookId }, { background: true })
      .then((value) => {
        if (inFlightRef.current !== request) return
        inFlightRef.current = null
        loadedBookRef.current = bookId
        setCatalog(parseImageEditModelCatalog(value))
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (inFlightRef.current !== request) return
        inFlightRef.current = null
        setError(cause instanceof Error ? cause.message : String(cause))
        setLoading(false)
      })
    inFlightRef.current = request
  }, [callTool, catalog, ready])

  return {
    models: catalog?.models ?? [],
    defaultModelId: catalog?.defaultModelId ?? DEFAULT_IMAGE_EDIT_MODEL_ID,
    lastUsedModelId: catalog?.lastUsedModelId ?? null,
    loading,
    error,
    ensureLoaded,
  }
}
