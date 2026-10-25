import type { PostView } from '../../server/src/posts/post-contract'
import type { NotebookAudioInfo, NotebookAnalysisInfo } from '@/videobook/notebook-cell-presentation'
import {
  type MediaTranscriptSources,
  type MediaVisionAnalysis,
  asMediaTranscriptSources,
  asMediaVisionAnalysis,
} from '@/videobook/media-insights'
import { type AssetTags, parseAssetTags } from '@/videobook/asset-tags'
import type { LibraryBrowseResult, LibraryStatusCounts } from '@/videobook/library-browse'
import { type CommandPlan, validateCommandPlan } from '@/videobook/command-plan'
import type { BookProjectSummary } from '@/videobook/book-project-catalog'
import type {
  NotebookDocument,
  Sequence,
  NotebookCellType,
  NotebookCellReference,
  PinnedSearchResult,
} from 'videobook-engine'
import type { ServerCommand } from '@/lib/command-registry'
import { type ChatModelCatalog, asChatModelCatalog } from '@/videobook/chat-models'
import { type NotebookGenerationAction, asNotebookGenerationActions } from '@/videobook/notebook-generation-actions'
import { parseProviderTaskStatus, type ProviderTaskStatus } from '../../server/src/provider-status-link'
import type { CellAssetRevision } from '@/components/videobook/NotebookCellInspector'
import {
  recordValue,
  asString,
  asNumber,
} from '@/videobook/value-decoders'
import type { ChainStepReviewValue, ChainRunValue } from '@/videobook/chat-action-review'
import { NOTEBOOK_GRID_ROW_COUNT, NOTEBOOK_GRID_COLUMN_COUNT } from 'videobook-engine/notebook-grid'
import type { ForgetAssetOutcome, ForgetAssetReference } from '@/videobook/forget-asset'
import type { InitialWorkspacePayload } from '@/videobook/initial-workspace'
import { parseStickySettings, type StickySettings } from '../../server/src/media/preferred-defaults'

type ToolResponse = {
  content?: Array<{ type: string; text?: string }>
  isError?: boolean
}

export type AssetRecord = {
  id: string
  artifactId: string
  label: string
  objectHash: string | null
  type: string
  createdAt: string
  mediaUrl: string | null
  thumbnailUrl: string | null
  status: string
  origin: string | null
  prompt: string | null
  width: number | null
  height: number | null
  duration: number | null
  fps: number | null
  waveform: number[] | null
  audioInfo: NotebookAudioInfo | null
  analysisInfo: NotebookAnalysisInfo | null
  transcript: MediaTranscriptSources | null
  visionAnalysis: MediaVisionAnalysis | null
  /** Engine-owned tags; null for rows that are not artifacts. */
  tags: AssetTags | null
}

export type LibraryAssetRecord = AssetRecord & {
  errorMessage: string | null
  owningBookId: string
  owningBookName: string
  lastUsedAt: string | null
}

type LibrarySearchResult = LibraryBrowseResult<LibraryAssetRecord> & {
  unindexedVisualAssets: number
}

export type IngestStatus = {
  artifactId: string
  state: string
  missingOutputs: string[]
  phases: Record<string, string>
}

export type ChatActionPlan = {
  kind: 'chat-action-plan'
  planId: string
  bookId: string
  prompt: string
  routedTool: string
  tool: string
  params: Record<string, unknown>
  message: string
  summary: string
  effect: 'mutation' | 'generation' | 'view'
  confirmation: {
    required: boolean
    reason: string
  }
}

export type JobRecord = {
  id: number
  operationId: string
  type: string
  state: string
  artifactId: string | null
  attempts: number
  maxAttempts: number
  error: { message: string; code: string | null } | null
  payload: Record<string, unknown> | null
  result: Record<string, unknown> | null
  providerTask?: ProviderTaskStatus | null
  enqueuedAt: number
  startedAt: number | null
  finishedAt: number | null
}

