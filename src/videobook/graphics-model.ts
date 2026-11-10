import { z } from 'zod'
import { applyGraphicsEdits, type GraphicsEdit } from '../../server/src/graphics/edits'
import type { GraphicsLayerLayout } from '../../server/src/graphics/layout'
import { parseGraphicsDocument, type GraphicsDocument, type GraphicsTextSlot } from '../../server/src/graphics/model'
import { graphicsStillGroups } from '../../server/src/graphics/stills'

const renderSchema = z.object({
  request_id: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  job_id: z.number().nullable(),
  output_asset_id: z.string(),
  cell_id: z.string().nullable(),
  address: z.string().nullable(),
  error: z.string().nullable(),
})

const burnedSchema = z.object({
  request_id: z.string(),
  output: z.enum(['new', 'replace']),
  source_asset_id: z.string(),
  source_hash: z.string(),
  rendered_at: z.string(),
  layers: z.array(z.object({ id: z.string(), kind: z.string(), name: z.string() })),
})

const imageSchema = z.object({
  label: z.string().nullable(),
  url: z.string().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
})

const readSchema = z.object({
  asset_id: z.string(),
  address: z.string().nullable(),
  label: z.string().nullable(),
  source: z.object({ width: z.number(), height: z.number(), duration_seconds: z.number(), fps: z.number(), source_hash: z.string() }),
  saved: z.boolean(),
  revision: z.string(),
  updated_at: z.string().nullable(),
  document: z.unknown(),
  fill: z.object({ handle: z.string().nullable(), profile_url: z.string().nullable(), credit: z.string().nullable() }),
  starters: z.array(z.object({ id: z.string(), name: z.string(), document: z.unknown() })),
  images: z.record(z.string(), imageSchema),
  render: renderSchema.nullable(),
  burned: burnedSchema.nullable(),
})

type ReadWire = z.infer<typeof readSchema>
export type GraphicsStarterChoice = { id: string; name: string; document: GraphicsDocument }
export type GraphicsRead = Omit<ReadWire, 'document' | 'starters'> & { document: GraphicsDocument; starters: GraphicsStarterChoice[] }
export type GraphicsRenderStatus = z.infer<typeof renderSchema>
export type GraphicsBurned = z.infer<typeof burnedSchema>
export type GraphicsRenderOutput = 'new' | 'replace'
export type GraphicsOverlayImages = Record<string, { src: string; width: number; height: number }>

function documentOf(value: unknown): GraphicsDocument {
  const parsed = parseGraphicsDocument(value)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.document
}

export function parseGraphicsRead(value: unknown): GraphicsRead {
  const read = readSchema.parse(value)
  return {
    ...read,
    document: documentOf(read.document),
    starters: read.starters.map((starter) => ({ id: starter.id, name: starter.name, document: documentOf(starter.document) })),
  }
}

export function parseGraphicsRender(value: unknown): GraphicsRenderStatus {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>).render : null
  return renderSchema.parse(record)
}

export interface GraphicsToolError {
  status: string
  message: string
  revision: string | null
  layerId: string | null
}

function text(record: Record<string, unknown>, key: string): string | null {
  return typeof record[key] === 'string' ? record[key] as string : null
}

export function graphicsToolError(error: unknown): GraphicsToolError {
  const message = error instanceof Error ? error.message : String(error)
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>
    return { status: text(parsed, 'status') ?? 'error', message: text(parsed, 'message') ?? message, revision: text(parsed, 'revision'), layerId: text(parsed, 'layer_id') }
  } catch {
    return { status: 'error', message, revision: null, layerId: null }
  }
}

export interface GraphicsTarget {
  artifactId: string
  kind: 'video' | 'final'
  label: string
  mediaUrl: string
  address: string | null
  notebookId: string | null
  image: string | null
}

type EditorAsset = { id: string; artifactId: string; label: string; type: string; status: string; mediaUrl: string | null }
type EditorMention = { artifactId: string; cellAddress: string }
type TargetInput = { reference: string | undefined; image: string | undefined; assets: readonly EditorAsset[]; mentions: readonly EditorMention[]; notebookId: string | null }

function resolveAsset(reference: string | undefined, assets: readonly EditorAsset[], mentions: readonly EditorMention[]): EditorAsset | undefined {
  const key = reference?.trim().replace(/^@/u, '').toLowerCase()
  if (!key) return undefined
  const mention = mentions.find((entry) => entry.cellAddress.toLowerCase() === key)
  return assets.find((asset) => asset.artifactId.toLowerCase() === key || asset.id.toLowerCase() === key || asset.artifactId === mention?.artifactId)
}

export function graphicsEditorTarget(input: TargetInput): { ok: true; target: GraphicsTarget } | { ok: false; message: string } {
  const asset = resolveAsset(input.reference, input.assets, input.mentions)
  if (!asset || (asset.type !== 'video' && asset.type !== 'final')) return { ok: false, message: 'On-screen graphics go on a video. Choose a video cell.' }
  if (asset.status !== 'ready' || !asset.mediaUrl) return { ok: false, message: 'Wait for the video to finish processing before adding graphics.' }
  const image = input.image ? resolveAsset(input.image, input.assets, input.mentions) : undefined
  if (input.image && (!image || image.type !== 'image')) return { ok: false, message: `${input.image} is not an image in this book.` }
  return {
    ok: true,
    target: {
      artifactId: asset.artifactId,
      kind: asset.type === 'final' ? 'final' : 'video',
      label: asset.label,
      mediaUrl: asset.mediaUrl,
      address: input.mentions.find((mention) => mention.artifactId === asset.artifactId)?.cellAddress ?? null,
      notebookId: input.notebookId,
      image: image?.artifactId ?? null,
    },
  }
}

