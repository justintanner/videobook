import type { Edge, Node } from '@xyflow/react'
import type {
  BookAction,
  BookArtifactKind,
  ProjectBook,
} from 'videobook-engine'
import {
  notebookGridPosition,
  type NotebookGridSlot,
} from './notebook-grid'

export type BookCellKind =
  | 'prompt'
  | 'image'
  | 'video'
  | 'character'
  | 'scene'

export interface BookAsset {
  id: string
  type: string
  media_url: string | null
  thumbnail_url: string | null
  width: number | null
  height: number | null
  status?: string
}

export interface BookTrailItem {
  id: string
  title: string
  phase: string
  date: string
  actor: string
  revision: string
}

export interface BookCellData extends Record<string, unknown> {
  actionId: string
  kind: BookCellKind
  title: string
  stage: number
  status: string
  slug: string
  operation: string
  revision: string
  actor: string
  lane: string
  prompt?: string
  model?: string
  mediaUrl?: string
  thumbnailUrl?: string
  width?: number
  height?: number
  trail: BookTrailItem[]
  source: BookAction
}

interface ActionCard {
  action: BookAction
  artifactId: string
  kind: BookCellKind
}

const visibleKinds = new Set<BookArtifactKind>([
  'prompt',
  'image',
  'video',
  'character',
  'scene',
])

function isBookCellKind(value: unknown): value is BookCellKind {
  return value === 'prompt'
    || value === 'image'
    || value === 'video'
    || value === 'character'
    || value === 'scene'
}

function detailsRecord(
  action: BookAction,
  key: string,
): Record<string, unknown> {
  const value = action.details[key]
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {}
}

function explicitEntry(action: BookAction): {
  id: string
  kind: BookCellKind
} | null {
  const entry = detailsRecord(action, 'entry')
  return typeof entry.id === 'string' && isBookCellKind(entry.kind)
    ? { id: entry.id, kind: entry.kind }
    : null
}

function actionCards(actions: BookAction[]): ActionCard[] {
  const semanticOutputs = new Map<string, ActionCard>()
  const fallbackOutputs = new Map<string, ActionCard>()
  for (const action of actions) {
    const entry = explicitEntry(action)
    if (entry) {
      semanticOutputs.set(entry.id, {
        action,
        artifactId: entry.id,
        kind: entry.kind,
      })
    }
    for (const artifact of action.outputArtifacts) {
      if (!visibleKinds.has(artifact.kind)) continue
      const card = {
        action,
        artifactId: artifact.id,
        kind: artifact.kind as BookCellKind,
      }
      fallbackOutputs.set(artifact.id, card)
      if (action.operation.startsWith('book:')) {
        semanticOutputs.set(artifact.id, card)
      }
    }
  }
  const cards = [
    ...new Map([
      ...fallbackOutputs,
      ...semanticOutputs,
    ]).values(),
  ].sort((left, right) => left.action.date.localeCompare(right.action.date))
  const cardIds = new Set(cards.map((card) => card.action.id))
  const producerByArtifact = new Map(
    cards.map((card) => [card.artifactId, card.action.id]),
  )
  const remaining = new Map(cards.map((card) => [card.action.id, card]))
  const ordered: ActionCard[] = []
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((card) => {
      const dependencies = [
        ...card.action.parentActionIds.filter((id) => cardIds.has(id)),
        ...card.action.inputArtifacts.flatMap((artifact) => {
          const producer = producerByArtifact.get(artifact.id)
          return producer && producer !== card.action.id ? [producer] : []
        }),
      ]
      return dependencies.every((id) => !remaining.has(id))
    })
    const batch = ready.length > 0 ? ready : [[...remaining.values()][0]!]
    for (const card of batch) {
      remaining.delete(card.action.id)
      ordered.push(card)
    }
  }
  return ordered
}

