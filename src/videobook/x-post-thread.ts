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
  X_POST_MAX_IMAGES_PER_FOLLOWUP,
  type XPostFollowup,
} from './x-post-review'

export type XPostThreadGraphStep = {
  id: string
  producerCellId: string
  outputCellId: string | null
  outputArtifactId: string | null
  producerPrompt: string | null
  producerResolvedPrompt: string | null
  producerTool: string | null
  producerModel: string | null
  producerProvider: string | null
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

export type XPostThreadModel = {
  label: string
  provider: string | null
}

export type XPostSourceCredit = {
  id: string
  label: string
  url: string
  xHandle: string | null
}

export type XPostThreadStep = {
  id: string
  prompt: string
  model: XPostThreadModel | null
  images: XPostThreadImage[]
}

export type XPostThreadContext = {
  steps: XPostThreadStep[]
  credits: XPostSourceCredit[]
}

export type XPostThreadOptions = {
  enabled: boolean
}

export type XPostThreadReply = XPostFollowup & {
  id: string
  /** The generation step this reply belongs to; null for the credits reply. */
  stepId: string | null
  images: XPostThreadImage[]
}

export type XPostThreadReview = {
  loading: boolean
  error: string | null
  context: XPostThreadContext
  options: XPostThreadOptions
  /** Edited prompt text keyed by step id; unedited steps post their stored prompt. */
  promptOverrides: Record<string, string>
  /** Edited credits text; null posts the default credit line. */
  creditsOverride: string | null
}

type GenerationAttemptPrompt = {
  status: string
  artifactId: string | null
  resolvedPrompt: string | null
}

const EMPTY_CONTEXT: XPostThreadContext = { steps: [], credits: [] }

export function initialXPostThreadReview(
  context: XPostThreadContext = EMPTY_CONTEXT,
): XPostThreadReview {
  return {
    loading: false,
    error: null,
    context,
    options: { enabled: false },
    promptOverrides: {},
    creditsOverride: null,
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

function cellString(value: string | undefined): string | null {
  return value?.trim() ? value : null
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
    producerPrompt: cellString(producer.prompt) ?? inputString(producer, 'prompt'),
    producerResolvedPrompt: inputString(producer, 'resolvedPrompt')
      ?? inputString(producer, 'resolved_prompt'),
    producerTool: cellString(producer.tool),
    producerModel: cellString(producer.model),
    producerProvider: cellString(producer.provider),
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

type GenerationAttemptModel = {
  status: string
  artifactId: string | null
  tool: string | null
  model: string | null
  provider: string | null
}

type GenerationActionTitle = {
  tool: string
  title: string
  providerLabel: string
}

/**
 * Name the model the way the notebook does: the generation action's title
 * for the tool, else the recorded model id, else the tool name. The completed
 * attempt that produced the output wins over the producer cell's current
 * configuration.
 */
export function selectXPostGenerationModel(input: {
  attempts: readonly GenerationAttemptModel[]
  outputArtifactId: string | null
  producerTool: string | null
  producerModel: string | null
  producerProvider: string | null
  actions: readonly GenerationActionTitle[]
}): XPostThreadModel | null {
  const attempt = input.outputArtifactId
    ? input.attempts.find((candidate) =>
      candidate.status === 'completed'
      && candidate.artifactId === input.outputArtifactId) ?? null
    : null
  const tool = attempt?.tool?.trim() || input.producerTool
  const action = tool
    ? input.actions.find((candidate) => candidate.tool === tool)
    : undefined
  const label = action?.title.trim()
    || attempt?.model?.trim()
    || input.producerModel?.trim()
    || tool?.trim()
    || ''
  if (!label) return null
  const provider = action?.providerLabel.trim()
    || attempt?.provider?.trim()
    || input.producerProvider?.trim()
    || null
  return { label, provider }
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

/**
 * Read a downloaded asset's original page from its metadata. Only YouTube
 * videos and X posts become credits; X status URLs carry the account to
 * at-mention.
 */
export function xPostSourceCredit(
  assetId: string,
  metadata: Record<string, unknown>,
): XPostSourceCredit | null {
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

export function dedupeXPostSourceCredits(
  values: readonly XPostSourceCredit[],
): XPostSourceCredit[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    if (seen.has(value.url)) return false
    seen.add(value.url)
    return true
  })
}

export const X_POST_EMPTY_THREAD_MESSAGE =
  'The thread has nothing to post. Add a prompt, or turn the thread off.'

export function xPostThreadHasDetails(context: XPostThreadContext): boolean {
  return context.credits.length > 0 || context.steps.some((step) =>
    step.prompt.trim() !== '' || step.images.length > 0)
}

export function xPostThreadPrompt(
  review: XPostThreadReview,
  step: XPostThreadStep,
): string {
  return review.promptOverrides[step.id] ?? step.prompt
}

function creditLine(credit: XPostSourceCredit): string {
  return credit.xHandle
    ? `@${credit.xHandle} ${credit.url}`
    : `${credit.label} ${credit.url}`
}

/** The default credits reply: at-mentions X accounts, names YouTube uploaders. */
export function defaultXPostThreadCredits(
  credits: readonly XPostSourceCredit[],
): string {
  const ordered = [...credits].sort((left, right) =>
    Number(left.xHandle === null) - Number(right.xHandle === null))
  const first = ordered[0]
  if (!first) return ''
  if (ordered.length === 1) return `Original video by ${creditLine(first)}`
  const full = `Original videos:\n${ordered.map(creditLine).join('\n')}`
  if (full.length <= X_POST_MAX_CHARACTERS) return full
  return `Original videos:\n${ordered.map((credit) => credit.url).join('\n')}`
}

export function xPostThreadCreditsText(review: XPostThreadReview): string {
  return review.creditsOverride ?? defaultXPostThreadCredits(review.context.credits)
}

function stepOrdinal(ordinal: number, stepCount: number): string {
  return stepCount > 1 ? ` (${ordinal + 1}/${stepCount})` : ''
}

function promptPrefix(
  step: XPostThreadStep,
  ordinal: number,
  stepCount: number,
): string {
  const heading = `How I made this video${stepOrdinal(ordinal, stepCount)}`
  if (!step.model) return `${heading} — prompt:\n`
  const provider = step.model.provider ? ` via ${step.model.provider}` : ''
  return `${heading} — ${step.model.label}${provider}. Prompt:\n`
}

function promptParts(prompt: string, firstPrefix: string): string[] {
  const parts: string[] = []
  let remaining = prompt
  while (remaining.length > 0) {
    const prefix = parts.length === 0
      ? firstPrefix
      : `Prompt continued (${parts.length + 1}):\n`
    const capacity = X_POST_MAX_CHARACTERS - prefix.length
    let take = Math.min(remaining.length, capacity)
    if (take < remaining.length) {
      const whitespace = remaining.lastIndexOf(' ', take - 1)
      if (whitespace > Math.floor(capacity / 2)) take = whitespace + 1
    }
    parts.push(`${prefix}${remaining.slice(0, take)}`)
    remaining = remaining.slice(take)
  }
  return parts
}

function imageBatches(images: readonly XPostThreadImage[]): XPostThreadImage[][] {
  const batches: XPostThreadImage[][] = []
  for (let index = 0; index < images.length; index += X_POST_MAX_IMAGES_PER_FOLLOWUP) {
    batches.push(images.slice(index, index + X_POST_MAX_IMAGES_PER_FOLLOWUP))
  }
  return batches
}

function threadReply(
  id: string,
  stepId: string | null,
  text: string,
  images: readonly XPostThreadImage[],
): XPostThreadReply {
  return {
    id,
    stepId,
    text,
    imageAssetIds: images.map((image) => image.assetId),
    images: [...images],
  }
}

/**
 * One step posts its model and prompt first, split across as many replies as
 * the limit needs, with the first four input images attached to the opening
 * reply; further images follow in batches of four.
 */
function stepReplies(
  review: XPostThreadReview,
  step: XPostThreadStep,
  ordinal: number,
  stepCount: number,
): XPostThreadReply[] {
  const prompt = xPostThreadPrompt(review, step).trim()
  const texts = prompt
    ? promptParts(prompt, promptPrefix(step, ordinal, stepCount))
    : []
  const batches = imageBatches(step.images)
  const replies = texts.map((text, index) => threadReply(
    `step:${step.id}:prompt:${index}`,
    step.id,
    text,
    index === 0 ? batches[0] ?? [] : [],
  ))
  const unattached = texts.length > 0 ? batches.slice(1) : batches
  for (const [index, images] of unattached.entries()) {
    replies.push(threadReply(
      `step:${step.id}:images:${index}`,
      step.id,
      `Source images used for this video${stepOrdinal(ordinal, stepCount)}:`,
      images,
    ))
  }
  return replies
}

export function buildXPostThreadReplies(
  review: XPostThreadReview,
): XPostThreadReply[] {
  if (!review.options.enabled) return []
  const stepCount = review.context.steps.length
  const replies = review.context.steps.flatMap((step, ordinal) =>
    stepReplies(review, step, ordinal, stepCount))
  const credits = review.context.credits.length > 0
    ? xPostThreadCreditsText(review).trim()
    : ''
  if (credits) replies.push(threadReply('credits', null, credits, []))
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