export type GenerationPlanRecord = {
  planId: string
  cellId: string
  status: string
  plan: CommandPlan
  outputArtifactId: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

type InitialWorkspace = {
  books: BookProjectSummary[]
  bookId: string
  notebook: NotebookDocument | null
  assets: AssetRecord[]
  ingestStatuses: IngestStatus[]
  sequence: Sequence | null
  jobs: JobRecord[]
  commands: ServerCommand[]
  chatModelCatalog: ChatModelCatalog
  generationActions: NotebookGenerationAction[]
}

const notebookCellTypes = new Set<string>([
  'audio',
  'image',
  'video',
  'extract_audio',
  'split_video',
  'prompt',
  'character',
  'analyze',
  'analysis',
  'generate_video',
  'generate_image',
  'generate_audio',
  'concat',
  'splice',
  'timeline',
  'goal',
  'post',
] satisfies NotebookCellType[])

export function asCellAssetRevisions(value: unknown): CellAssetRevision[] {
  if (!Array.isArray(value)) {
    throw new Error('The server returned invalid asset history')
  }
  return value.map((entry) => {
    const revision = recordValue(entry)
    const hash = revision && asString(revision.hash)
    const message = revision && asString(revision.message)
    const date = revision && asString(revision.date)
    if (!revision || !hash || message === null || !date) {
      throw new Error('The server returned an invalid asset revision')
    }
    return {
      hash,
      message,
      date,
      ...(asString(revision.author)
        ? { author: asString(revision.author)! }
        : {}),
      ...(asString(revision.operation)
        ? { operation: asString(revision.operation)! }
        : {}),
    }
  })
}

function responseText(result: unknown): string | null {
  const response = result as ToolResponse
  return response.content?.find((item) => item.type === 'text')?.text ?? null
}

export function parseResult(result: unknown): unknown {
  const response = result as ToolResponse
  const text = responseText(result)
  if (response.isError) throw new Error(text ?? 'MCP tool failed')
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

export function messageFor(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value
  const item = recordValue(value)
  if (!item) return fallback
  for (const key of ['message', 'job_id', 'notebook_id', 'address', 'bookId']) {
    const candidate = asString(item[key])
    if (candidate) return `${fallback}: ${candidate}`
  }
  return fallback
}

function asChainStepReview(value: unknown): ChainStepReviewValue | null {
  const item = recordValue(value)
  const stepId = asString(item?.stepId)
  const tool = asString(item?.tool)
  const title = asString(item?.title)
  const reason = asString(item?.reason)
  if (!stepId || !tool || !title || !reason) return null
  return {
    stepId,
    index: typeof item?.index === 'number' ? item.index : 0,
    total: typeof item?.total === 'number' ? item.total : 1,
    tool,
    title,
    address: asString(item?.address),
    params: recordValue(item?.params) ?? {},
    estimateUsd: typeof item?.estimateUsd === 'number' ? item.estimateUsd : null,
    estimateUnavailable: item?.estimateUnavailable !== false,
    reason,
  }
}

export function asChainRun(value: unknown): ChainRunValue | null {
  const item = recordValue(value)
  const chainId = asString(item?.chain_id)
  const status = asString(item?.status)
  if (asString(item?.kind) !== 'chain-run' || !chainId || !status) return null
  const steps = Array.isArray(item?.steps)
    ? item.steps.flatMap((entry) => {
        const step = recordValue(entry)
        const id = asString(step?.id)
        const tool = asString(step?.tool)
        const stepStatus = asString(step?.status)
        if (!id || !tool || !stepStatus) return []
        return [{
          id,
          tool,
          status: stepStatus,
          error: asString(step?.error),
          requiresApproval: step?.requires_approval === true,
          review: asChainStepReview(step?.review),
        }]
      })
    : []
  return {
    chainId,
    status,
    error: asString(item?.error),
    awaitingStepId: asString(item?.awaiting_step_id),
    steps,
  }
}

export function isDownloadVideoResult(value: unknown): boolean {
  const item = recordValue(value)
  return asString(item?.artifact_id) !== null
    && asString(item?.assetId) !== null
    && asString(item?.job_id)?.startsWith('download-') === true
}

export function asChatActionPlan(value: unknown): ChatActionPlan {
  const item = recordValue(value)
  const params = recordValue(item?.params)
  const confirmation = recordValue(item?.confirmation)
  const kind = asString(item?.kind)
  const planId = asString(item?.planId)
  const planBookId = asString(item?.bookId)
  const prompt = asString(item?.prompt)
  const routedTool = asString(item?.routedTool)
  const tool = asString(item?.tool)
  const message = asString(item?.message) ?? ''
  const summary = asString(item?.summary)
  const effect = asString(item?.effect)
  const reason = asString(confirmation?.reason)
  const required = confirmation?.required
  if (
    kind !== 'chat-action-plan'
    || !planId
    || !planBookId
    || !prompt
    || !routedTool
    || !tool
    || !params
    || !summary
    || (effect !== 'mutation' && effect !== 'generation' && effect !== 'view')
    || typeof required !== 'boolean'
    || !reason
  ) throw new Error('The server returned an invalid chat action plan')
  return {
    kind,
    planId,
    bookId: planBookId,
    prompt,
    routedTool,
    tool,
    params,
    message,
    summary,
    effect,
    confirmation: { required, reason },
  }
}

export function asBooks(value: unknown): BookProjectSummary[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = recordValue(entry)
    const bookId = item && asString(item.bookId)
    const name = item && asString(item.name)
    const createdAt = item && asNumber(item.createdAt)
    if (!item || !bookId || !name || createdAt === null) return []
    return [{
      bookId,
      name,
      createdAt,
      artifactCount: asNumber(item.artifactCount) ?? 0,
      notebookCount: asNumber(item.notebookCount) ?? 0,
    }]
  })
}

