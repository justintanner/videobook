import { z } from 'zod'
import { applyGraphicsEdits, type GraphicsEdit } from '../../server/src/graphics/edits'
import type { GraphicsLayerLayout, GraphicsRect } from '../../server/src/graphics/layout'
import {
  GRAPHICS_ANCHORS,
  GRAPHICS_SPACES,
  graphicsDocumentFromLayers,
  isGraphicsUrl,
  MAX_GRAPHICS_NAME_LENGTH,
  nextGraphicsId,
  parseGraphicsDocument,
  type GraphicsAnchor,
  type GraphicsDocument,
  type GraphicsLayer,
  type GraphicsLayerKind,
  type GraphicsQrLayer,
  type GraphicsQrLayerInput,
  type GraphicsSlot,
  type GraphicsTextSlot,
} from '../../server/src/graphics/model'
import {
  GRAPHICS_SUGGEST_KINDS,
  GRAPHICS_SUGGEST_LANGUAGES,
  GRAPHICS_SUGGEST_SLOTS,
  graphicsSlotValues,
  type GraphicsSuggestKind,
  type GraphicsSuggestLanguage,
} from '../../server/src/graphics/slots'
import { GRAPHICS_BLOCK_SLOTS, graphicsSlotBlock, type GraphicsBlockText } from '../../server/src/graphics/starters'
import {
  graphicsDrawnBox,
  graphicsLayerCovers,
  graphicsLayerWindow,
  graphicsPlacementTimes,
  graphicsUncheckedTimes,
  type GraphicsClearSpot,
  type GraphicsCover,
} from '../../server/src/graphics/placement'
import { graphicsStillGroups } from '../../server/src/graphics/stills'
import { watermarkDrawnDocument } from '../../server/src/graphics/watermark-burn'
import { isWatermarkPlatform, WATERMARK_PLATFORM_LABELS, WATERMARK_PLATFORMS, type WatermarkPlatform } from '../../server/src/watermark-platform'

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

const templateSchema = z.object({
  id: z.string(),
  name: z.string(),
  updated_at: z.string(),
  document: z.unknown(),
  missing_layer_ids: z.array(z.string()),
})

const watermarkSchema = z.object({
  platform: z.enum(WATERMARK_PLATFORMS),
  template_id: z.string().nullable(),
  template_name: z.string().nullable(),
  look: z.unknown(),
  qr: z.record(z.string(), z.unknown()).nullable(),
})

const regionFrameSchema = z.object({
  time: z.number(),
  regions: z.array(z.object({
    kind: z.enum(['face', 'text', 'graphic']),
    confidence: z.number(),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  })),
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
  templates: z.array(templateSchema).default([]),
  default_template_id: z.string().default('tiktok-title'),
  images: z.record(z.string(), imageSchema),
  render: renderSchema.nullable(),
  burned: burnedSchema.nullable(),
  watermark: watermarkSchema.nullable().default(null),
  regions: z.array(regionFrameSchema).default([]),
})

type ReadWire = z.infer<typeof readSchema>
type GraphicsStarterChoice = { id: string; name: string; document: GraphicsDocument }
type GraphicsSavedTemplate = Omit<z.infer<typeof templateSchema>, 'document'> & { document: GraphicsDocument }
type GraphicsWatermarkRead = Omit<z.infer<typeof watermarkSchema>, 'look' | 'qr'> & { look: GraphicsDocument; qr: GraphicsQrLayerInput | null }
export type GraphicsRead = Omit<ReadWire, 'document' | 'starters' | 'templates' | 'watermark'> & {
  document: GraphicsDocument
  starters: GraphicsStarterChoice[]
  templates: GraphicsSavedTemplate[]
  watermark: GraphicsWatermarkRead | null
}
export type GraphicsRenderStatus = z.infer<typeof renderSchema>
export type GraphicsBurned = z.infer<typeof burnedSchema>
export type GraphicsRenderOutput = 'new' | 'replace'
export type GraphicsOverlayImages = Record<string, { src: string; width: number; height: number }>

function documentOf(value: unknown): GraphicsDocument {
  const parsed = parseGraphicsDocument(value)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.document
}

function qrLayerInput(value: Record<string, unknown> | null): GraphicsQrLayerInput | null {
  if (!value || value.kind !== 'qr') return null
  const input = value as GraphicsQrLayerInput
  return parseGraphicsDocument(graphicsDocumentFromLayers([input])).ok ? input : null
}