function stringDetail(
  action: BookAction,
  key: string,
): string | undefined {
  const value = action.details[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function nestedString(
  action: BookAction,
  parent: string,
  key: string,
): string | undefined {
  const record = detailsRecord(action, parent)
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function actionPrompt(action: BookAction): string | undefined {
  const entry = detailsRecord(action, 'entry')
  const prompt = entry.prompt
  if (typeof prompt === 'string') return prompt
  return stringDetail(action, 'prompt')
    ?? nestedString(action, 'arguments', 'prompt')
}

function actionTitle(action: BookAction, artifactId: string): string {
  const entry = detailsRecord(action, 'entry')
  const title = entry.title
  return typeof title === 'string' && title.length > 0
    ? title
    : artifactId
}

function actionModel(action: BookAction): string | undefined {
  const entry = detailsRecord(action, 'entry')
  const model = entry.model
  return typeof model === 'string'
    ? model
    : nestedString(action, 'arguments', 'model')
}

function latestLayouts(actions: BookAction[]): Map<string, NotebookGridSlot> {
  const layouts = new Map<string, NotebookGridSlot>()
  for (const action of actions) {
    if (!action.layout) continue
    const target = action.targetActionId ?? action.id
    layouts.set(target, action.layout)
  }
  return layouts
}

function relatedTrail(
  action: BookAction,
  artifactId: string,
  actions: BookAction[],
): BookTrailItem[] {
  return actions
    .filter((candidate) => (
      candidate.id === action.id
      || candidate.targetActionId === action.id
      || candidate.targetArtifactId === artifactId
      || candidate.inputArtifacts.some((artifact) => artifact.id === artifactId)
      || candidate.outputArtifacts.some((artifact) => artifact.id === artifactId)
    ))
    .flatMap((candidate) => candidate.events.map((event) => ({
      id: event.id,
      title: candidate.title,
      phase: event.phase,
      date: event.date,
      actor: candidate.actor,
      revision: event.revision,
    })))
    .sort((left, right) => left.date.localeCompare(right.date))
}

function cardParents(
  card: ActionCard,
  producerByArtifact: Map<string, string>,
  cardIds: Set<string>,
): string[] {
  const explicit = card.action.parentActionIds.filter((id) => cardIds.has(id))
  const inferred = card.action.inputArtifacts.flatMap((artifact) => {
    const producer = producerByArtifact.get(artifact.id)
    return producer && producer !== card.action.id ? [producer] : []
  })
  return [...new Set([...explicit, ...inferred])]
}

function derivedSlots(
  cards: ActionCard[],
  layouts: Map<string, NotebookGridSlot>,
): Map<string, NotebookGridSlot> {
  const slots = new Map<string, NotebookGridSlot>()
  const producerByArtifact = new Map<string, string>()
  const cardIds = new Set(cards.map((card) => card.action.id))
  const occupied = new Map<number, Set<number>>()
  for (const card of cards) {
    const parents = cardParents(card, producerByArtifact, cardIds)
    const minimumStage = parents.reduce((stage, parentId) => (
      Math.max(stage, (slots.get(parentId)?.stage ?? -1) + 1)
    ), 0)
    const requested = layouts.get(card.action.id) ?? card.action.layout
    const stage = Math.max(minimumStage, requested?.stage ?? minimumStage)
    const stageColumns = occupied.get(stage) ?? new Set<number>()
    let column = requested?.column ?? 0
    while (stageColumns.has(column)) column += 1
    stageColumns.add(column)
    occupied.set(stage, stageColumns)
    slots.set(card.action.id, { stage, column })
    producerByArtifact.set(card.artifactId, card.action.id)
  }
  return slots
}

function assetMap(assets: BookAsset[]): Map<string, BookAsset> {
  return new Map(assets.map((asset) => [asset.id.replace(/^@/, ''), asset]))
}

export function projectBookNodes(
  book: ProjectBook,
  assets: BookAsset[],
): Array<Node<BookCellData>> {
  const cards = actionCards(book.actions)
  const layouts = latestLayouts(book.actions)
  const slots = derivedSlots(cards, layouts)
  const assetsById = assetMap(assets)
  return cards.map((card) => {
    const slot = slots.get(card.action.id) ?? { stage: 0, column: 0 }
    const asset = assetsById.get(card.artifactId)
    const mediaUrl = asset?.media_url ?? undefined
    const thumbnailUrl = asset?.thumbnail_url ?? undefined
    return {
      id: card.action.id,
      type: 'cell',
      position: notebookGridPosition(slot),
      data: {
        actionId: card.action.id,
        kind: card.kind,
        title: actionTitle(card.action, card.artifactId),
        stage: slot.stage + 1,
        status: asset?.status ?? card.action.phase,
        slug: `@${card.artifactId.replace(/^@/, '')}`,
        operation: card.action.title,
        revision: card.action.events.at(-1)?.revision ?? '',
        actor: card.action.actor,
        lane: card.action.lane,
        ...(actionPrompt(card.action) === undefined
          ? {}
          : { prompt: actionPrompt(card.action) }),
        ...(actionModel(card.action) === undefined
          ? {}
          : { model: actionModel(card.action) }),
        ...(mediaUrl ? { mediaUrl } : {}),
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
        ...(typeof asset?.width === 'number' ? { width: asset.width } : {}),
        ...(typeof asset?.height === 'number' ? { height: asset.height } : {}),
        trail: relatedTrail(card.action, card.artifactId, book.actions),
        source: card.action,
      },
    }
  })
}

export function projectBookEdges(
  book: ProjectBook,
): Edge[] {
  const cards = actionCards(book.actions)
  const cardIds = new Set(cards.map((card) => card.action.id))
  const producerByArtifact = new Map<string, string>()
  const edges: Edge[] = []
  for (const card of cards) {
    for (const source of cardParents(card, producerByArtifact, cardIds)) {
      edges.push({
        id: `trail-${source}-${card.action.id}`,
        source,
        target: card.action.id,
        label: card.action.title,
        className: 'book-trail-edge',
      })
    }
    producerByArtifact.set(card.artifactId, card.action.id)
  }
  return edges
}

export function parseProjectBook(value: unknown): ProjectBook | null {
  if (
    typeof value !== 'object'
    || value === null
    || !('slug' in value)
    || typeof value.slug !== 'string'
    || !('headRevision' in value)
    || typeof value.headRevision !== 'string'
    || !('actions' in value)
    || !Array.isArray(value.actions)
  ) {
    return null
  }
  return value as ProjectBook
}

export function parseBookAssets(value: unknown): BookAsset[] {
  if (typeof value !== 'object' || value === null || !('assets' in value)) {
    return []
  }
  return Array.isArray(value.assets)
    ? value.assets.filter((asset): asset is BookAsset => (
        typeof asset === 'object'
        && asset !== null
        && 'id' in asset
        && typeof asset.id === 'string'
      ))
    : []
}
