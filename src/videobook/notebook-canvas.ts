import type { PostView } from '../../server/src/posts/post-contract'
import type { NotebookSnapshot } from './workspace-responses'
import {
  type NotebookCellData,
  notebookNodes,
  type NotebookFlowEdge,
} from '@/videobook/notebook-draft'
import type { AssetRecord, JobRecord } from '@/videobook/workspace-responses'
import type { Node } from '@xyflow/react'
import type { NotebookDocument } from 'videobook-engine'
import { recordValue, asString } from '@/videobook/value-decoders'
import { notebookGridTag } from 'videobook-engine/notebook-grid'
import { formatMediaAspectRatio, notebookSplitFrameIds } from '@/videobook/notebook-cell-presentation'
import { notebookMediaWorkState } from '@/videobook/notebook-media-work'
import { seedance25FrameAspectRatio } from '../../server/src/seedance25'

export interface CanvasCellData extends NotebookCellData {
  post?: PostView
  postSource?: PostSourcePreview
  asset?: AssetRecord
  deleting?: boolean
  revealing?: boolean
  highlighted?: boolean
  videoAspectRatio?: string
  videoDurationSeconds?: number
  splitFrames?: {
    first: { artifactId: string | null; asset?: AssetRecord }
    last: { artifactId: string | null; asset?: AssetRecord }
  }
}

export type PostSourcePreview = {
  address: string | null
  asset?: AssetRecord
}

export type CanvasNode = Node<CanvasCellData>

function postSourcePreview(
  post: PostView,
  cells: NotebookDocument['cells'],
  byArtifactId: ReadonlyMap<string, AssetRecord>,
): PostSourcePreview | null {
  const source = post.definition.source
  if (!source) return null
  const cell = cells.find((candidate) => candidate.id === source.cellId)
  const asset = byArtifactId.get(source.snapshotArtifactId ?? '') ?? byArtifactId.get(source.artifactId)
  return {
    address: cell ? notebookGridTag(cell.slot) : null,
    ...(asset ? { asset } : {}),
  }
}

export function artifactForCell(
  assets: ReadonlyMap<string, AssetRecord>,
  outputArtifactId: string | undefined,
): AssetRecord | undefined {
  return outputArtifactId ? assets.get(outputArtifactId) : undefined
}

function cellExecutionStatus(
  document: NotebookDocument,
  cellId: string,
): string {
  const execution = recordValue(document.execution)
  const item = execution && recordValue(execution[cellId])
  const cell = document.cells.find((candidate) => candidate.id === cellId)
  if (!item) {
    return asString(cell?.inputs?.state)
      ?? (cell?.outputArtifactId ? 'completed' : 'ready')
  }
  if (asString(item.error)) return 'error'
  return asString(item.status)
    ?? asString(cell?.inputs?.state)
    ?? 'ready'
}

function cellExecutionStartedAt(
  document: NotebookDocument,
  cellId: string,
): string | undefined {
  const execution = recordValue(document.execution)
  const item = execution && recordValue(execution[cellId])
  return asString(item?.startedAt) ?? asString(item?.updatedAt) ?? undefined
}

function cellExecutionError(
  document: NotebookDocument,
  cellId: string,
): string | undefined {
  const execution = recordValue(document.execution)
  const item = execution && recordValue(execution[cellId])
  return asString(item?.error) ?? undefined
}