export function parseGraphicsRead(value: unknown): GraphicsRead {
  const read = readSchema.parse(value)
  return {
    ...read,
    document: documentOf(read.document),
    starters: read.starters.map((starter) => ({ id: starter.id, name: starter.name, document: documentOf(starter.document) })),
    templates: read.templates.map((template) => ({ ...template, document: documentOf(template.document) })),
    watermark: read.watermark && { ...read.watermark, look: documentOf(read.watermark.look), qr: qrLayerInput(read.watermark.qr) },
  }
}

export interface GraphicsTemplateChoice {
  id: string
  name: string
  document: GraphicsDocument
  saved: boolean
  isDefault: boolean
  missingImages: number
}

export function graphicsTemplateChoices(read: GraphicsRead): GraphicsTemplateChoice[] {
  const starters = read.starters.map((starter) => ({ ...starter, saved: false, missingImages: 0 }))
  const saved = read.templates.map((template) => ({ id: template.id, name: template.name, document: template.document, saved: true, missingImages: template.missing_layer_ids.length }))
  return [...starters, ...saved].map((choice) => ({ ...choice, isDefault: choice.id === read.default_template_id }))
}

export type GraphicsTemplateOp = 'save_template' | 'rename_template' | 'delete_template' | 'set_default_template' | 'copy_templates' | 'save_watermark' | 'set_watermark_template'

const templateResultSchema = z.object({ template: z.object({ name: z.string() }).optional() })

const copyResultSchema = z.object({
  from_book_name: z.string(),
  copied: z.array(z.object({ name: z.string() })),
  skipped: z.array(z.object({ name: z.string() })),
  missing_images: z.array(z.string()),
})

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function copyMessage(value: unknown): string {
  const copy = copyResultSchema.parse(value)
  const parts = [copy.copied.length > 0 ? `Copied ${counted(copy.copied.length, 'template')} from ${copy.from_book_name}.` : `No new templates to copy from ${copy.from_book_name}.`]
  if (copy.skipped.length > 0) parts.push(`Skipped ${copy.skipped.map((template) => template.name).join(', ')}: that name is already used here.`)
  if (copy.missing_images.length > 0) {
    parts.push(`${counted(copy.missing_images.length, 'image')} ${copy.missing_images.length === 1 ? 'was' : 'were'} missing in ${copy.from_book_name}, so ${copy.missing_images.length === 1 ? 'its layer is' : 'their layers are'} kept and marked missing.`)
  }
  return parts.join(' ')
}

function watermarkMessage(op: 'save_watermark' | 'set_watermark_template', value: unknown, platform: WatermarkPlatform): string {
  const label = WATERMARK_PLATFORM_LABELS[platform]
  if (op === 'set_watermark_template') return `Goal finishing and apply_watermark burn the ${label} profile’s watermark again.`
  const name = templateResultSchema.parse(value).template?.name ?? `${label} watermark`
  return `Saved as the default ${label} watermark (“${name}”). Goal finishing and apply_watermark burn it from now on.`
}

export function graphicsTemplateMessage(op: GraphicsTemplateOp, value: unknown, options: { name?: string; overwrite?: boolean; platform?: WatermarkPlatform } = {}): string {
  if (op === 'copy_templates') return copyMessage(value)
  if (op === 'save_watermark' || op === 'set_watermark_template') return watermarkMessage(op, value, options.platform ?? 'tiktok')
  const name = templateResultSchema.parse(value).template?.name ?? options.name ?? 'The template'
  if (op === 'save_template') return options.overwrite ? `Updated “${name}” with this look.` : `Saved “${name}” as a template.`
  if (op === 'rename_template') return `Renamed the template to “${name}”.`
  if (op === 'delete_template') return `Deleted “${name}”.`
  return `${name} is now the look for videos in this book that have no graphics yet.`
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

export interface GraphicsWatermarkTarget {
  platform: WatermarkPlatform
  handle: string | null
  includeQr: boolean | null
}

export interface GraphicsTarget {
  artifactId: string
  kind: 'video' | 'final'
  label: string
  mediaUrl: string
  address: string | null
  notebookId: string | null
  image: string | null
  text: GraphicsBlockText | null
  watermark: GraphicsWatermarkTarget | null
}

export type GraphicsEditorAsset = { id: string; artifactId: string; label: string; type: string; status: string; mediaUrl: string | null }
export type GraphicsEditorMention = { artifactId: string; cellAddress: string }
type TargetInput = {
  reference: string | undefined
  image: string | undefined
  text?: GraphicsBlockText | null
  watermark?: GraphicsWatermarkTarget | null
  assets: readonly GraphicsEditorAsset[]
  mentions: readonly GraphicsEditorMention[]
  notebookId: string | null
}

export function graphicsWatermarkTarget(params: Record<string, unknown> = {}): GraphicsWatermarkTarget {
  const handle = typeof params.handle === 'string' ? params.handle.trim() : ''
  return {
    platform: isWatermarkPlatform(params.platform) ? params.platform : 'tiktok',
    handle: handle || null,
    includeQr: typeof params.include_qr === 'boolean' ? params.include_qr : null,
  }
}

export function graphicsBlockText(params: Record<string, unknown>): GraphicsBlockText | null {
  const entries = GRAPHICS_BLOCK_SLOTS.flatMap((slot) => {
    const value = params[slot]
    return typeof value === 'string' && value.trim() ? [[slot, value.trim()] as const] : []
  })
  return entries.length > 0 ? Object.fromEntries(entries) : null
}

function resolveAsset(reference: string | undefined, assets: readonly GraphicsEditorAsset[], mentions: readonly GraphicsEditorMention[]): GraphicsEditorAsset | undefined {
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
      text: input.text ?? null,
      watermark: input.watermark ?? null,
    },
  }
}

