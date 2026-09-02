import type { NotebookCell, NotebookDocument } from 'videobook-engine'
import {
  NOTEBOOK_GRID_ADDRESS_SOURCE,
  normalizeNotebookReference,
} from 'videobook-engine/notebook-mentions'
import {
  findGenerateVideoOutputCell,
  resolveNotebookCellArtifactId,
} from 'videobook-engine/notebook-media-artifact'
import {
  X_POST_MAX_CHARACTERS,
  type XPostFollowup,
} from './x-post-review'

export type XPostThreadGraphStep = {
  id: string
  producerCellId: string
  outputCellId: string | null
  outputArtifactId: string | null
  producerPrompt: string | null
  producerResolvedPrompt: string | null
  sourceArtifactIds: string[]
}

export type XPostThreadGraph = {
  steps: XPostThreadGraphStep[]
  upstreamArtifactIds: string[]
}

export type XPostThreadImage = {
  assetId: string
  label: string
  mediaUrl: string | null
  thumbnailUrl: string | null
}

export type XPostSourceAttribution = {
  id: string
  label: string
  url: string
  xHandle: string | null
}

export type XPostThreadStep = {
  id: string
  prompt: string
  images: XPostThreadImage[]
}

export type XPostThreadContext = {
  steps: XPostThreadStep[]
  attributions: XPostSourceAttribution[]
}

export type XPostThreadOptions = {
  enabled: boolean
  includePrompt: boolean
  includeSourceImages: boolean
  includeAttribution: boolean
}

export type XPostThreadReply = XPostFollowup & {
  id: string
  images: XPostThreadImage[]
}

export type XPostThreadReview = {
  loading: boolean
  error: string | null
  context: XPostThreadContext
  options: XPostThreadOptions
  textOverrides: Record<string, string>
}

type GenerationAttemptPrompt = {
  status: string
  artifactId: string | null
  resolvedPrompt: string | null
}

const EMPTY_CONTEXT: XPostThreadContext = { steps: [], attributions: [] }

export function initialXPostThreadReview(
  context: XPostThreadContext = EMPTY_CONTEXT,
): XPostThreadReview {
  return {
    loading: false,
    error: null,
    context,
    options: {
      enabled: false,
      includePrompt: true,
      includeSourceImages: true,
      includeAttribution: true,
    },
    textOverrides: {},
  }
}

function cellOrder(left: NotebookCell, right: NotebookCell): number {
  return left.slot.row - right.slot.row
    || left.slot.column - right.slot.column
    || left.id.localeCompare(right.id)
}

function startingCells(
  document: NotebookDocument,
  artifactId: string,
): NotebookCell[] {
  const direct = document.cells.filter((cell) =>
    cell.outputArtifactId === artifactId || cell.outputEntityId === artifactId)
  if (direct.length > 0) {
    const outputs = direct.filter((cell) => cell.type !== 'generate_video')
    return (outputs.length > 0 ? outputs : direct).sort(cellOrder)
  }
  return document.cells.filter((cell) =>
    resolveNotebookCellArtifactId(document, cell) === artifactId).sort(cellOrder)
}

const GENERATION_CELL_TYPES = new Set<NotebookCell['type']>([
  'generate_audio',
  'generate_image',
  'generate_video',
])

/**
 * Input keys under which duplicates and routed edits (extract, split,
 * splice, cover song) record their sources. Those cells are placed without
 * graph edges, so provenance has to be read from here.
 */
const IMPLICIT_SOURCE_ARTIFACT_KEYS = [
  'sourceArtifactId',
  'source_asset_id',
  'first_asset_id',
  'second_asset_id',
  'additional_asset_ids',
] as const

type ProvenanceIndex = {
  cellsById: Map<string, NotebookCell>
  cellsByArtifactId: Map<string, NotebookCell>
}