function positiveMediaSetting(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function videoCanvasMetadata(
  document: NotebookDocument,
  cellId: string,
  asset: AssetRecord | undefined,
): { aspectRatio: string | null; durationSeconds: number | null } {
  const cell = document.cells.find((candidate) => candidate.id === cellId)
  const producerCellId = asString(cell?.inputs?.producerCellId)
    ?? document.edges.find((edge) =>
      edge.target === cellId && edge.targetInput === 'media')?.source
    ?? null
  const producer = producerCellId
    ? document.cells.find((candidate) => candidate.id === producerCellId)
    : undefined
  const generationSettings = producer?.type === 'generate_video'
    ? recordValue(producer.inputs?.generationSettings)
    : null
  const configuredAspectRatio = seedance25FrameAspectRatio(producer?.tool ?? '', producer?.inputs ?? {}) ?? asString(
    cell?.inputs?.aspectRatio ?? cell?.inputs?.aspect_ratio,
  ) ?? asString(generationSettings?.aspect_ratio)
  const aspectRatio = configuredAspectRatio
    && configuredAspectRatio !== 'adaptive'
    && configuredAspectRatio !== 'auto'
    ? configuredAspectRatio
    : formatMediaAspectRatio(asset?.width ?? null, asset?.height ?? null)
  const actualDuration = positiveMediaSetting(asset?.duration)
  const configuredDuration = positiveMediaSetting(
    cell?.inputs?.durationSeconds
      ?? cell?.inputs?.duration_seconds
      ?? generationSettings?.duration
      ?? generationSettings?.duration_seconds,
  )
  return {
    aspectRatio,
    durationSeconds: actualDuration ?? configuredDuration,
  }
}

export function canvasNodes(
  document: NotebookDocument,
  assets: AssetRecord[],
  jobs: JobRecord[],
): CanvasNode[] {
  const byArtifactId = new Map(assets.map((asset) => [asset.artifactId, asset]))
  return notebookNodes(document).map((node) => {
    const post = (document as NotebookSnapshot).posts?.find(item => item.id === node.id)
    const postSource = post ? postSourcePreview(post, document.cells, byArtifactId) : null
    const frameIds = notebookSplitFrameIds(node.data.inputs)
    const asset = artifactForCell(byArtifactId, node.data.outputArtifactId)
    const videoMetadata = node.data.kind === 'video'
      ? videoCanvasMetadata(document, node.id, asset)
      : null
    const fallbackStartedAt = cellExecutionStartedAt(document, node.id)
    const fallbackError = cellExecutionError(document, node.id)
    const work = notebookMediaWorkState(
      node.data.kind,
      asset,
      jobs,
      {
        status: cellExecutionStatus(document, node.id),
        ...(fallbackStartedAt ? { startedAt: fallbackStartedAt } : {}),
        ...(fallbackError ? { error: fallbackError } : {}),
      },
    )
    return {
      ...node,
      data: {
        ...node.data,
        status: post?.runtime.status ?? work.status,
        ...(post ? { post } : {}),
        ...(postSource ? { postSource } : {}),
        ...(work.startedAt ? { statusStartedAt: work.startedAt } : {}),
        ...(work.error ? { statusError: work.error } : {}),
        asset,
        ...(videoMetadata?.aspectRatio
          ? { videoAspectRatio: videoMetadata.aspectRatio }
          : {}),
        ...(videoMetadata?.durationSeconds
          ? { videoDurationSeconds: videoMetadata.durationSeconds }
          : {}),
        ...(node.data.kind === 'split_video'
          ? {
              splitFrames: {
                first: {
                  artifactId: frameIds.first,
                  ...(frameIds.first && byArtifactId.has(frameIds.first)
                    ? { asset: byArtifactId.get(frameIds.first)! }
                    : {}),
                },
                last: {
                  artifactId: frameIds.last,
                  ...(frameIds.last && byArtifactId.has(frameIds.last)
                    ? { asset: byArtifactId.get(frameIds.last)! }
                    : {}),
                },
              },
            }
          : {}),
      },
    }
  })
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  return JSON.stringify(left) === JSON.stringify(right)
}

// Rebuilt nodes/edges carry fresh object identities on every poll tick. Reuse
// the previous object whenever content is unchanged so React Flow skips
// re-rendering (and re-measuring) untouched cells, and carry over the runtime
// state React Flow manages outside our data pipeline (selection, measurement,
// in-flight drags).
export function reconcileCanvasNodes(
  current: CanvasNode[],
  next: CanvasNode[],
): CanvasNode[] {
  const previousById = new Map(current.map((node) => [node.id, node]))
  const merged = next.map((node) => {
    const previous = previousById.get(node.id)
    if (!previous) return node
    const candidate: CanvasNode = {
      ...node,
      ...(previous.selected !== undefined ? { selected: previous.selected } : {}),
      ...(previous.measured !== undefined ? { measured: previous.measured } : {}),
      ...(previous.dragging !== undefined ? { dragging: previous.dragging } : {}),
      ...(previous.dragging ? { position: previous.position } : {}),
    }
    return jsonEqual(candidate, previous) ? previous : candidate
  })
  const unchanged = merged.length === current.length
    && merged.every((node, index) => node === current[index])
  return unchanged ? current : merged
}

export function reconcileFlowEdges(
  current: NotebookFlowEdge[],
  next: NotebookFlowEdge[],
): NotebookFlowEdge[] {
  const previousById = new Map(current.map((edge) => [edge.id, edge]))
  const merged = next.map((edge) => {
    const previous = previousById.get(edge.id)
    if (!previous) return edge
    const candidate: NotebookFlowEdge = {
      ...edge,
      ...(previous.selected !== undefined ? { selected: previous.selected } : {}),
    }
    return jsonEqual(candidate, previous) ? previous : candidate
  })
  const unchanged = merged.length === current.length
    && merged.every((edge, index) => edge === current[index])
  return unchanged ? current : merged
}