export function graphicsImageEdits(document: GraphicsDocument, image: string | null): GraphicsEdit[] {
  if (!image || document.layers.some((layer) => layer.kind === 'image' && layer.artifactId === image)) return []
  return [{ op: 'add_layer', layer: { kind: 'image', artifactId: image } }]
}

export function graphicsTextEdits(document: GraphicsDocument, text: GraphicsBlockText | null): GraphicsEdit[] {
  const given = GRAPHICS_BLOCK_SLOTS.flatMap((slot) => {
    const value = text?.[slot]
    return value === undefined ? [] : [{ slot, value }]
  })
  const held = given.filter((entry) => graphicsSlotText(document, entry.slot) !== null)
  const block = graphicsSlotBlock(Object.fromEntries(given.filter((entry) => !held.includes(entry)).map((entry) => [entry.slot, entry.value])))
  const edits: GraphicsEdit[] = held.map((entry) => ({ op: 'set_slot_text', slot: entry.slot, text: entry.value }))
  return block ? [...edits, { op: 'add_layer', layer: block }] : edits
}

function isProfileQr(layer: GraphicsLayer): layer is GraphicsQrLayer {
  return layer.kind === 'qr' && layer.slot === 'profile'
}

function watermarkQrEdits(document: GraphicsDocument, includeQr: boolean | null, qr: GraphicsQrLayerInput | null): GraphicsEdit[] {
  if (includeQr === false) return document.layers.filter(isProfileQr).map((layer) => ({ op: 'remove_layer', layer_id: layer.id }))
  if (!includeQr || !qr || document.layers.some(isProfileQr)) return []
  return [{ op: 'add_layer', layer: qr }]
}

function watermarkOpenEdits(document: GraphicsDocument, watermark: GraphicsWatermarkTarget | null, read: GraphicsRead | null): GraphicsEdit[] {
  if (!watermark) return []
  const handle = watermark.handle?.trim().replace(/^@+/u, '') ?? ''
  const current = graphicsSlotText(document, 'handle')
  const handleEdits: GraphicsEdit[] = handle && current !== null && current !== handle ? [{ op: 'set_slot_text', slot: 'handle', text: handle }] : []
  return [...handleEdits, ...watermarkQrEdits(document, watermark.includeQr, read?.watermark?.qr ?? null)]
}

export function graphicsOpenEdits(document: GraphicsDocument, target: Pick<GraphicsTarget, 'image' | 'text' | 'watermark'>, read: GraphicsRead | null = null): GraphicsEdit[] {
  return [...graphicsImageEdits(document, target.image), ...graphicsTextEdits(document, target.text), ...watermarkOpenEdits(document, target.watermark, read)]
}

export function graphicsWatermarkSwitchEdits(document: GraphicsDocument, read: GraphicsRead): GraphicsEdit[] {
  const look = read.watermark?.look
  if (!look) return []
  const applied = applyGraphicsEdits(document, [{ op: 'apply_template', template: look }])
  if (!applied.ok) return []
  const slots = graphicsSlotValues(applied.document)
  const fills: ReadonlyArray<readonly [GraphicsSlot, string | null]> = [['handle', read.fill.handle], ['profile', read.fill.profile_url]]
  return [
    { op: 'apply_template', template: look },
    ...fills.flatMap(([slot, value]): GraphicsEdit[] => (value && slots[slot] !== undefined && slots[slot] !== value ? [{ op: 'set_slot_text', slot, text: value }] : [])),
  ]
}

export function graphicsDrawnDocument(document: GraphicsDocument, watermark: boolean): GraphicsDocument {
  return watermark ? watermarkDrawnDocument(document) : document
}

