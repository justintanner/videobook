import {
  NOTEBOOK_GRID_COLUMN_COUNT,
  NOTEBOOK_GRID_ROW_COUNT,
  notebookGridTag,
} from 'videobook-engine/notebook-grid'
import { notebookMentionPrefixAtEnd, normalizeNotebookReference } from 'videobook-engine/notebook-mentions'
import type { NotebookGridSlot } from 'videobook-engine'
import type { AssetMentionRecord } from './mention-suggestions'
import { formatMediaTime } from './notebook-cell-presentation'

interface ComposerReferenceCell {
  id?: string
  slot: NotebookGridSlot
  type: string
  label?: string | null
  outputArtifactId?: string
  status?: string
}

export interface ComposerReference {
  token: string
  cellId: string | null
  label: string | null
  type: string
  status: string
  asset: (AssetMentionRecord & { label?: string | null }) | null
}

interface ComposerMentionRange {
  start: number
  end: number
  prefix: string
}

export function composerReferences(
  cells: readonly ComposerReferenceCell[],
  assets: readonly (AssetMentionRecord & { label?: string | null })[],
): ReadonlyMap<string, ComposerReference> {
  const cellsByToken = new Map(cells.map(cell => [notebookGridTag(cell.slot), cell]))
  const assetsById = new Map(assets.map(asset => [asset.artifactId, asset]))
  const references = new Map<string, ComposerReference>()
  for (let row = 0; row < NOTEBOOK_GRID_ROW_COUNT; row += 1) {
    for (let column = 0; column < NOTEBOOK_GRID_COLUMN_COUNT; column += 1) {
      const token = notebookGridTag({ row, column })
      const cell = cellsByToken.get(token)
      const asset = cell?.outputArtifactId ? assetsById.get(cell.outputArtifactId) ?? null : null
      const label = cell?.label?.trim() || asset?.label?.trim() || null
      references.set(token, {
        token,
        cellId: cell?.id ?? null,
        label: label === asset?.artifactId ? null : label,
        type: asset?.type ?? cell?.type ?? 'empty',
        status: asset?.status ?? (cell?.outputArtifactId ? 'missing' : cell?.status ?? (cell ? '' : 'empty')),
        asset,
      })
    }
  }
  return references
}

export function composerReferenceDescription(reference: ComposerReference): string {
  if (reference.type === 'empty') return 'Empty grid square'
  const parts = [reference.type.replaceAll('_', ' ').toUpperCase()]
  const duration = reference.asset?.duration
  if (duration && Number.isFinite(duration) && duration > 0) parts.push(formatMediaTime(duration))
  if (reference.status && reference.status !== 'ready') parts.push(reference.status.replaceAll('_', ' '))
  return parts.join(' · ')
}

export function activeComposerMention(
  input: string,
  selectionStart = input.length,
  selectionEnd = selectionStart,
): ComposerMentionRange | null {
  if (selectionStart !== selectionEnd) return null
  const prefix = notebookMentionPrefixAtEnd(input.slice(0, selectionStart))
  if (prefix === undefined) return null
  let end = selectionStart
  while (end < input.length && /[a-z0-9]/iu.test(input[end]!)) end += 1
  return { start: selectionStart - prefix.length - 1, end, prefix }
}

export function composerReferenceSuggestions(
  references: ReadonlyMap<string, ComposerReference>,
  input: string,
  selectionStart = input.length,
  selectionEnd = selectionStart,
  allowedArtifacts?: ReadonlySet<string>,
): ComposerReference[] {
  const mention = activeComposerMention(input, selectionStart, selectionEnd)
  if (!mention) return []
  return [...references.values()].filter(reference =>
    reference.token.slice(1).includes(mention.prefix)
    && (!allowedArtifacts || Boolean(reference.asset && allowedArtifacts.has(reference.asset.artifactId))))
    .slice(0, 12)
}

export function replaceComposerMention(
  input: string,
  token: string,
  selectionStart = input.length,
  selectionEnd = selectionStart,
): { value: string; caret: number } | null {
  const mention = activeComposerMention(input, selectionStart, selectionEnd)
  if (!mention) return null
  const reference = `@${normalizeNotebookReference(token)}`
  const suffix = input.slice(mention.end)
  const separator = !suffix || /^[\p{L}\p{N}@]/u.test(suffix) ? ' ' : ''
  const value = `${input.slice(0, mention.start)}${reference}${separator}${suffix}`
  return { value, caret: mention.start + reference.length + (separator || suffix.startsWith(' ') ? 1 : 0) }
}
