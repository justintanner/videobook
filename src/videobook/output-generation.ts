import { generationInputTokenPattern } from '../../server/src/generation-input-targets'
import { abbreviateGenerationPhrases } from './notebook-generation-actions'
import { providerDisplayLabel } from './workspace-action-resources'

export type GenerationRunInput = {
  slot: string
  kind: 'image' | 'video' | 'audio'
  artifactId: string
  sourceCellId: string | null
  thumbnailUrl: string | null
}

export type OutputGeneration = {
  attemptId: string
  runId: string | null
  provider: string | null
  model: string | null
  prompt: string | null
  resolvedPrompt: string | null
  startedAt: number
  finishedAt: number | null
  inputs: GenerationRunInput[]
}

export type PromptSegment = { text: string; token: string | null }

export type GenerationAttemptRecord = OutputGeneration & {
  status: string
  artifactId: string | null
  outputCellId: string | null
  thumbnailUrl: string | null
}

type UnknownRecord = Record<string, unknown>

function recordOf(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function inputKind(value: unknown): GenerationRunInput['kind'] | null {
  return value === 'image' || value === 'video' || value === 'audio' ? value : null
}

function runInput(value: unknown): GenerationRunInput | null {
  const row = recordOf(value)
  const slot = text(row?.slot)
  const kind = inputKind(row?.kind)
  const artifactId = text(row?.artifactId)
  if (!row || !slot || !kind || !artifactId) return null
  return {
    slot,
    kind,
    artifactId,
    sourceCellId: text(row.sourceCellId),
    thumbnailUrl: text(row.thumbnailUrl),
  }
}

function runInputs(value: unknown): GenerationRunInput[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const input = runInput(entry)
    return input ? [input] : []
  })
}

function attemptRecord(value: unknown): GenerationAttemptRecord | null {
  const row = recordOf(value)
  const attemptId = text(row?.attemptId)
  const status = text(row?.status)
  const startedAt = finiteNumber(row?.createdAt)
  if (!row || !attemptId || !status || startedAt === null) return null
  return {
    attemptId,
    status,
    artifactId: text(row.artifactId),
    outputCellId: text(row.outputCellId),
    thumbnailUrl: text(row.thumbnailUrl),
    runId: text(row.runId),
    provider: text(row.provider),
    model: text(row.model),
    prompt: text(row.prompt),
    resolvedPrompt: text(row.resolvedPrompt),
    startedAt,
    finishedAt: status === 'completed' ? finiteNumber(row.updatedAt) : null,
    inputs: runInputs(row.inputs),
  }
}

/** Attempts from a `list_cell_generations` response, skipping malformed rows. */
export function parseGenerationAttempts(value: unknown): GenerationAttemptRecord[] {
  const attempts = recordOf(value)?.attempts
  if (!Array.isArray(attempts)) return []
  return attempts.flatMap((entry) => {
    const attempt = attemptRecord(entry)
    return attempt ? [attempt] : []
  })
}

/** The completed attempt whose output is this artifact, if one was recorded. */
export function producingGeneration(
  attempts: readonly GenerationAttemptRecord[],
  artifactId: string,
): OutputGeneration | null {
  const match = attempts.find((attempt) =>
    attempt.status === 'completed' && attempt.artifactId === artifactId)
  if (!match) return null
  return {
    attemptId: match.attemptId,
    runId: match.runId,
    provider: match.provider,
    model: match.model,
    prompt: match.prompt,
    resolvedPrompt: match.resolvedPrompt,
    startedAt: match.startedAt,
    finishedAt: match.finishedAt,
    inputs: match.inputs,
  }
}

/** Seconds from dispatch to completion, when both ends were recorded. */
export function generationRunSeconds(generation: OutputGeneration): number | null {
  if (generation.finishedAt === null || generation.finishedAt < generation.startedAt) return null
  return (generation.finishedAt - generation.startedAt) / 1000
}

/** The model id without a leading `provider:` the badge already shows. */
export function generationModelLabel(model: string | null, provider: string | null): string | null {
  if (!model) return null
  const prefix = provider ? `${provider}:` : null
  return prefix && model.startsWith(prefix) ? model.slice(prefix.length) : model
}

export function generationProviderLabel(provider: string | null): string | null {
  return provider ? providerDisplayLabel(provider) : null
}

export type CompactGenerationModel = {
  name: string
  mode: string | null
}

const modeSegment = /^(image|text|reference|video|audio|frame)-to-(video|image|audio|text)$/u
const editSegment = /^edit(?:-(?:image|video))?$/u
const providerPrefix = /^([a-z][a-z0-9-]*):(.+)$/u

function segmentMode(segment: string): string | null {
  const phrase = modeSegment.exec(segment)
  if (phrase) return `${phrase[1]![0]}2${phrase[2]![0]}`.toUpperCase()
  return editSegment.test(segment) ? 'EDIT' : null
}

export function compactGenerationModel(model: string, provider: string | null): CompactGenerationModel {
  const prefixed = providerPrefix.exec(model)
  const owner = provider ?? prefixed?.[1] ?? null
  const label = prefixed && (!provider || prefixed[1] === provider) ? prefixed[2]! : model
  const segments = label.split('/')
  const owned = owner === 'fal' && segments.length >= 3 ? segments.slice(1) : segments
  const mode = owned.length > 1 ? segmentMode(owned.at(-1)!) : null
  const name = (mode ? owned.slice(0, -1) : owned).join('/')
  return { name: abbreviateGenerationPhrases(name), mode }
}

export function compactGenerationModelLabel(model: string, provider: string | null): string {
  const compact = compactGenerationModel(model, provider)
  return compact.mode ? `${compact.name} · ${compact.mode}` : compact.name
}

export type GenerationIdentity = {
  provider: string | null
  model: string | null
  label: string
}

export function generationIdentity(
  provider: string | null | undefined,
  model: string | null | undefined,
): GenerationIdentity | null {
  const providerLabel = generationProviderLabel(provider || null)
  const modelLabel = generationModelLabel(model || null, provider || null)
  if (!providerLabel && !modelLabel) return null
  return {
    provider: providerLabel,
    model: modelLabel,
    label: [providerLabel, modelLabel].filter(Boolean).join(' · '),
  }
}

/** Prompt text split around `@image1`-style input slot tokens. */
export function generationPromptSegments(prompt: string): PromptSegment[] {
  const segments: PromptSegment[] = []
  let cursor = 0
  for (const match of prompt.matchAll(generationInputTokenPattern())) {
    const start = match.index ?? 0
    if (start > cursor) segments.push({ text: prompt.slice(cursor, start), token: null })
    segments.push({ text: match[0], token: match[0].slice(1).toLowerCase() })
    cursor = start + match[0].length
  }
  if (cursor < prompt.length) segments.push({ text: prompt.slice(cursor), token: null })
  return segments
}
