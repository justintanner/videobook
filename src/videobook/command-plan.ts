import type {
  ConfirmationPolicy,
  EditIntent,
  EditOperation,
  SearchQuery,
  SourceSurface,
} from 'videobook-engine'
import { isDestructiveEditOperation } from 'videobook-engine/edit-policy'

const COMMAND_PLAN_VERSION = 1 as const

interface CommandConfirmation {
  required: boolean
  policy: ConfirmationPolicy
  reason: string
}

interface CommandReference {
  kind: 'artifact' | 'stream' | 'source-range' | 'sequence' | 'notebook'
  targetId: string
  objectHash?: string
  revision?: string
  range?: Record<string, unknown>
}

interface CommandSuggestion {
  suggestionId: string
  label: string
  detail?: string
  included: boolean
  operation: EditOperation
}

interface CommandStageBase {
  stageId: string
  summary: string
}

export interface EditCommandStage extends CommandStageBase {
  kind: 'edit'
  intent: EditIntent
}

interface SearchCommandStage extends CommandStageBase {
  kind: 'search'
  query: SearchQuery
}

interface NotebookCommandStage extends CommandStageBase {
  kind: 'notebook'
  notebookId: string
  action:
    | 'add-source'
    | 'add-audio'
    | 'transcribe'
    | 'search'
    | 'pin-select'
    | 'send-to-sequence'
}

interface ExportCommandStage extends CommandStageBase {
  kind: 'export'
  sequenceId: string
  revision: string
  orientation: 'landscape' | 'portrait' | 'square'
  captions: 'burn-in' | 'sidecar' | 'omit'
}

interface QueuedCommandStage extends CommandStageBase {
  kind: 'queued'
  jobType: 'search' | 'generation' | 'indexing' | 'export'
  tool: string
  input: Record<string, unknown>
  provider?: string
  model?: string
  estimatedCostUsd?: number
  estimateUnavailable?: boolean
  insertsOutput: boolean
  continuation?: {
    sequenceId: string
    baseRevision: string
    destination: Record<string, unknown>
  }
}

type CommandPlanStage =
  | EditCommandStage
  | SearchCommandStage
  | NotebookCommandStage
  | ExportCommandStage
  | QueuedCommandStage

export interface CommandPlan {
  planVersion: typeof COMMAND_PLAN_VERSION
  planId: string
  sourceSurface: SourceSurface
  actor: string
  bookId: string
  summary: string
  normalizedReferences: CommandReference[]
  suggestions?: CommandSuggestion[]
  stages: CommandPlanStage[]
  confirmation: CommandConfirmation
  parentActionId?: string
}

interface CommandPlanContext {
  bookId?: string
  actor?: string
  normalizedReferences?: CommandReference[]
  parentActionId?: string
}

export function createEditCommandPlan(
  intent: EditIntent,
  summary: string,
  context: CommandPlanContext = {},
): CommandPlan {
  return createCommandPlan({
    planId: intent.commandId,
    sourceSurface: intent.sourceSurface,
    actor: context.actor ?? intent.actor,
    bookId: context.bookId ?? 'unresolved-book',
    summary,
    normalizedReferences: context.normalizedReferences ?? [],
    stages: [{
      stageId: `${intent.commandId}:edit:0`,
      kind: 'edit',
      summary,
      intent,
    }],
    ...(context.parentActionId
      ? { parentActionId: context.parentActionId }
      : {}),
  })
}

export function createSearchCommandPlan(
  planId: string,
  sourceSurface: SourceSurface,
  query: SearchQuery,
  summary: string,
  context: CommandPlanContext = {},
): CommandPlan {
  return createCommandPlan({
    planId,
    sourceSurface,
    actor: context.actor ?? 'videobook-user',
    bookId: context.bookId ?? 'unresolved-book',
    summary,
    normalizedReferences: context.normalizedReferences ?? [],
    stages: [{
      stageId: `${planId}:search:0`,
      kind: 'search',
      summary,
      query,
    }],
    ...(context.parentActionId
      ? { parentActionId: context.parentActionId }
      : {}),
  })
}

