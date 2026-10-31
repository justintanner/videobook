import type { NotebookDocument } from 'videobook-engine'
import { notebookGridTag } from 'videobook-engine/notebook-grid'
import { generationInputMentions } from '../../server/src/generation-input-mentions'
import { nonBlankStringValue } from './value-decoders'

export interface NotebookRouteTag {
  address: string
  tokens: string[]
}

export interface NotebookCellRouteTags {
  outgoing: NotebookRouteTag[]
  incoming: NotebookRouteTag[]
}

const listedAddressLimit = 3

function inputTokensByTarget(
  document: NotebookDocument,
): Map<string, Map<string, string[]>> {
  const targetIds = new Set(document.edges.map((edge) => edge.target))
  return new Map(document.cells
    .filter((cell) => targetIds.has(cell.id))
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
  address: string,
  tokens: readonly string[],
): NotebookRouteTag[] {
  const existing = tags.find((tag) => tag.address === address)
  if (!existing) return [...tags, { address, tokens: [...tokens] }]
  return tags.map((tag) => tag === existing
    ? { address, tokens: [...new Set([...tag.tokens, ...tokens])] }
    : tag)
}

export function notebookCellRouteTags(
  document: NotebookDocument,
): Map<string, NotebookCellRouteTags> {
  const addressById = new Map(document.cells.map((cell) => [
    cell.id,
    notebookGridTag(cell.slot),
  ]))
  const tokensByTarget = inputTokensByTarget(document)
  const tags = new Map<string, NotebookCellRouteTags>()
  const tagsFor = (cellId: string) =>
    tags.get(cellId) ?? { outgoing: [], incoming: [] }
  for (const edge of document.edges) {
    const sourceAddress = addressById.get(edge.source)
    const targetAddress = addressById.get(edge.target)
    if (!sourceAddress || !targetAddress) continue
    const tokens = tokensByTarget.get(edge.target)?.get(edge.source) ?? []
    const sourceTags = tagsFor(edge.source)
    tags.set(edge.source, {
      ...sourceTags,
      outgoing: appendRouteTag(sourceTags.outgoing, targetAddress, tokens),
    })
    const targetTags = tagsFor(edge.target)
    tags.set(edge.target, {
      ...targetTags,
      incoming: appendRouteTag(targetTags.incoming, sourceAddress, tokens),
    })
  }
  return tags
}

function listedAddresses(tags: readonly NotebookRouteTag[]): string {
  const listed = tags.slice(0, listedAddressLimit).map((tag) => tag.address)
  const hidden = tags.length - listed.length
  return hidden > 0
    ? `${listed.join(' · ')} +${hidden}`
    : listed.join(' · ')
}

export function notebookOutgoingRouteText(
  tags: readonly NotebookRouteTag[],
): string | null {
  const [only] = tags
  if (!only) return null
  if (tags.length > 1) return listedAddresses(tags)
  return [only.address, ...only.tokens].join(' · ')
}

export function notebookIncomingRouteText(
  tags: readonly NotebookRouteTag[],
): string | null {
  if (tags.length === 0) return null
  if (tags.length > listedAddressLimit) return `from ${tags.length} cells`
  return `from ${tags.map((tag) => tag.address).join(' · ')}`
}