export type GraphicsImageChoice = { artifactId: string; address: string; label: string }

export function graphicsImageChoices(assets: readonly GraphicsEditorAsset[], mentions: readonly GraphicsEditorMention[]): GraphicsImageChoice[] {
  const images = new Map(assets.filter((asset) => asset.type === 'image').map((asset) => [asset.artifactId, asset]))
  return mentions.flatMap((mention, index) => {
    const asset = images.get(mention.artifactId)
    if (!asset || mentions.findIndex((entry) => entry.artifactId === mention.artifactId) !== index) return []
    return [{ artifactId: asset.artifactId, address: mention.cellAddress, label: asset.label }]
  })
}

export type GraphicsAddKind = GraphicsLayerKind

export function graphicsNextLayerId(document: GraphicsDocument): string {
  return nextGraphicsId(document.nextId, 'l').id
}

export function graphicsAddLayer(
  document: GraphicsDocument,
  kind: GraphicsAddKind,
  options: { image?: GraphicsImageChoice; profileUrl?: string | null; qr?: GraphicsQrLayerInput | null } = {},
): { edit: GraphicsEdit; layerId: string } | null {
  const layerId = graphicsNextLayerId(document)
  if (kind === 'text') return { layerId, edit: { op: 'add_layer', layer: { kind: 'text', items: [{ text: 'Your text', size: 0.06 }] } } }
  if (kind === 'scrim') return { layerId, edit: { op: 'add_layer', layer: { kind: 'scrim' }, index: 0 } }
  if (kind === 'qr' && options.qr) return { layerId, edit: { op: 'add_layer', layer: options.qr } }
  if (kind === 'qr') {
    const url = options.profileUrl && isGraphicsUrl(options.profileUrl) ? options.profileUrl : ''
    return { layerId, edit: { op: 'add_layer', layer: { kind: 'qr', slot: 'profile', url } } }
  }
  if (!options.image) return null
  const name = (options.image.label.trim() || 'Image').slice(0, MAX_GRAPHICS_NAME_LENGTH)
  return { layerId, edit: { op: 'add_layer', layer: { kind: 'image', name, artifactId: options.image.artifactId } } }
}

export function graphicsSelectionAfterRemove(document: GraphicsDocument, layerId: string): string | null {
  const index = document.layers.findIndex((layer) => layer.id === layerId)
  if (index < 0) return null
  return document.layers[index - 1]?.id ?? document.layers[index + 1]?.id ?? null
}

const positionSchema = z.object({ anchor: z.enum(GRAPHICS_ANCHORS), x: z.number(), y: z.number(), space: z.enum(GRAPHICS_SPACES) })

const coverSchema = z.object({ kind: z.enum(['face', 'text']), time: z.number() })

const placementSchema = z.object({
  covers: z.array(coverSchema),
  unchecked_times: z.array(z.number()),
  clear_spot: z.object({ position: positionSchema, moved: z.boolean(), covers: z.array(coverSchema) }).nullable(),
  regions: z.array(regionFrameSchema).optional(),
})

export function parseGraphicsPlacement(value: unknown): z.infer<typeof placementSchema> {
  return placementSchema.parse(value)
}

export const GRAPHICS_ANCHOR_NAMES: Record<GraphicsAnchor, string> = {
  'top-left': 'top left',
  top: 'top',
  'top-right': 'top right',
  left: 'left',
  center: 'center',
  right: 'right',
  'bottom-left': 'bottom left',
  bottom: 'bottom',
  'bottom-right': 'bottom right',
}

export interface GraphicsLayerPlacement {
  covers: GraphicsCover[]
  unchecked: number
  drawn: GraphicsRect | null
  block: GraphicsRect
}

export function graphicsLayerPlacements(document: GraphicsDocument, layout: readonly GraphicsLayerLayout[] | null, read: GraphicsRead): Record<string, GraphicsLayerPlacement> {
  if (!layout) return {}
  const frame = { width: read.source.width, height: read.source.height }
  const entries = new Map(layout.map((entry) => [entry.layerId, entry]))
  return Object.fromEntries(document.layers.flatMap((layer) => {
    const entry = entries.get(layer.id)
    const window = graphicsLayerWindow(layer, read.source.duration_seconds)
    if (layer.kind === 'scrim' || !layer.visible || !entry || !window) return []
    const drawn = graphicsDrawnBox(entry)
    const placement: GraphicsLayerPlacement = {
      covers: drawn ? graphicsLayerCovers(drawn, frame, window, read.regions) : [],
      unchecked: graphicsUncheckedTimes(graphicsPlacementTimes(window), read.regions).length,
      drawn,
      block: entry.box,
    }
    return [[layer.id, placement]]
  }))
}