export function createCommandPlan(
  input: Omit<CommandPlan, 'planVersion' | 'confirmation'>,
): CommandPlan {
  const plan: CommandPlan = {
    ...input,
    planVersion: COMMAND_PLAN_VERSION,
    planId: requiredText(input.planId, 'Plan ID'),
    actor: requiredText(input.actor, 'Plan actor'),
    bookId: requiredText(input.bookId, 'Plan book'),
    summary: requiredText(input.summary, 'Plan summary'),
    normalizedReferences: input.normalizedReferences.map((reference) => ({
      ...reference,
      targetId: requiredText(reference.targetId, 'Reference target'),
    })),
    stages: input.stages.map((stage, index) => ({
      ...stage,
      stageId: requiredText(stage.stageId, `Stage ${index + 1} ID`),
      summary: requiredText(stage.summary, `Stage ${index + 1} summary`),
    })),
    confirmation: planConfirmation(input.stages),
  }
  validateCommandPlan(plan)
  return plan
}

export function validateCommandPlan(plan: CommandPlan): void {
  if (plan.planVersion !== COMMAND_PLAN_VERSION) {
    throw new Error(`Unsupported CommandPlan version: ${plan.planVersion}`)
  }
  if (plan.stages.length === 0) throw new Error('A CommandPlan requires a stage')
  for (const stage of plan.stages) {
    if (stage.kind === 'edit') {
      if (stage.intent.sourceSurface !== plan.sourceSurface) {
        throw new Error('Edit stage source surface must match its CommandPlan')
      }
      if (stage.intent.actor !== plan.actor) {
        throw new Error('Edit stage actor must match its CommandPlan')
      }
    }
    if (stage.kind === 'queued' && stage.insertsOutput && !stage.continuation) {
      throw new Error('Queued insert stages require a revision-pinned continuation')
    }
    if (
      stage.kind === 'queued'
      && stage.jobType === 'generation'
      && (!stage.provider || !stage.model)
    ) {
      throw new Error('Generation stages require provider and model disclosure')
    }
    if (
      stage.kind === 'queued'
      && stage.jobType === 'generation'
      && stage.estimatedCostUsd === undefined
      && stage.estimateUnavailable !== true
    ) {
      throw new Error('Generation stages require a cost estimate or unavailable warning')
    }
  }
}

function planConfirmation(
  stages: CommandPlanStage[],
): CommandConfirmation {
  const editStages = stages.filter(
    (stage): stage is EditCommandStage => stage.kind === 'edit',
  )
  const destructive = editStages.some((stage) =>
    stage.intent.operations.some(isDestructiveEditOperation))
  const paid = stages.some((stage) =>
    stage.kind === 'queued' && stage.jobType === 'generation')
  const multiStep = stages.length > 1
    || editStages.some((stage) => stage.intent.operations.length > 1)
  const always = editStages.some((stage) =>
    stage.intent.confirmationPolicy === 'always')
  const policy: ConfirmationPolicy = always || paid || multiStep || destructive
    ? 'always'
    : editStages[0]?.intent.confirmationPolicy ?? 'reversible-single-step'
  if (always) {
    return {
      required: true,
      policy,
      reason: 'This command requires confirmation by policy',
    }
  }
  if (paid) {
    return {
      required: true,
      policy,
      reason: 'This plan can incur provider spend',
    }
  }
  if (destructive) {
    return {
      required: true,
      policy,
      reason: 'This plan removes or replaces timeline content',
    }
  }
  if (multiStep) {
    return {
      required: true,
      policy,
      reason: 'This plan contains multiple ordered operations',
    }
  }
  return {
    required: false,
    policy,
    reason: stages[0]?.kind === 'search'
      ? 'Search does not mutate the book'
      : 'One reversible edit can apply immediately',
  }
}

export function equivalentEditOperations(plans: CommandPlan[]): boolean {
  const operations = plans.map((plan) =>
    plan.stages.flatMap((stage) =>
      stage.kind === 'edit' ? stage.intent.operations : []))
  return operations.every((candidate) =>
    JSON.stringify(candidate) === JSON.stringify(operations[0] ?? []))
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
}