function inputString(cell: NotebookCell, key: string): string | null {
  const value = cell.inputs?.[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function inputStrings(cell: NotebookCell, key: string): string[] {
  const value = cell.inputs?.[key]
  const values: unknown[] = Array.isArray(value) ? value : [value]
  return values.filter((entry): entry is string =>
    typeof entry === 'string' && entry.trim() !== '')
}

function implicitSourceArtifactIds(cell: NotebookCell): string[] {
  return IMPLICIT_SOURCE_ARTIFACT_KEYS.flatMap((key) => inputStrings(cell, key))
}

function provenanceIndex(document: NotebookDocument): ProvenanceIndex {
  const cellsById = new Map(document.cells.map((cell) => [cell.id, cell]))
  const cellsByArtifactId = new Map<string, NotebookCell>()
  for (const cell of [...document.cells].sort(cellOrder)) {
    const artifactId = resolveNotebookCellArtifactId(document, cell)
    if (!artifactId) continue
    const current = cellsByArtifactId.get(artifactId)
    const preferred = !current
      || (GENERATION_CELL_TYPES.has(current.type)
        && !GENERATION_CELL_TYPES.has(cell.type))
    if (preferred) cellsByArtifactId.set(artifactId, cell)
  }
  return { cellsById, cellsByArtifactId }
}

function predecessorCellIds(
  document: NotebookDocument,
  index: ProvenanceIndex,
  cell: NotebookCell,
): string[] {
  const fromEdges = document.edges
    .filter((edge) => edge.target === cell.id)
    .map((edge) => edge.source)
  const fromCells = inputStrings(cell, 'sourceCellId')
  const fromArtifacts = implicitSourceArtifactIds(cell).flatMap((artifactId) => {
    const source = index.cellsByArtifactId.get(artifactId)
    return source ? [source.id] : []
  })
  return [...new Set([...fromEdges, ...fromCells, ...fromArtifacts])]
    .filter((cellId) => cellId !== cell.id)
}

function walkUpstream(
  document: NotebookDocument,
  index: ProvenanceIndex,
  starts: readonly NotebookCell[],
  stopAt: (cell: NotebookCell) => boolean,
): { visited: NotebookCell[]; stopped: NotebookCell[] } {
  const seen = new Set<string>()
  const visited: NotebookCell[] = []
  const stopped: NotebookCell[] = []
  const queue = starts.map((cell) => cell.id)
  for (let position = 0; position < queue.length; position += 1) {
    const cellId = queue[position]
    if (!cellId || seen.has(cellId)) continue
    seen.add(cellId)
    const cell = index.cellsById.get(cellId)
    if (!cell) continue
    visited.push(cell)
    if (stopAt(cell)) {
      stopped.push(cell)
      continue
    }
    for (const sourceId of predecessorCellIds(document, index, cell)) {
      if (!seen.has(sourceId)) queue.push(sourceId)
    }
  }
  return { visited, stopped }
}

function isGenerateVideoCell(cell: NotebookCell): boolean {
  return cell.type === 'generate_video'
}

function cellArtifactIds(
  document: NotebookDocument,
  cells: readonly NotebookCell[],
): string[] {
  const artifactIds = cells.flatMap((cell) => {
    const artifactId = resolveNotebookCellArtifactId(document, cell)
    return artifactId ? [artifactId] : []
  })
  return [...new Set(artifactIds)]
}

function threadGraphStep(
  document: NotebookDocument,
  index: ProvenanceIndex,
  producer: NotebookCell,
): XPostThreadGraphStep {
  const output = findGenerateVideoOutputCell(document, producer.id)?.outputCell ?? null
  const sources = predecessorCellIds(document, index, producer)
    .map((cellId) => index.cellsById.get(cellId))
    .filter((cell): cell is NotebookCell => cell !== undefined)
    .sort(cellOrder)
  return {
    id: producer.id,
    producerCellId: producer.id,
    outputCellId: output?.id ?? null,
    outputArtifactId: output
      ? resolveNotebookCellArtifactId(document, output) ?? null
      : resolveNotebookCellArtifactId(document, producer) ?? null,
    producerPrompt: producer.prompt?.trim()
      ? producer.prompt
      : inputString(producer, 'prompt'),
    producerResolvedPrompt: inputString(producer, 'resolvedPrompt')
      ?? inputString(producer, 'resolved_prompt'),
    sourceArtifactIds: cellArtifactIds(document, sources),
  }
}

export function discoverXPostThreadGraph(
  document: NotebookDocument,
  artifactId: string,
): XPostThreadGraph {
  const index = provenanceIndex(document)
  const starts = startingCells(document, artifactId)
  const producers = walkUpstream(document, index, starts, isGenerateVideoCell)
    .stopped
    .sort(cellOrder)
  const upstream = walkUpstream(document, index, starts, () => false).visited
  return {
    steps: producers.map((producer) => threadGraphStep(document, index, producer)),
    upstreamArtifactIds: cellArtifactIds(document, upstream),
  }
}

export function selectXPostGenerationPrompt(input: {
  attempts: readonly GenerationAttemptPrompt[]
  outputArtifactId: string | null
  outputAssetPrompt: string | null
  producerResolvedPrompt: string | null
  producerPrompt: string | null
}): string {
  const exactAttempt = input.attempts.find((attempt) =>
    attempt.status === 'completed'
    && attempt.artifactId === input.outputArtifactId
    && attempt.resolvedPrompt?.trim())
  if (exactAttempt?.resolvedPrompt?.trim()) return exactAttempt.resolvedPrompt
  if (input.outputAssetPrompt?.trim()) return input.outputAssetPrompt
  if (input.producerResolvedPrompt?.trim()) return input.producerResolvedPrompt
  if (input.producerPrompt?.trim()) return input.producerPrompt
  return ''
}

export type XPostPromptMention = {
  reference: string
  type: string
}

const ARTIFACT_ID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const ARTIFACT_ID_PATTERN = new RegExp(`^${ARTIFACT_ID_SOURCE}$`, 'iu')
const PROMPT_MENTION_PATTERN = new RegExp(
  `@(${ARTIFACT_ID_SOURCE}|${NOTEBOOK_GRID_ADDRESS_SOURCE})(?![\\w-])`,
  'giu',
)

function mentionKind(type: string | undefined): string {
  if (type === 'video' || type === 'final') return 'video'
  if (type === 'image' || type === 'audio') return type
  return 'source'
}

/**
 * Replace notebook mentions (artifact ids or grid addresses) with numbered
 * bracket labels so a public reply never carries internal ids or stray
 * X-style @handles. Grid addresses that match no asset stay as typed.
 */
export function readableXPostPrompt(
  prompt: string,
  mentions: readonly XPostPromptMention[],
): string {
  const typesByReference = new Map(mentions.map((mention) =>
    [normalizeNotebookReference(mention.reference), mention.type] as const))
  const labels = new Map<string, string>()
  const counts = new Map<string, number>()
  return prompt.replace(PROMPT_MENTION_PATTERN, (match: string, reference: string) => {
    const key = normalizeNotebookReference(reference)
    const known = labels.get(key)
    if (known) return known
    const type = typesByReference.get(key)
    if (!type && !ARTIFACT_ID_PATTERN.test(key)) return match
    const kind = mentionKind(type)
    const ordinal = (counts.get(kind) ?? 0) + 1
    counts.set(kind, ordinal)
    const label = `[${kind} ${ordinal}]`
    labels.set(key, label)
    return label
  })
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'])
const X_HOSTS = new Set(['x.com', 'mobile.x.com', 'twitter.com', 'mobile.twitter.com'])
const RESERVED_X_HANDLES = new Set([
  'explore',
  'home',
  'i',
  'intent',
  'messages',
  'notifications',
  'search',
  'settings',
  'share',
])

type SourceLink =
  | { kind: 'youtube'; url: string; videoId: string | null }
  | { kind: 'x'; url: string; handle: string | null; status: boolean }

function youtubeVideoId(url: URL, hostname: string): string | null {
  if (hostname === 'youtu.be') return url.pathname.split('/')[1] || null
  const watchId = url.searchParams.get('v')
  if (watchId) return watchId
  return url.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]+)/)?.[1] ?? null
}