export function asBook(value: unknown): BookProjectSummary | null {
  return asBooks([value])[0] ?? null
}

function asNotebookCell(value: unknown): NotebookDocument['cells'][number] | null {
  const item = recordValue(value)
  const id = item && asString(item.id)
  const type = item && asString(item.type)
  const label = item && asString(item.label)
  const slot = item && recordValue(item.slot)
  const row = slot && asNumber(slot.row)
  const column = slot && asNumber(slot.column)
  if (
    !item
    || !id
    || row === null
    || column === null
    || !Number.isInteger(row)
    || !Number.isInteger(column)
    || row < 0
    || row >= NOTEBOOK_GRID_ROW_COUNT
    || column < 0
    || column >= NOTEBOOK_GRID_COLUMN_COUNT
  ) return null
  if (!notebookCellTypes.has(type ?? '')) return null
  const inputs = recordValue(item.inputs)
  const references = Array.isArray(item.references)
    ? item.references as NotebookCellReference[]
    : undefined
  const pinnedResults = Array.isArray(item.pinned_results ?? item.pinnedResults)
    ? (item.pinned_results ?? item.pinnedResults) as PinnedSearchResult[]
    : undefined
  return {
    id,
    type: type as NotebookCellType,
    ...(label ? { label } : {}),
    slot: { row, column },
    ...(asString(item.output_entity_id)
      ? { outputEntityId: asString(item.output_entity_id)! }
      : {}),
    ...(asString(item.prompt) !== null ? { prompt: asString(item.prompt)! } : {}),
    ...(asString(item.provider) !== null ? { provider: asString(item.provider)! } : {}),
    ...(asString(item.model) !== null ? { model: asString(item.model)! } : {}),
    ...(asString(item.operation) !== null ? { operation: asString(item.operation)! } : {}),
    ...(asString(item.tool) !== null ? { tool: asString(item.tool)! } : {}),
    ...(inputs ? { inputs } : {}),
    ...(references ? { references } : {}),
    ...(pinnedResults ? { pinnedResults } : {}),
    ...(asString(item.output_artifact_id ?? item.outputArtifactId)
      ? { outputArtifactId: asString(item.output_artifact_id ?? item.outputArtifactId)! }
      : {}),
  }
}

