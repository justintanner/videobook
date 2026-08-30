import type { NotebookCell, NotebookDocument } from 'videobook-engine'
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

function upstreamCellIds(
  document: NotebookDocument,
  starts: readonly NotebookCell[],
): string[] {
  const seen = new Set<string>()
  const queue = starts.map((cell) => cell.id)
  for (let index = 0; index < queue.length; index += 1) {
    const cellId = queue[index]
    if (!cellId || seen.has(cellId)) continue
    seen.add(cellId)
    for (const edge of document.edges) {
      if (edge.target === cellId && !seen.has(edge.source)) queue.push(edge.source)
    }
  }
  return [...seen]
}

function finalGenerationCells(
  document: NotebookDocument,
  starts: readonly NotebookCell[],
): NotebookCell[] {
  const cellsById = new Map(document.cells.map((cell) => [cell.id, cell]))
  const seen = new Set<string>()
  const found = new Map<string, NotebookCell>()
  const queue = starts.map((cell) => cell.id)
  for (let index = 0; index < queue.length; index += 1) {
    const cellId = queue[index]
    if (!cellId || seen.has(cellId)) continue
    seen.add(cellId)
    const cell = cellsById.get(cellId)
    if (!cell) continue
    if (cell.type === 'generate_video') {
      found.set(cell.id, cell)
      continue
    }
    for (const edge of document.edges) {
      if (edge.target === cell.id && !seen.has(edge.source)) queue.push(edge.source)
    }
  }
  return [...found.values()].sort(cellOrder)
}

function inputString(cell: NotebookCell, key: string): string | null {
  const value = cell.inputs?.[key]
  return typeof value === 'string' && value.trim() ? value : null
}

export function discoverXPostThreadGraph(
  document: NotebookDocument,
  artifactId: string,
): XPostThreadGraph {
  const starts = startingCells(document, artifactId)
  const cellsById = new Map(document.cells.map((cell) => [cell.id, cell]))
  const steps = finalGenerationCells(document, starts).map((producer) => {
    const output = findGenerateVideoOutputCell(document, producer.id)?.outputCell ?? null
    const sourceArtifactIds = document.edges
      .filter((edge) => edge.target === producer.id)
      .map((edge) => cellsById.get(edge.source))
      .filter((cell): cell is NotebookCell => cell !== undefined)
      .sort(cellOrder)
      .flatMap((cell) => {
        const sourceArtifactId = resolveNotebookCellArtifactId(document, cell)
        return sourceArtifactId ? [sourceArtifactId] : []
      })
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
      sourceArtifactIds: [...new Set(sourceArtifactIds)],
    }
  })
  const upstreamArtifactIds = upstreamCellIds(document, starts)
    .flatMap((cellId) => {
      const cell = cellsById.get(cellId)
      const upstreamArtifactId = cell
        ? resolveNotebookCellArtifactId(document, cell)
        : undefined
      return upstreamArtifactId ? [upstreamArtifactId] : []
    })
  return {
    steps,
    upstreamArtifactIds: [...new Set(upstreamArtifactIds)],
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

function supportedSourceUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '')
    const supported = hostname === 'youtube.com'
      || hostname === 'm.youtube.com'
      || hostname === 'youtu.be'
      || hostname === 'x.com'
      || hostname === 'mobile.x.com'
      || hostname === 'twitter.com'
      || hostname === 'mobile.twitter.com'
    return supported ? url : null
  } catch {
    return null
  }
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
  const source = supportedSourceUrl(
    metadata.webpage_url
      ?? metadata.webpageUrl
      ?? metadata.source_url
      ?? metadata.sourceUrl,
  )
  if (!source) return null
  source.hash = ''
  const hostname = source.hostname.toLowerCase().replace(/^www\./, '')
  const xSource = hostname === 'x.com'
    || hostname === 'mobile.x.com'
    || hostname === 'twitter.com'
    || hostname === 'mobile.twitter.com'
  if (xSource) {
    const match = source.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/)
    const reservedHandles = new Set([
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
    const matchedHandle = match?.[1] ?? null
    const xHandle = matchedHandle
      && !reservedHandles.has(matchedHandle.toLowerCase())
      ? matchedHandle
      : null
    const url = match
      ? `https://x.com/${match[1]}/status/${match[2]}`
      : source.toString()
    return {
      id: `${assetId}:${url}`,
      label: sourceLabel(metadata, 'X'),
      url,
      xHandle,
    }
  }
  return {
    id: `${assetId}:${source.toString()}`,
    label: sourceLabel(metadata, 'YouTube'),
    url: source.toString(),
    xHandle: null,
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
      const whitespace = remaining.lastIndexOf(' ', take)
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
