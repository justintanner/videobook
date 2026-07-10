import { useMemo } from 'react'
import { AlertCircle, Clock3, ImageIcon, Loader2, Pin, PinOff, Play, Video, X } from 'lucide-react'
import type { UseMcpResult } from 'use-mcp/react'
import { CharacterPickerPopover } from '@/components/gen/ui/CharacterPickerPopover'
import { DynamicField } from '@/components/gen/ui/DynamicField'
import { genThemes } from '@/components/gen/ui/gen-themes'
import { getMode, inferModeKey, modeRequiredMissing } from '@/components/gen/modes'
import type { ModelOption } from '@/components/gen/types'
import { usePromptHistory } from '@/hooks/usePromptHistory'
import { RichPromptField } from '@/components/ui/RichPromptField'
import { cn } from '@/lib/utils'
import type { MediaItem } from '@/components/sidebar/types'
import {
  CONNECTION_OWNED_PARAMS,
  assetSlugKind,
  latestAssetId,
  resolveEffectiveValues,
  stepInputReadiness,
  stepInputs,
  stepRunStatus,
} from './model'
import type { JsonRecord, NotebookPlanDefinition, NotebookPlanStep, NotebookRunState } from './types'
import { useGenPreview } from './useGenPreview'

interface NotebookSidebarProps {
  projectSlug: string
  callTool: UseMcpResult['callTool']
  mcpState: UseMcpResult['state']
  definition: NotebookPlanDefinition
  selectedStepId: string | null
  mediaItems: MediaItem[]
  stepCosts: ReadonlyMap<string, string>
  runningStepIds: ReadonlySet<string>
  errors: ReadonlyMap<string, string>
  updateDefinition: (next: NotebookPlanDefinition, coalesceKey?: string) => void
  onDisconnect: (sourceId: string, targetId: string) => void
  onSetFirstFrame: (targetId: string, sourceId: string | null) => void
  onRun: (step: NotebookPlanStep, option: ModelOption, provider: string, values: Record<string, unknown>) => void
  onOpenAsset?: (assetId: string) => void
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function updateProperties(
  definition: NotebookPlanDefinition,
  stepId: string,
  patch: JsonRecord,
): NotebookPlanDefinition {
  return {
    ...definition,
    sequence: definition.sequence.map((step) => step.id === stepId
      ? { ...step, properties: { ...step.properties, ...patch } }
      : step),
  }
}

export function NotebookSidebar({
  projectSlug,
  callTool,
  mcpState,
  definition,
  selectedStepId,
  mediaItems,
  stepCosts,
  runningStepIds,
  errors,
  updateDefinition,
  onDisconnect,
  onSetFirstFrame,
  onRun,
  onOpenAsset,
}: NotebookSidebarProps) {
  const selected = definition.sequence.find((step) => step.id === selectedStepId) ?? null
  if (!selected) {
    const title = typeof definition.properties.title === 'string' ? definition.properties.title : ''
    return (
      <aside className="vc-notebook-sidebar vc-notebook-editor">
        <label htmlFor="notebook-title">Plan title</label>
        <input
          id="notebook-title"
          className="vc-notebook-text"
          value={title}
          onChange={(event) => updateDefinition(
            { ...definition, properties: { ...definition.properties, title: event.target.value } },
            'text:plan:title',
          )}
          placeholder="Untitled plan"
        />
        <p className="vc-notebook-hint">Select a node to edit it. Connect nodes on the canvas to supply prompts and references.</p>
      </aside>
    )
  }
  if (selected.type === 'prompt') {
    const text = typeof selected.properties.text === 'string' ? selected.properties.text : ''
    return (
      <aside className="vc-notebook-sidebar vc-notebook-editor">
        <div className="vc-notebook-cell-type vc-notebook-cell-type-prompt">Prompt</div>
        <label htmlFor={`step-text-${selected.id}`}>Prompt</label>
        <textarea
          id={`step-text-${selected.id}`}
          className="vc-notebook-text"
          value={text}
          onChange={(event) => updateDefinition(
            updateProperties(definition, selected.id, { text: event.target.value }),
            `text:${selected.id}:prompt`,
          )}
          placeholder="Write the instruction this notebook will reuse."
          rows={8}
        />
      </aside>
    )
  }
  if (selected.type === 'asset') {
    return <AssetSidebar step={selected} definition={definition} mediaItems={mediaItems} onOpenAsset={onOpenAsset} />
  }
  return (
    <GenerationSidebar
      projectSlug={projectSlug}
      callTool={callTool}
      mcpState={mcpState}
      definition={definition}
      step={selected}
      mediaItems={mediaItems}
      costLabel={stepCosts.get(selected.id) ?? null}
      running={runningStepIds.has(selected.id)}
      error={errors.get(selected.id) ?? null}
      updateDefinition={updateDefinition}
      onDisconnect={onDisconnect}
      onSetFirstFrame={onSetFirstFrame}
      onRun={onRun}
    />
  )
}

function AssetSidebar({
  step,
  definition,
  mediaItems,
  onOpenAsset,
}: {
  step: NotebookPlanStep
  definition: NotebookPlanDefinition
  mediaItems: MediaItem[]
  onOpenAsset?: (assetId: string) => void
}) {
  const slug = typeof step.properties.slug === 'string' ? step.properties.slug : '@missing'
  const assetId = slug.replace(/^@/, '')
  const item = mediaItems.find((media) => media.id === assetId)
  const uses = definition.sequence.filter((candidate) => stepInputs(candidate).includes(step.id)).length
  return (
    <aside className="vc-notebook-sidebar vc-notebook-editor">
      <div className="vc-notebook-cell-type vc-notebook-cell-type-asset">Asset</div>
      {item?.thumbnailSrc ? <img className="vc-notebook-asset-preview" src={item.thumbnailSrc} alt="" /> : <ImageIcon />}
      <code>{slug}</code>
      <span className="vc-notebook-hint">{assetSlugKind(slug) ?? 'unknown'} · used by {uses} cell{uses === 1 ? '' : 's'}</span>
      {item ? (
        <button type="button" className="vc-notebook-input-button" onClick={() => onOpenAsset?.(item.id)}>Open asset</button>
      ) : <div className="vc-notebook-error"><AlertCircle /> Asset is missing.</div>}
    </aside>
  )
}

interface GenerationSidebarProps {
  projectSlug: string
  callTool: UseMcpResult['callTool']
  mcpState: UseMcpResult['state']
  definition: NotebookPlanDefinition
  step: NotebookPlanStep
  mediaItems: MediaItem[]
  costLabel: string | null
  running: boolean
  error: string | null
  updateDefinition: NotebookSidebarProps['updateDefinition']
  onDisconnect: NotebookSidebarProps['onDisconnect']
  onSetFirstFrame: NotebookSidebarProps['onSetFirstFrame']
  onRun: NotebookSidebarProps['onRun']
}

function GenerationSidebar({
  projectSlug,
  callTool,
  mcpState,
  definition,
  step,
  mediaItems,
  costLabel,
  running,
  error,
  updateDefinition,
  onDisconnect,
  onSetFirstFrame,
  onRun,
}: GenerationSidebarProps) {
  const category: 'image' | 'video' = step.type === 'video' ? 'video' : 'image'
  const model = typeof step.properties.model === 'string' ? step.properties.model : ''
  const provider = typeof step.properties.provider === 'string' ? step.properties.provider : ''
  const preview = useGenPreview({ category, projectSlug, callTool, model, provider })
  const option = preview.selectedOption
  const resolved = useMemo(
    () => (option ? resolveEffectiveValues(definition, step, option) : null),
    [option, definition, step],
  )
  const mergedValues = useMemo(
    () => ({ ...(option?.prefilled_values ?? {}), ...(resolved?.values ?? record(step.properties.values)) }),
    [option?.prefilled_values, resolved, step.properties.values],
  )
  const modeKey = option?.modes ? inferModeKey(option.modes, mergedValues) : null
  const activeMode = option?.modes && modeKey ? getMode(option.modes, modeKey) : null
  const history = usePromptHistory(callTool, category === 'image' ? 'image_generate' : 'video_generate', projectSlug)
  const runStatus = stepRunStatus(step, mediaItems)
  const readiness = stepInputReadiness(definition, step, mediaItems)
  const requiredMissing = useMemo(() => {
    if (!option) return ['model']
    const missing = (option.schema.required ?? []).filter((name) => {
      if (name === 'project_slug') return false
      const value = mergedValues[name]
      return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
    })
    if (activeMode) missing.push(...modeRequiredMissing(activeMode, mergedValues))
    return Array.from(new Set(missing))
  }, [option, mergedValues, activeMode])
  const persistedValues = record(step.properties.values)
  const update = (patch: JsonRecord, coalesceKey?: string) => updateDefinition(
    updateProperties(definition, step.id, patch),
    coalesceKey,
  )
  const updateValues = (name: string, value: unknown) => update({
    values: { ...persistedValues, [name]: value } as JsonRecord,
  })
  const modelOptions = preview.preview?.model_options ?? []
  const fieldEntries = option
    ? Object.entries(option.schema.properties).filter(([name]) => (
      name !== 'project_slug'
      && name !== 'prompt'
      && name !== 'character_refs'
      && !CONNECTION_OWNED_PARAMS.includes(name as typeof CONNECTION_OWNED_PARAMS[number])
    ))
    : []
  const characterField = option?.schema.properties.character_refs
  const disabledReason = requiredMissing.length > 0
    ? `Missing: ${requiredMissing.join(', ')}`
    : !readiness.ready
      ? readiness.reasons.join(' ')
      : undefined

  return (
    <aside className="vc-notebook-sidebar vc-notebook-editor">
      <div className={`vc-notebook-cell-type vc-notebook-cell-type-${category}`}>{category}</div>
      {preview.loading && !preview.preview ? <div className="vc-notebook-loading"><Loader2 /> Loading controls</div> : null}
      {preview.error ? <div className="vc-notebook-error"><AlertCircle /> {preview.error}</div> : null}
      {option ? (
        <>
          <label htmlFor={`step-model-${step.id}`}>Model</label>
          <select
            id={`step-model-${step.id}`}
            className="vc-notebook-select"
            value={`${preview.selectedModelKey}::${preview.selectedProviderKey}`}
            disabled={running}
            onChange={(event) => {
              const [nextModel, nextProvider = ''] = event.target.value.split('::')
              update({ model: nextModel, provider: nextProvider })
              preview.selectModel(nextModel, nextProvider)
            }}
          >
            {modelOptions.flatMap((candidate) => {
              const providers = candidate.providers?.length ? candidate.providers : [{ key: '', label: '' }]
              return providers.map((candidateProvider) => (
                <option key={`${candidate.key}::${candidateProvider.key}`} value={`${candidate.key}::${candidateProvider.key}`}>
                  {providers.length > 1 ? `${candidate.label} · ${candidateProvider.label}` : candidate.label}
                </option>
              ))
            })}
          </select>
          <label>Prompt</label>
          {resolved?.promptFromInputs !== null ? (
            <div className="vc-notebook-linked-prompt">
              <span>From connected prompt node</span>
              <p>{resolved?.promptFromInputs}</p>
            </div>
          ) : (
            <RichPromptField
              value={typeof mergedValues.prompt === 'string' ? mergedValues.prompt : ''}
              onChange={(value) => updateValues('prompt', value)}
              resolveRef={() => null}
              assetSlugs={mediaItems.map((item) => item.slug.replace(/^@/, ''))}
              slugForAssetId={(id) => mediaItems.find((item) => item.id === id)?.slug.replace(/^@/, '') ?? null}
              rows={5}
              disabled={running}
              placeholder="Describe this generation."
              onKeyDownExtra={(event) => {
                if (event.key === 'ArrowUp') {
                  const previous = history.navigateBack(typeof mergedValues.prompt === 'string' ? mergedValues.prompt : '')
                  if (previous !== null) updateValues('prompt', previous)
                  return previous !== null
                }
                if (event.key === 'ArrowDown') {
                  const next = history.navigateForward()
                  if (next !== null) updateValues('prompt', next)
                  return next !== null
                }
                return false
              }}
            />
          )}
          <label>Inputs</label>
          <InputList
            definition={definition}
            step={step}
            option={option}
            mediaItems={mediaItems}
            onDisconnect={onDisconnect}
            onSetFirstFrame={onSetFirstFrame}
          />
          {(resolved?.warnings.length || readiness.reasons.length) ? (
            <div className="vc-notebook-warnings">
              {[...(resolved?.warnings ?? []), ...readiness.reasons].map((warning) => <p key={warning}>{warning}</p>)}
            </div>
          ) : null}
          {fieldEntries.length > 0 ? <>
            <label>Options</label>
            <div className="flex flex-wrap gap-x-6 gap-y-3">
              {fieldEntries.map(([name, schema]) => (
                <DynamicField
                  key={name}
                  name={name}
                  schema={schema}
                  value={mergedValues[name]}
                  onChange={(value) => updateValues(name, value)}
                  required={(option.schema.required ?? []).includes(name)}
                  disabled={running}
                  theme={genThemes.plan}
                  callTool={callTool}
                  mcpState={mcpState}
                  projectSlug={projectSlug}
                />
              ))}
            </div>
          </> : null}
          {characterField ? <>
            <label>Characters</label>
            <CharacterPickerPopover
              selectedRefs={stringArray(mergedValues.character_refs)}
              onChange={(refs) => updateValues('character_refs', refs)}
              maxItems={characterField.maxItems ?? 7}
              disabled={running}
              callTool={callTool}
              mcpState={mcpState}
              projectSlug={projectSlug}
              domain="plan"
            />
          </> : null}
          <RunStatus status={runStatus.state} />
          {error ? <div className="vc-notebook-error"><AlertCircle /> {error}</div> : null}
          <RunStepButton
            running={running}
            disabled={requiredMissing.length > 0 || !readiness.ready || running || runStatus.state === 'pending'}
            disabledReason={disabledReason}
            cost={costLabel}
            onClick={() => onRun(step, option, preview.selectedProviderKey, mergedValues)}
          />
        </>
      ) : null}
    </aside>
  )
}

function InputList({
  definition,
  step,
  option,
  mediaItems,
  onDisconnect,
  onSetFirstFrame,
}: {
  definition: NotebookPlanDefinition
  step: NotebookPlanStep
  option: ModelOption
  mediaItems: MediaItem[]
  onDisconnect: NotebookSidebarProps['onDisconnect']
  onSetFirstFrame: NotebookSidebarProps['onSetFirstFrame']
}) {
  const sources = new Map(definition.sequence.map((candidate) => [candidate.id, candidate]))
  const pin = typeof step.properties.first_frame_source === 'string' ? step.properties.first_frame_source : null
  const inputs = stepInputs(step)
  if (inputs.length === 0) return <p className="vc-notebook-hint">Connect nodes on the canvas to add inputs.</p>
  return (
    <div className="vc-notebook-input-list">
      {inputs.map((id) => {
        const source = sources.get(id)
        if (!source) return null
        const slug = source.type === 'asset'
          ? typeof source.properties.slug === 'string' ? source.properties.slug : ''
          : latestAssetId(source) ? `@${latestAssetId(source)}` : ''
        const item = slug ? mediaItems.find((media) => media.id === slug.replace(/^@/, '')) : null
        const kind = source.type === 'prompt' ? null : assetSlugKind(slug)
        const canPin = kind === 'image' && Boolean(option.schema.properties.first_frame_slug)
        const label = source.type === 'prompt'
          ? (typeof source.properties.text === 'string' ? source.properties.text : '').slice(0, 48) || 'Empty prompt'
          : source.type === 'asset'
            ? slug
            : `${typeof source.properties.model === 'string' ? source.properties.model : source.type} · ${slug || 'no output'}`
        return (
          <div className="vc-notebook-input-chip" key={id}>
            {item?.thumbnailSrc ? <img src={item.thumbnailSrc} alt="" /> : kind === 'video' ? <Video /> : <ImageIcon />}
            <span>{label}</span>
            {canPin ? <button type="button" title={pin === id ? 'Unpin first frame' : 'Use as first frame'} onClick={() => onSetFirstFrame(step.id, pin === id ? null : id)}>
              {pin === id ? <Pin /> : <PinOff />}
            </button> : null}
            <button type="button" title="Disconnect" onClick={() => onDisconnect(id, step.id)}><X /></button>
          </div>
        )
      })}
    </div>
  )
}

function RunStepButton({
  running,
  disabled,
  disabledReason,
  cost,
  onClick,
}: {
  running: boolean
  disabled: boolean
  disabledReason?: string
  cost: string | null
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={cn('vc-notebook-run', running && 'vc-notebook-run-busy')}
      disabled={disabled}
      title={disabled && disabledReason ? disabledReason : undefined}
      onClick={onClick}
    >
      {running ? <Loader2 /> : <Play />}
      <span>{running ? 'Running' : 'Run'}</span>
      {cost ? <b>{cost}</b> : null}
    </button>
  )
}

function RunStatus({ status }: { status: NotebookRunState }) {
  if (status === 'idle' || status === 'ready') return null
  if (status === 'missing') return <div className="vc-notebook-status"><Clock3 /> Syncing</div>
  if (status === 'pending') return <div className="vc-notebook-status"><Clock3 /> Running</div>
  return <div className="vc-notebook-status"><AlertCircle /> Failed</div>
}