export type NotebookSnapshot = NotebookDocument & { revision?: string; posts?: PostView[]; generationSettingsMemory?: StickySettings }

export function asNotebook(value: unknown): NotebookSnapshot | null {
  const item = recordValue(value)
  const id = item && asString(item.id)
  const name = item && asString(item.name)
  const createdAt = item && asString(item.created_at ?? item.createdAt)
  if (!item || !id || !name || !createdAt) return null
  const cells = Array.isArray(item.cells)
    ? item.cells.flatMap((cell) => {
      const parsed = asNotebookCell(cell)
      return parsed ? [parsed] : []
    })
    : []
  const edges = Array.isArray(item.edges)
    ? item.edges.flatMap((edge) => {
      const parsed = recordValue(edge)
      const edgeId = parsed && asString(parsed.id)
      const source = parsed && asString(parsed.source)
      const target = parsed && asString(parsed.target)
      const targetInput = parsed && asString(parsed.targetInput ?? parsed.target_input)
      return edgeId && source && target && targetInput
        ? [{ id: edgeId, source, target, targetInput }]
        : []
    })
    : []
  return {
    id,
    name,
    createdAt,
    ...(asString(item.revision) ? { revision: asString(item.revision)! } : {}),
    ...(asString(item.description) ? { description: asString(item.description)! } : {}),
    ...(asString(item.lifecycleState ?? item.lifecycle_state)
      ? { lifecycleState: asString(item.lifecycleState ?? item.lifecycle_state)! }
      : {}),
    ...(asNumber(item.workflowVersion ?? item.workflow_version) !== null
      ? { workflowVersion: asNumber(item.workflowVersion ?? item.workflow_version)! }
      : {}),
    ...(asString(item.analysisRevision ?? item.analysis_revision)
      ? { analysisRevision: asString(item.analysisRevision ?? item.analysis_revision)! }
      : {}),
    ...(recordValue(item.fixture)
      ? { fixture: recordValue(item.fixture)! as NotebookDocument['fixture'] }
      : {}),
    ...(recordValue(item.execution)
      ? { execution: recordValue(item.execution)! as NonNullable<NotebookDocument['execution']> }
      : {}),
    ...(Array.isArray(item.generationPlans ?? item.generation_plans)
      ? {
          generationPlans: (
            item.generationPlans ?? item.generation_plans
          ) as NonNullable<NotebookDocument['generationPlans']>,
        }
      : {}),
    ...(Array.isArray(item.notebookRunPlans ?? item.notebook_run_plans)
      ? {
          notebookRunPlans: (
            item.notebookRunPlans ?? item.notebook_run_plans
          ) as NonNullable<NotebookDocument['notebookRunPlans']>,
        }
      : {}),
    ...(Array.isArray(item.posts) ? { posts: item.posts as PostView[] } : {}),
    ...(recordValue(item.generation_settings_memory)
      ? { generationSettingsMemory: parseStickySettings(recordValue(item.generation_settings_memory)!) }
      : {}),
    cells,
    edges,
  }
}

export function asNotebooks(value: unknown): NotebookDocument[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
      const notebook = asNotebook(entry)
      return notebook ? [notebook] : []
    })
    : []
}

