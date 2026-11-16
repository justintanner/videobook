import type { NotebookCellType, NotebookDocument } from 'videobook-engine'
import { notebookGridTag } from 'videobook-engine/notebook-grid'
import { generationInputMentions } from '../../server/src/generation-input-mentions'
import {
  isNotebookGenerationCellType,
  notebookCellFamily,
  type NotebookCellFamily,
} from './notebook-cell-types'
import { nonBlankStringValue } from './value-decoders'

export interface NotebookRouteTag {
  address: string
  tokens: string[]
  type: NotebookCellType
}

export interface NotebookCellRouteTags {
  outgoing: NotebookRouteTag[]
  incoming: NotebookRouteTag[]
}

export interface NotebookRouteSegment {
  address: string
  slots: string[]
  family: NotebookCellFamily
}

export interface NotebookRouteBadge {
  segments: NotebookRouteSegment[]
  hidden: number
  tone: NotebookCellFamily | 'mixed'
  label: string
}

const listedAddressLimit = 3

const outgoingAddressLimit = 2

const fixedSlotLabels: Readonly<Record<string, string>> = {
  firstframe: 'FF',
  lastframe: 'LF',
}

const numberedSlotPrefixes: Readonly<Record<string, string>> = {
  audio: 'A',
  image: 'I',
  keyframe: 'K',
  video: 'V',
}

function inputTokensByTarget(
  document: NotebookDocument,
): Map<string, Map<string, string[]>> {
  const targetIds = new Set(document.edges.map((edge) => edge.target))
  return new Map(document.cells
    .filter((cell) => targetIds.has(cell.id) && isNotebookGenerationCellType(cell.type))
    .map((cell) => {
      const mentions = generationInputMentions(
        cell.id,
        document.cells,
        document.edges,
        nonBlankStringValue(cell.inputs?.generationMode) ?? undefined,
      )
      const tokensBySource = new Map<string, string[]>()
      for (const mention of mentions) {
        tokensBySource.set(mention.sourceCellId, [
          ...(tokensBySource.get(mention.sourceCellId) ?? []),
          mention.token,
        ])
      }
      return [cell.id, tokensBySource]
    }))
}

function appendRouteTag(
  tags: NotebookRouteTag[],
  link: NotebookRouteTag,
): NotebookRouteTag[] {
  const existing = tags.find((tag) => tag.address === link.address)
  if (!existing) return [...tags, { ...link, tokens: [...link.tokens] }]
  return tags.map((tag) => tag === existing
    ? { ...tag, tokens: [...new Set([...tag.tokens, ...link.tokens])] }
    : tag)
}

export function notebookCellRouteTags(
  document: NotebookDocument,
): Map<string, NotebookCellRouteTags> {
  const cellsById = new Map(document.cells.map((cell) => [cell.id, cell]))
  const tokensByTarget = inputTokensByTarget(document)
  const tags = new Map<string, NotebookCellRouteTags>()
  const tagsFor = (cellId: string) =>
    tags.get(cellId) ?? { outgoing: [], incoming: [] }
  for (const edge of document.edges) {
    const source = cellsById.get(edge.source)
    const target = cellsById.get(edge.target)
    if (!source || !target) continue
    const tokens = tokensByTarget.get(edge.target)?.get(edge.source) ?? []
    const sourceTags = tagsFor(edge.source)
    tags.set(edge.source, {
      ...sourceTags,
      outgoing: appendRouteTag(sourceTags.outgoing, {
        address: notebookGridTag(target.slot),
        tokens,
        type: target.type,
      }),
    })
    const targetTags = tagsFor(edge.target)
    tags.set(edge.target, {
      ...targetTags,
      incoming: appendRouteTag(targetTags.incoming, {
        address: notebookGridTag(source.slot),
        tokens,
        type: source.type,
      }),
    })
  }
  return tags
}

export function notebookRouteSlotLabel(token: string): string {
  const fixed = fixedSlotLabels[token]
  if (fixed) return fixed
  const numbered = /^([a-z]+)(\d+)$/u.exec(token)
  const prefix = numbered ? numberedSlotPrefixes[numbered[1] ?? ''] : undefined
  if (numbered && prefix) return `${prefix}${numbered[2]}`
  return token.slice(0, 3).toUpperCase()
}

function routeSegment(tag: NotebookRouteTag, showSlots: boolean): NotebookRouteSegment {
  return {
    address: tag.address.replace(/^@/u, ''),
    slots: showSlots ? tag.tokens.map(notebookRouteSlotLabel) : [],
    family: notebookCellFamily(tag.type),
  }
}

function routeTone(
  segments: readonly NotebookRouteSegment[],
): NotebookCellFamily | 'mixed' {
  const [first, ...rest] = segments
  if (!first) return 'mixed'
  return rest.every((segment) => segment.family === first.family)
    ? first.family
    : 'mixed'
}

function listedRoutes(
  tags: readonly NotebookRouteTag[],
  describe: (tag: NotebookRouteTag) => string,
): string {
  const listed = tags.slice(0, listedAddressLimit).map(describe)
  const hidden = tags.length - listed.length
  return hidden > 0
    ? `${listed.join(', ')} and ${hidden} more`
    : listed.join(', ')
}

function routeBadge(
  tags: readonly NotebookRouteTag[],
  showSlots: boolean,
  label: string,
  limit: number,
): NotebookRouteBadge {
  const segments = tags
    .slice(0, limit)
    .map((tag) => routeSegment(tag, showSlots))
  return {
    segments,
    hidden: tags.length - segments.length,
    tone: routeTone(segments),
    label,
  }
}

export function notebookIncomingRouteBadge(
  tags: readonly NotebookRouteTag[],
): NotebookRouteBadge | null {
  if (tags.length === 0) return null
  const sources = listedRoutes(tags, (tag) => tag.tokens.length > 0
    ? `${tag.address} into ${tag.tokens.join(' and ')}`
    : tag.address)
  return routeBadge(tags, true, `Fed by ${sources}`, listedAddressLimit)
}

function outgoingListedCount(count: number): number {
  return count > outgoingAddressLimit ? 1 : count
}

export function notebookOutgoingRouteBadge(
  tags: readonly NotebookRouteTag[],
): NotebookRouteBadge | null {
  if (tags.length === 0) return null
  const single = tags.length === 1
  const targets = listedRoutes(tags, (tag) => single && tag.tokens.length > 0
    ? `${tag.address} as ${tag.tokens.join(' and ')}`
    : tag.address)
  return routeBadge(tags, false, `Feeds ${targets}`, outgoingListedCount(tags.length))
}