function coveredThings(covers: readonly GraphicsCover[]): string | null {
  const face = covers.some((cover) => cover.kind === 'face')
  const text = covers.some((cover) => cover.kind === 'text')
  if (face && text) return 'a face and on-screen text'
  if (face) return 'a face'
  return text ? 'on-screen text' : null
}

export function graphicsCoverWarning(covers: readonly GraphicsCover[]): string | null {
  const things = coveredThings(covers)
  return things ? `Covers ${things}` : null
}

export function graphicsClearSpotMessage(spot: GraphicsClearSpot): string {
  const things = coveredThings(spot.covers)
  const place = GRAPHICS_ANCHOR_NAMES[spot.position.anchor]
  if (spot.moved) return things ? `Moved to the ${place}, the clearest spot, but it still covers ${things}.` : `Moved to the ${place}, clear of faces and on-screen text.`
  return things ? `No clearer spot: every place covers ${things}.` : 'Already clear of faces and on-screen text.'
}

export const GRAPHICS_SLOT_LABELS: Record<GraphicsTextSlot, string> = { headline: 'Headline', secondary: 'Second line', credit: 'Credit', handle: 'Handle' }

export function graphicsLayerSummary(layer: GraphicsLayer, images: GraphicsRead['images'], choices: readonly GraphicsImageChoice[] = []): string {
  if (layer.kind === 'image') {
    const address = choices.find((choice) => choice.artifactId === layer.artifactId)?.address
    if (address) return `@${address}`
    return images[layer.artifactId] ? images[layer.artifactId].label ?? 'Image' : 'Image not loaded yet'
  }
  if (layer.kind === 'qr') return layer.slot === 'profile' ? 'Profile link' : clipped(layer.url)
  if (layer.kind === 'scrim') return `${layer.edge === 'top' ? 'Top' : 'Bottom'} shade`
  const typed = layer.items.find((item) => item.text.trim())
  if (typed) return clipped(typed.text)
  const slots = layer.items.flatMap((item) => (item.slot ? [GRAPHICS_SLOT_LABELS[item.slot]] : []))
  return slots.length > 0 ? `Empty ${slots.join(', ').toLowerCase()}` : 'Empty text'
}

export function graphicsRenderQueuedMessage(output: GraphicsRenderOutput, target: { label: string; address: string | null; watermark?: GraphicsWatermarkTarget | null }): string {
  const name = target.address ? `@${target.address}` : target.label
  if (target.watermark) {
    return output === 'replace'
      ? `Burning the watermark into ${name}. The video updates in place when the render finishes.`
      : `Rendering a watermarked copy of ${name}. It appears below it when the render finishes.`
  }
  return output === 'replace'
    ? `Burning graphics into ${name}. The video updates in place when the render finishes.`
    : `Rendering graphics for ${name}. The copy appears below it when the render finishes.`
}

const suggestionsSchema = z.object({
  kind: z.enum(GRAPHICS_SUGGEST_KINDS),
  language: z.enum(GRAPHICS_SUGGEST_LANGUAGES),
  options: z.array(z.string()).min(1),
})

type GraphicsSuggestions = z.infer<typeof suggestionsSchema>

export function parseGraphicsSuggestions(value: unknown): GraphicsSuggestions {
  return suggestionsSchema.parse(value)
}

export interface GraphicsSuggestionList {
  requestId: string
  kind: GraphicsSuggestKind
  language: GraphicsSuggestLanguage
  status: 'loading' | 'ready' | 'error'
  options: string[]
  message: string | null
}

export type GraphicsSuggestionLists = Partial<Record<GraphicsTextSlot, GraphicsSuggestionList>>

export function graphicsSuggestKind(slot: GraphicsTextSlot): GraphicsSuggestKind | null {
  return GRAPHICS_SUGGEST_KINDS.find((kind) => GRAPHICS_SUGGEST_SLOTS[kind] === slot) ?? null
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

export function graphicsRenderBlocker(document: GraphicsDocument | null, durationSeconds: number | null, conflict: boolean, watermark = false): string | null {
  if (conflict) return 'Reload the graphics or keep your version before rendering.'
  if (!document || durationSeconds === null) return 'The graphics are still loading.'
  if (graphicsStillGroups(graphicsDrawnDocument(document, watermark), durationSeconds).length > 0) return null
  return watermark ? 'Add the handle, a title, an image or a QR code to render.' : 'Add text, an image, a QR code or a shade to render.'
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

export function graphicsPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`
}