function asAsset(value: unknown): AssetRecord | null {
  const item = recordValue(value)
  const id = item && asString(item.id)
  const artifactId = item && asString(item.artifact_id ?? item.artifactId)
  const type = item && asString(item.type)
  if (!item || !id || !artifactId || !type) return null
  const audio = recordValue(item.audio_info)
  const codec = audio && asString(audio.codec)
  const sampleRateHz = audio && asNumber(audio.sample_rate_hz)
  const channels = audio && asNumber(audio.channels)
  const channelLayout = audio && asString(audio.channel_layout)
  const durationSeconds = audio && asNumber(audio.duration_seconds)
  const audioInfo = codec
    && sampleRateHz !== null
    && channels !== null
    && channelLayout
    && durationSeconds !== null
    ? {
        codec,
        sampleRateHz,
        channels,
        channelLayout,
        durationSeconds,
      }
    : null
  const analysis = recordValue(item.analysis_info ?? item.analysisInfo)
  const sourceDurationSeconds = analysis
    && asNumber(analysis.source_duration_seconds ?? analysis.sourceDurationSeconds)
  const analysisShots = Array.isArray(analysis?.shots)
    ? analysis.shots.flatMap((value) => {
        const shot = recordValue(value)
        const ordinal = shot && asNumber(shot.ordinal)
        const label = shot && asString(shot.label)
        const startSeconds = shot
          && asNumber(shot.start_seconds ?? shot.startSeconds)
        const endSeconds = shot
          && asNumber(shot.end_seconds ?? shot.endSeconds)
        const durationSeconds = shot
          && asNumber(shot.duration_seconds ?? shot.durationSeconds)
        return ordinal !== null
          && label !== null
          && startSeconds !== null
          && endSeconds !== null
          && durationSeconds !== null
          ? [{
              ordinal,
              label,
              startSeconds,
              endSeconds,
              durationSeconds,
            }]
          : []
      })
    : []
  const analysisLlmExchangeValues =
    analysis?.llm_exchanges ?? analysis?.llmExchanges
  const analysisLlmExchanges = Array.isArray(analysisLlmExchangeValues)
    ? analysisLlmExchangeValues.flatMap((value) => {
        const exchange = recordValue(value)
        const provider = exchange && asString(exchange.provider)
        const model = exchange && asString(exchange.model)
        const stage = exchange && asString(exchange.stage)
        const responseFormatValue = exchange
          && recordValue(exchange.response_format ?? exchange.responseFormat)
        const responseFormatType = responseFormatValue
          && asString(responseFormatValue.type)
        return provider && model && stage
          ? [{
              provider,
              model,
              responseFormat: responseFormatType
                ? {
                    name: asString(responseFormatValue?.name),
                    strict: responseFormatValue?.strict === true,
                    type: responseFormatType,
                  }
                : null,
              stage,
            }]
          : []
      })
    : []
  const analysisInfo = sourceDurationSeconds !== null
    ? {
        sourceDurationSeconds,
        llmExchanges: analysisLlmExchanges,
        outputJson: analysis?.output_json ?? analysis?.outputJson ?? null,
        outputUrl: asString(analysis?.output_url ?? analysis?.outputUrl),
        shots: analysisShots,
      }
    : null
  const waveform = Array.isArray(item.waveform)
    ? item.waveform.flatMap((entry) =>
        typeof entry === 'number' && Number.isFinite(entry)
          ? [Math.max(-1, Math.min(1, entry))]
          : [])
    : null
  return {
    id,
    artifactId,
    label: asString(item.label) ?? id,
    objectHash: asString(item.object_hash ?? item.objectHash),
    type,
    createdAt: asString(item.created_at ?? item.createdAt) ?? '',
    mediaUrl: asString(item.media_url ?? item.mediaUrl),
    thumbnailUrl: asString(item.thumbnail_url ?? item.thumbnailUrl),
    status: asString(item.status) ?? 'ready',
    origin: asString(item.origin),
    prompt: asString(item.prompt),
    width: asNumber(item.width),
    height: asNumber(item.height),
    duration: asNumber(item.duration),
    fps: asNumber(item.fps),
    waveform,
    audioInfo,
    analysisInfo,
    transcript: asMediaTranscriptSources(item.transcript),
    visionAnalysis: asMediaVisionAnalysis(
      item.vision_analysis ?? item.visionAnalysis,
    ),
    tags: parseAssetTags(item.tags),
  }
}