function youtubeLink(url: URL, hostname: string): SourceLink {
  const videoId = youtubeVideoId(url, hostname)
  if (videoId && url.pathname.startsWith('/shorts/')) {
    return { kind: 'youtube', url: `https://www.youtube.com/shorts/${videoId}`, videoId }
  }
  if (videoId) return { kind: 'youtube', url: `https://youtu.be/${videoId}`, videoId }
  url.hash = ''
  return { kind: 'youtube', url: url.toString(), videoId: null }
}

function xLink(url: URL): SourceLink {
  const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/)
  if (!match) {
    url.hash = ''
    return { kind: 'x', url: url.toString(), handle: null, status: false }
  }
  const matchedHandle = match[1]!
  const handle = RESERVED_X_HANDLES.has(matchedHandle.toLowerCase()) ? null : matchedHandle
  return {
    kind: 'x',
    url: `https://x.com/${matchedHandle}/status/${match[2]}`,
    handle,
    status: true,
  }
}

function sourceLink(value: unknown): SourceLink | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '')
    if (YOUTUBE_HOSTS.has(hostname)) return youtubeLink(url, hostname)
    if (X_HOSTS.has(hostname)) return xLink(url)
    return null
  } catch {
    return null
  }
}

/** A link that names one video or post, rather than a playlist or profile page. */
function isConcreteLink(link: SourceLink): boolean {
  return link.kind === 'youtube' ? link.videoId !== null : link.status
}

function sourceLabel(
  metadata: Record<string, unknown>,
  fallback: string,
): string {
  if (typeof metadata.uploader !== 'string') return fallback
  const label = metadata.uploader.replaceAll('@', '').replace(/\s+/g, ' ').trim()
  return label || fallback
}

export function xPostSourceAttribution(
  assetId: string,
  metadata: Record<string, unknown>,
): XPostSourceAttribution | null {
  const links = [
    metadata.webpage_url,
    metadata.webpageUrl,
    metadata.source_url,
    metadata.sourceUrl,
  ].map(sourceLink).filter((link): link is SourceLink => link !== null)
  const link = links.find(isConcreteLink) ?? links[0]
  if (!link) return null
  return {
    id: `${assetId}:${link.url}`,
    label: sourceLabel(metadata, link.kind === 'x' ? 'X' : 'YouTube'),
    url: link.url,
    xHandle: link.kind === 'x' ? link.handle : null,
  }
}