export function graphicsImageEdits(document: GraphicsDocument, image: string | null): GraphicsEdit[] {
  if (!image || document.layers.some((layer) => layer.kind === 'image' && layer.artifactId === image)) return []
  return [{ op: 'add_layer', layer: { kind: 'image', artifactId: image } }]
}

export function graphicsRenderQueuedMessage(output: GraphicsRenderOutput, target: { label: string; address: string | null }): string {
  const name = target.address ? `@${target.address}` : target.label
  return output === 'replace'
    ? `Burning graphics into ${name}. The video updates in place when the render finishes.`
    : `Rendering graphics for ${name}. The copy appears below it when the render finishes.`
}

export const GRAPHICS_QUICK_FIELDS: ReadonlyArray<{ slot: GraphicsTextSlot; label: string; placeholder: string; lines: number }> = [
  { slot: 'headline', label: 'Headline', placeholder: 'Big title', lines: 2 },
  { slot: 'secondary', label: 'Second line', placeholder: 'A line under the title', lines: 1 },
  { slot: 'credit', label: 'Credit', placeholder: 'Platform/@handle', lines: 1 },
]

export function graphicsSlotText(document: GraphicsDocument, slot: GraphicsTextSlot): string | null {
  for (const layer of document.layers) {
    if (layer.kind !== 'text') continue
    const item = layer.items.find((entry) => entry.slot === slot)
    if (item) return item.text
  }
  return null
}

export function graphicsFillSuggestion(read: GraphicsRead, slot: GraphicsTextSlot): string | null {
  if (slot === 'credit') return read.fill.credit
  if (slot === 'handle') return read.fill.handle
  return null
}

function clipped(value: string): string {
  const single = value.replace(/\s+/gu, ' ').trim()
  return single.length > 32 ? `${single.slice(0, 31).trimEnd()}…` : single
}

export function graphicsLayoutWarnings(document: GraphicsDocument, layout: readonly GraphicsLayerLayout[] | null): string[] {
  if (!layout) return []
  const layers = new Map(document.layers.map((layer) => [layer.id, layer]))
  return layout.flatMap((entry) => {
    const layer = layers.get(entry.layerId)
    if (!layer) return []
    if (entry.kind === 'image' && entry.missing) return [`${layer.name}: the image is missing, so nothing is drawn.`]
    if (entry.kind !== 'text' || layer.kind !== 'text') return []
    const items = new Map(layer.items.map((item) => [item.id, item]))
    return entry.items.filter((item) => item.overflow).map((item) => `${layer.name}: “${clipped(items.get(item.itemId)?.text ?? '')}” does not fit, so it is drawn at the smallest size.`)
  })
}

export function graphicsRenderBlocker(document: GraphicsDocument | null, durationSeconds: number | null, conflict: boolean): string | null {
  if (conflict) return 'Reload the graphics or keep your version before rendering.'
  if (!document || durationSeconds === null) return 'The graphics are still loading.'
  if (graphicsStillGroups(document, durationSeconds).length === 0) return 'Add text, an image, a QR code or a shade to render.'
  return null
}

export function graphicsBurnedNotice(burned: GraphicsBurned | null, artifactId: string): { message: string; sourceId: string | null } | null {
  if (!burned) return null
  if (burned.output === 'new' && burned.source_asset_id !== artifactId) {
    return { message: 'This video is a copy with graphics already drawn in. Rendering it again draws them twice.', sourceId: burned.source_asset_id }
  }
  return { message: 'Graphics are already burned into this video. Rendering again draws the new ones on top.', sourceId: null }
}

export interface GraphicsHistory {
  document: GraphicsDocument
  past: GraphicsDocument[]
  future: GraphicsDocument[]
  coalesceKey: string | null
}

const HISTORY_LIMIT = 100

export function editGraphicsHistory(history: GraphicsHistory, edits: readonly GraphicsEdit[], coalesceKey: string | null): { ok: true; history: GraphicsHistory } | { ok: false; message: string } {
  const result = applyGraphicsEdits(history.document, edits)
  if (!result.ok) return { ok: false, message: result.error.message }
  if (result.document === history.document) return { ok: true, history }
  const coalesce = coalesceKey !== null && coalesceKey === history.coalesceKey
  return {
    ok: true,
    history: {
      document: result.document,
      past: coalesce ? history.past : [...history.past, history.document].slice(-HISTORY_LIMIT),
      future: [],
      coalesceKey,
    },
  }
}

export function stepGraphicsHistory(history: GraphicsHistory, direction: 'undo' | 'redo'): GraphicsHistory | null {
  const target = (direction === 'undo' ? history.past : history.future).at(-1)
  if (!target) return null
  return {
    document: target,
    past: direction === 'undo' ? history.past.slice(0, -1) : [...history.past, history.document],
    future: direction === 'undo' ? [...history.future, history.document] : history.future.slice(0, -1),
    coalesceKey: null,
  }
}

export function graphicsOverlayImages(read: GraphicsRead | null): GraphicsOverlayImages {
  if (!read) return {}
  return Object.fromEntries(Object.entries(read.images).flatMap(([id, image]) => (
    image.url && image.width && image.height ? [[id, { src: image.url, width: image.width, height: image.height }]] : []
  )))
}