export function asAssets(value: unknown): AssetRecord[] {
  const container = recordValue(value)
  const source = Array.isArray(value)
    ? value
    : Array.isArray(container?.assets)
      ? container.assets
      : []
  return source.flatMap((entry) => {
    const asset = asAsset(entry)
    return asset ? [asset] : []
  })
}

function asStatusCounts(value: unknown): LibraryStatusCounts {
  const item = recordValue(value)
  return {
    ready: Math.max(0, asNumber(item?.ready) ?? 0),
    processing: Math.max(0, asNumber(item?.processing) ?? 0),
    error: Math.max(0, asNumber(item?.error) ?? 0),
  }
}

export function asLibrarySearchResult(
  value: unknown,
  fallbackBook?: { owningBookId: string; owningBookName: string },
): LibrarySearchResult {
  const container = recordValue(value)
  const source = Array.isArray(container?.assets) ? container.assets : []
  const pageValue = recordValue(container?.page)
  const offset = asNumber(pageValue?.offset) ?? 0
  const limit = asNumber(pageValue?.limit) ?? 24
  const total = asNumber(pageValue?.total) ?? 0
  const errors = Array.isArray(container?.books_with_errors)
    ? container.books_with_errors
    : []
  return {
    unindexedVisualAssets: Math.max(0, asNumber(container?.unindexed_visual_assets) ?? 0),
    receivedCount: source.length,
    assets: source.flatMap((entry) => {
      const item = recordValue(entry)
      const asset = asAsset(item)
      if (!asset) return []
      const owningBookId = (item && asString(item.owning_book_id))
        ?? fallbackBook?.owningBookId
      const owningBookName = (item && asString(item.owning_book_name))
        ?? fallbackBook?.owningBookName
      const work = recordValue(item?.assetWork)
      const workMeta = recordValue(work?.meta)
      const errorMessage = asString(recordValue(workMeta?.error)?.message)
      const lastUsedAt = (item && asString(item.last_used_at)) ?? null
      return owningBookId && owningBookName
        ? [{ ...asset, owningBookId, owningBookName, errorMessage, lastUsedAt }]
        : []
    }),
    page: {
      offset,
      limit,
      total,
      hasMore: pageValue?.hasMore === true,
    },
    statusCounts: asStatusCounts(
      container?.status_counts ?? container?.statusCounts,
    ),
    booksWithErrors: errors.flatMap((entry) => {
      const item = recordValue(entry)
      const errorBookId = item && asString(item.book_id)
      const message = item && asString(item.message)
      return errorBookId && message ? [{ bookId: errorBookId, message }] : []
    }),
  }
}

export function asForgetAssetOutcome(value: unknown): ForgetAssetOutcome {
  const item = recordValue(value)
  const status = asString(item?.status) === 'in_use' ? 'in_use' : 'forgotten'
  const references = Array.isArray(item?.references) ? item.references : []
  return {
    status,
    artifactId: asString(item?.artifact_id) ?? '',
    label: asString(item?.label),
    references: references.flatMap((entry): ForgetAssetReference[] => {
      const row = recordValue(entry)
      const kind = row && asString(row.kind)
      const id = row && asString(row.id)
      return kind && id ? [{ kind, id }] : []
    }),
    clearedCells: asNumber(item?.cleared_cells) ?? 0,
    forgottenObjects: asNumber(item?.forgotten_objects) ?? 0,
    sharedObjects: asNumber(item?.shared_objects) ?? 0,
    reclaimedBytes: asNumber(item?.reclaimed_bytes) ?? 0,
  }
}

function asIngestStatuses(value: unknown): IngestStatus[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = recordValue(entry)
    const artifactId = item && asString(item.artifactId)
    const state = item && asString(item.state)
    const phases = item && recordValue(item.phases)
    if (!artifactId || !state || !phases) return []
    return [{
      artifactId,
      state,
      missingOutputs: Array.isArray(item.missingOutputs)
        ? item.missingOutputs.flatMap((value) => typeof value === 'string' ? [value] : [])
        : [],
      phases: Object.fromEntries(
        Object.entries(phases).flatMap(([key, state]) =>
          typeof state === 'string' ? [[key, state]] : []),
      ),
    }]
  })
}