export function dedupeXPostAttributions(
  values: readonly XPostSourceAttribution[],
): XPostSourceAttribution[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    if (seen.has(value.url)) return false
    seen.add(value.url)
    return true
  })
}

function promptReplies(
  step: XPostThreadStep,
  ordinal: number,
  stepCount: number,
): Array<{ id: string; text: string }> {
  if (!step.prompt) return []
  const replies: Array<{ id: string; text: string }> = []
  let remaining = step.prompt
  let part = 0
  while (remaining.length > 0) {
    const prefix = part === 0
      ? `How I made this video${stepCount > 1 ? ` (${ordinal + 1}/${stepCount})` : ''} — prompt:\n`
      : `Prompt continued (${part + 1}):\n`
    const capacity = X_POST_MAX_CHARACTERS - prefix.length
    let take = Math.min(remaining.length, capacity)
    if (take < remaining.length) {
      const whitespace = remaining.lastIndexOf(' ', take - 1)
      if (whitespace > Math.floor(capacity / 2)) take = whitespace + 1
    }
    replies.push({
      id: `step:${step.id}:prompt:${part}`,
      text: `${prefix}${remaining.slice(0, take)}`,
    })
    remaining = remaining.slice(take)
    part += 1
  }
  return replies
}

function attributionText(value: XPostSourceAttribution): string {
  const full = value.xHandle
    ? `@${value.xHandle} ${value.url}`
    : `${value.label} ${value.url}`
  return full.length <= X_POST_MAX_CHARACTERS ? full : value.url
}

function attributionReplies(
  values: readonly XPostSourceAttribution[],
): Array<{ id: string; text: string }> {
  const ordered = [...values].sort((left, right) =>
    Number(left.xHandle !== null) - Number(right.xHandle !== null))
  const replies: Array<{ id: string; text: string }> = []
  let lines: string[] = []
  for (const value of ordered) {
    const line = attributionText(value)
    const prefix = replies.length === 0 ? 'Original sources:\n' : 'Original sources continued:\n'
    const candidate = `${prefix}${[...lines, line].join('\n')}`
    if (candidate.length <= X_POST_MAX_CHARACTERS) {
      lines.push(line)
      continue
    }
    if (lines.length > 0) {
      replies.push({
        id: `attribution:${replies.length}`,
        text: `${prefix}${lines.join('\n')}`,
      })
      lines = [line]
      continue
    }
    replies.push({
      id: `attribution:${replies.length}`,
      text: line,
    })
  }
  if (lines.length > 0) {
    const prefix = replies.length === 0 ? 'Original sources:\n' : 'Original sources continued:\n'
    replies.push({
      id: `attribution:${replies.length}`,
      text: `${prefix}${lines.join('\n')}`,
    })
  }
  return replies
}

export function buildXPostThreadReplies(
  review: XPostThreadReview,
): XPostThreadReply[] {
  if (!review.options.enabled) return []
  const replies: XPostThreadReply[] = []
  for (const [ordinal, step] of review.context.steps.entries()) {
    const prompts = review.options.includePrompt
      ? promptReplies(step, ordinal, review.context.steps.length)
      : []
    const images = review.options.includeSourceImages ? step.images : []
    for (const [index, prompt] of prompts.entries()) {
      const attached = index === 0 ? images.slice(0, 4) : []
      replies.push({
        id: prompt.id,
        text: review.textOverrides[prompt.id] ?? prompt.text,
        imageAssetIds: attached.map((image) => image.assetId),
        images: attached,
      })
    }
    const remainingImages = images.slice(prompts.length > 0 ? 4 : 0)
    for (let index = 0; index < remainingImages.length; index += 4) {
      const attached = remainingImages.slice(index, index + 4)
      const id = `step:${step.id}:images:${index / 4}`
      const text = `Source images used for this video${review.context.steps.length > 1 ? ` (${ordinal + 1}/${review.context.steps.length})` : ''}:`
      replies.push({
        id,
        text: review.textOverrides[id] ?? text,
        imageAssetIds: attached.map((image) => image.assetId),
        images: attached,
      })
    }
  }
  if (review.options.includeAttribution) {
    for (const attribution of attributionReplies(review.context.attributions)) {
      replies.push({
        ...attribution,
        text: review.textOverrides[attribution.id] ?? attribution.text,
        imageAssetIds: [],
        images: [],
      })
    }
  }
  return replies
}

export function xPostFollowupsFromThread(
  review: XPostThreadReview,
): XPostFollowup[] {
  return buildXPostThreadReplies(review).map((reply) => ({
    text: reply.text,
    imageAssetIds: reply.imageAssetIds,
  }))
}