export function asSequence(value: unknown): Sequence | null {
  const item = recordValue(value)
  return item
    && asString(item.sequenceId)
    && asString(item.revision)
    && Array.isArray(item.tracks)
    && Array.isArray(item.clips)
    && Array.isArray(item.captions)
    ? value as Sequence
    : null
}

export function asCommandPlan(value: unknown): CommandPlan {
  const item = recordValue(value)
  if (
    !item
    || item.planVersion !== 1
    || !asString(item.planId)
    || !Array.isArray(item.stages)
  ) {
    throw new Error('The server returned an invalid CommandPlan')
  }
  const plan = value as CommandPlan
  validateCommandPlan(plan)
  return plan
}

export function asJobs(value: unknown): JobRecord[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = recordValue(entry)
    const id = item && asNumber(item.id)
    const type = item && asString(item.type)
    const state = item && asString(item.state)
    const operationId = item && asString(item.operationId ?? item.operation_id)
    if (!item || id === null || !type || !state || !operationId) return []
    const error = recordValue(item.error)
    const payloadValue = item.payload
    const payload = payloadValue && typeof payloadValue === 'object'
      && !Array.isArray(payloadValue)
      ? payloadValue as Record<string, unknown>
      : null
    const result = recordValue(item.result)
    return [{
      id,
      operationId,
      type,
      state,
      artifactId: asString(item.artifactId ?? item.artifact_id),
      attempts: asNumber(item.attempts) ?? 0,
      maxAttempts: asNumber(item.maxAttempts ?? item.max_attempts) ?? 1,
      error: error && asString(error.message)
        ? {
            message: asString(error.message)!,
            code: asString(error.code),
          }
        : null,
      payload,
      result,
      providerTask: parseProviderTaskStatus(item.providerTask),
      enqueuedAt: asNumber(item.enqueuedAt ?? item.enqueued_at) ?? 0,
      startedAt: asNumber(item.startedAt ?? item.started_at),
      finishedAt: asNumber(item.finishedAt ?? item.finished_at),
    }]
  })
}

export function asGenerationPlans(value: unknown): GenerationPlanRecord[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = recordValue(entry)
    const planId = asString(item?.planId)
    const cellId = asString(item?.cellId)
    const status = asString(item?.status)
    const createdAt = asString(item?.createdAt)
    const updatedAt = asString(item?.updatedAt)
    if (!item || !planId || !cellId || !status || !createdAt || !updatedAt) return []
    try {
      return [{
        planId,
        cellId,
        status,
        plan: asCommandPlan(item.plan),
        outputArtifactId: asString(item.outputArtifactId),
        error: asString(item.error),
        createdAt,
        updatedAt,
      }]
    } catch {
      return []
    }
  })
}

export function asCommands(value: unknown): ServerCommand[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is ServerCommand => {
      const item = recordValue(entry)
      return item !== null
        && typeof item.command === 'string'
        && typeof item.description === 'string'
    })
    : []
}

export function asInitialWorkspace(
  payload: InitialWorkspacePayload | null,
): InitialWorkspace | null {
  if (!payload) return null
  const books = asBooks(payload.bookValue)
  const notebooks = asNotebooks(payload.notebookValue)
  return {
    books,
    bookId: payload.bookId,
    notebook: notebooks.find((entry) => entry.id === payload.notebookId) ?? null,
    assets: asAssets(payload.assetValue),
    ingestStatuses: asIngestStatuses(payload.ingestStatusValue),
    sequence: asSequence(payload.sequenceValue),
    jobs: asJobs(payload.jobValue),
    commands: asCommands(payload.commandValue),
    chatModelCatalog: asChatModelCatalog(payload.chatModelValue),
    generationActions: asNotebookGenerationActions(payload.actionValue),
  }
}
