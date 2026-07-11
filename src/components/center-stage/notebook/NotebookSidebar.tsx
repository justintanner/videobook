import { useMemo } from 'react'
import { AlertCircle, ChevronDown, Clock3, ImageIcon, Loader2, Pin, PinOff, Play, Video, X } from 'lucide-react'
import type { UseMcpResult } from 'use-mcp/react'
import { CharacterPickerPopover } from '@/components/gen/ui/CharacterPickerPopover'
import { DynamicField } from '@/components/gen/ui/DynamicField'
import { genThemes } from '@/components/gen/ui/gen-themes'
import { getMode, modeRequiredMissing, visibleParams } from '@/components/gen/modes'
import type { JSONSchemaProperty, ModelOption, ModelModes } from '@/components/gen/types'
import { usePromptHistory } from '@/hooks/usePromptHistory'
import { RichPromptField } from '@/components/ui/RichPromptField'
import { cn } from '@/lib/utils'
import type { MediaItem } from '@/components/sidebar/types'
import {
  CLIP_PRECISION,
  clipWindowPayload,
  displayClipWindow,
  normalizeClipWindow,
  sharedFiniteBounds,
  type ClipBounds,
} from './clip-window'
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

/** Explicit /type from step.properties.mode, else model default_mode. */
function resolveModeKey(modes: ModelModes | null | undefined, stored: unknown): string | null {
  if (!modes) return null
  if (typeof stored === 'string' && modes.modes.some((m) => m.key === stored)) return stored
  return modes.default_mode
}

function schemaEnumOptions(schema: JSONSchemaProperty): string[] {
  return (schema.enum ?? []).map(String)
}

function coerceSchemaValue(schema: JSONSchemaProperty, raw: string): string | number {
  if (schema.type === 'integer') return parseInt(raw, 10)
  if (schema.type === 'number') return parseFloat(raw)
  return raw
}

/** Value + chevron hug content; invisible native select covers the control. */
function CompactSelect({
  id,
  label,
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  id: string
  label?: string
  value: string
  options: ReadonlyArray<{ value: string; label: string }>
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
}) {
  const display = options.find((o) => o.value === value)?.label ?? value
  return (
    <div className={cn('vc-notebook-inline-field', className)}>
      {label ? <label htmlFor={id}>{label}</label> : null}
      <div className={cn('vc-notebook-compact-select', disabled && 'is-disabled')}>
        <span className="vc-notebook-compact-select-value">{display}</span>
        <ChevronDown className="vc-notebook-compact-select-chevron" aria-hidden />
        <select
          id={id}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          aria-label={label}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>
    </div>
  )
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
        <label htmlFor="notebook-title">Notebook title</label>
        <input
          id="notebook-title"
          className="vc-notebook-text"
          value={title}
          onChange={(event) => updateDefinition(
            { ...definition, properties: { ...definition.properties, title: event.target.value } },
            'text:notebook:title',
          )}
          placeholder="Untitled notebook"
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
  const modeKey = resolveModeKey(option?.modes, step.properties.mode)
  const activeMode = option?.modes && modeKey ? getMode(option.modes, modeKey) : null
  const modeVisible = useMemo(
    () => (option?.modes && modeKey ? visibleParams(option.modes, modeKey) : null),
    [option, modeKey],
  )
  const history = usePromptHistory(callTool, category === 'image' ? 'image_generate' : 'video_generate', projectSlug)
  const runStatus = stepRunStatus(step, mediaItems)
  const readiness = stepInputReadiness(definition, step, mediaItems)
  const requiredMissing = useMemo(() => {
    if (!option) return ['model']
    const missing = (option.schema.required ?? []).filter((name) => {
      if (name === 'project_slug') return false
      if (modeVisible && !modeVisible.has(name)) return false
      const value = mergedValues[name]
      return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
    })
    if (activeMode) missing.push(...modeRequiredMissing(activeMode, mergedValues))
    return Array.from(new Set(missing))
  }, [option, mergedValues, activeMode, modeVisible])
  const persistedValues = record(step.properties.values)
  const update = (patch: JsonRecord, coalesceKey?: string) => updateDefinition(
    updateProperties(definition, step.id, patch),
    coalesceKey,
  )
  const updateValues = (name: string, value: unknown) => update({
    values: { ...persistedValues, [name]: value } as JsonRecord,
  })
  const modelOptions = preview.preview?.model_options ?? []
  // Inline row: type + duration + aspect_ratio. Remaining settings go under Options.
  const INLINE_OPTION_KEYS = new Set(['duration', 'aspect_ratio'])
  const clipStartVisible = Boolean(
    option?.schema.properties.video_clip_start
    && (!modeVisible || modeVisible.has('video_clip_start')),
  )
  const clipEndsVisible = Boolean(
    option?.schema.properties.video_clip_ends
    && (!modeVisible || modeVisible.has('video_clip_ends')),
  )
  const clipBounds = clipStartVisible && clipEndsVisible
    ? sharedFiniteBounds(option?.schema.properties.video_clip_start, option?.schema.properties.video_clip_ends)
    : null
  const showClipComposite = clipStartVisible && clipEndsVisible
  const fieldVisible = (name: string): boolean =>
    name !== 'project_slug'
    && name !== 'prompt'
    && name !== 'character_refs'
    && name !== 'voice_refs'
    && name !== 'seed'
    && !(showClipComposite && (name === 'video_clip_start' || name === 'video_clip_ends'))
    && !CONNECTION_OWNED_PARAMS.includes(name as typeof CONNECTION_OWNED_PARAMS[number])
    && (!modeVisible || modeVisible.has(name))
  const fieldEntries = option
    ? Object.entries(option.schema.properties).filter(([name]) => (
      fieldVisible(name) && !INLINE_OPTION_KEYS.has(name)
    ))
    : []
  const durationSchema = option?.schema.properties.duration
  const aspectSchema = option?.schema.properties.aspect_ratio
  const showDuration = Boolean(durationSchema && fieldVisible('duration'))
  const showAspect = Boolean(aspectSchema && fieldVisible('aspect_ratio'))
  const showType = Boolean(option?.modes && modeKey)
  const showInlineRow = showType || showDuration || showAspect
  const showCharacters = Boolean(
    option?.schema.properties.character_refs
    && (!modeVisible || modeVisible.has('character_refs')),
  )
  const characterField = option?.schema.properties.character_refs
  const disabledReason = requiredMissing.length > 0
    ? `Missing: ${requiredMissing.join(', ')}`
    : !readiness.ready
      ? readiness.reasons.join(' ')
      : undefined
  const applyClipWindow = (start: number, ends: number) => {
    const payload = clipWindowPayload(start, ends)
    update({
      values: {
        ...persistedValues,
        video_clip_start: payload.video_clip_start,
        video_clip_ends: payload.video_clip_ends,
      } as JsonRecord,
    })
  }

  const domainTheme = genThemes[category]

  return (
    <aside className={`vc-notebook-sidebar vc-notebook-editor vc-notebook-editor-${category}`}>
      <div className={`vc-notebook-cell-type vc-notebook-cell-type-${category}`}>{category}</div>
      {preview.loading && !preview.preview ? <div className="vc-notebook-loading"><Loader2 /> Loading controls</div> : null}
      {preview.error ? <div className="vc-notebook-error"><AlertCircle /> {preview.error}</div> : null}
      {option ? (
        <>
          <CompactSelect
            id={`step-model-${step.id}`}
            label="Model"
            value={`${preview.selectedModelKey}::${preview.selectedProviderKey}`}
            disabled={running}
            onChange={(raw) => {
              const [nextModel, nextProvider = ''] = raw.split('::')
              update({ model: nextModel, provider: nextProvider, mode: null })
              preview.selectModel(nextModel, nextProvider)
            }}
            options={modelOptions.flatMap((candidate) => {
              const providers = candidate.providers?.length ? candidate.providers : [{ key: '', label: '' }]
              return providers.map((candidateProvider) => ({
                value: `${candidate.key}::${candidateProvider.key}`,
                label: providers.length > 1 ? `${candidate.label} · ${candidateProvider.label}` : candidate.label,
              }))
            })}
          />
          {showInlineRow ? (
            <div className="vc-notebook-inline-controls">
              {showType ? (
                <CompactSelect
                  id={`step-type-${step.id}`}
                  label="Type"
                  value={modeKey!}
                  disabled={running}
                  onChange={(next) => update({ mode: next })}
                  options={option.modes!.modes.map((mode) => ({ value: mode.key, label: mode.label }))}
                />
              ) : null}
              {showDuration && durationSchema ? (
                <CompactSelect
                  id={`step-duration-${step.id}`}
                  label="Duration"
                  value={
                    mergedValues.duration != null
                      ? String(mergedValues.duration)
                      : durationSchema.default != null
                        ? String(durationSchema.default)
                        : (schemaEnumOptions(durationSchema)[0] ?? '')
                  }
                  disabled={running}
                  onChange={(raw) => updateValues('duration', coerceSchemaValue(durationSchema, raw))}
                  options={schemaEnumOptions(durationSchema).map((entry) => ({ value: entry, label: entry }))}
                />
              ) : null}
              {showAspect && aspectSchema ? (
                <CompactSelect
                  id={`step-aspect-${step.id}`}
                  label="Aspect ratio"
                  value={
                    mergedValues.aspect_ratio != null
                      ? String(mergedValues.aspect_ratio)
                      : aspectSchema.default != null
                        ? String(aspectSchema.default)
                        : (schemaEnumOptions(aspectSchema)[0] ?? '')
                  }
                  disabled={running}
                  onChange={(raw) => updateValues('aspect_ratio', coerceSchemaValue(aspectSchema, raw))}
                  options={schemaEnumOptions(aspectSchema).map((entry) => ({ value: entry, label: entry }))}
                />
              ) : null}
            </div>
          ) : null}
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
          {fieldEntries.length > 0 || showClipComposite ? <>
            <label>Options</label>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {showClipComposite ? (
                <ClipWindowControl
                  startValue={mergedValues.video_clip_start}
                  endsValue={mergedValues.video_clip_ends}
                  bounds={clipBounds}
                  startSchema={option.schema.properties.video_clip_start}
                  endsSchema={option.schema.properties.video_clip_ends}
                  disabled={running}
                  theme={domainTheme}
                  onChange={applyClipWindow}
                />
              ) : null}
              {fieldEntries.map(([name, schema]) => {
                const override = activeMode?.param_overrides?.[name]
                const fieldSchema = override
                  ? { ...schema, maxItems: override.maxItems ?? schema.maxItems, description: override.description ?? schema.description }
                  : schema
                return (
                  <DynamicField
                    key={name}
                    name={name}
                    schema={fieldSchema}
                    value={mergedValues[name]}
                    onChange={(value) => updateValues(name, value)}
                    required={(option.schema.required ?? []).includes(name)}
                    disabled={running}
                    theme={domainTheme}
                    callTool={callTool}
                    mcpState={mcpState}
                    projectSlug={projectSlug}
                    compact
                  />
                )
              })}
            </div>
          </> : null}
          {showCharacters && characterField ? (
            <CharacterPickerPopover
              selectedRefs={stringArray(mergedValues.character_refs)}
              onChange={(refs) => updateValues('character_refs', refs)}
              maxItems={characterField.maxItems ?? 7}
              disabled={running}
              callTool={callTool}
              mcpState={mcpState}
              projectSlug={projectSlug}
              domain={category}
              variant="inline"
            />
          ) : null}
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
          <RunStatus status={runStatus.state} />
          {error ? <div className="vc-notebook-error"><AlertCircle /> {error}</div> : null}
          <RunStepButton
            running={running}
            category={category}
            disabled={requiredMissing.length > 0 || !readiness.ready || running}
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
  category,
  disabled,
  disabledReason,
  cost,
  onClick,
}: {
  running: boolean
  category: 'image' | 'video'
  disabled: boolean
  disabledReason?: string
  cost: string | null
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={cn(
        'vc-notebook-run',
        category === 'image' ? 'vc-notebook-run-image' : 'vc-notebook-run-video',
        running && 'vc-notebook-run-busy',
      )}
      disabled={disabled}
      title={disabled && disabledReason ? disabledReason : undefined}
      onClick={onClick}
    >
      {running ? <Loader2 /> : <Play />}
      <span>{running ? 'Submitting' : 'Run'}</span>
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

function ClipWindowControl({
  startValue,
  endsValue,
  bounds,
  startSchema,
  endsSchema,
  disabled,
  theme = genThemes.video,
  onChange,
}: {
  startValue: unknown
  endsValue: unknown
  bounds: ClipBounds | null
  startSchema: JSONSchemaProperty
  endsSchema: JSONSchemaProperty
  disabled?: boolean
  theme?: typeof genThemes.video
  onChange: (start: number, ends: number) => void
}) {
  if (!bounds) {
    const startNum = typeof startValue === 'number' ? startValue : ''
    const endsNum = typeof endsValue === 'number' ? endsValue : ''
    return (
      <div className="vc-notebook-clip-window w-full min-w-[220px]">
        <span className="vc-notebook-clip-window-label">Clip window</span>
        <div className="vc-notebook-clip-window-pair">
          <label className="vc-notebook-clip-window-pair-field">
            <span>Start</span>
            <input
              type="number"
              step={CLIP_PRECISION}
              min={startSchema.minimum}
              max={startSchema.maximum}
              value={startNum}
              disabled={disabled}
              onChange={(event) => {
                const next = event.target.value === '' ? undefined : Number(event.target.value)
                if (next === undefined || Number.isNaN(next)) return
                const ends = typeof endsValue === 'number' ? endsValue : next + CLIP_PRECISION
                onChange(next, ends)
              }}
            />
          </label>
          <label className="vc-notebook-clip-window-pair-field">
            <span>End</span>
            <input
              type="number"
              step={CLIP_PRECISION}
              min={endsSchema.minimum}
              max={endsSchema.maximum}
              value={endsNum}
              disabled={disabled}
              onChange={(event) => {
                const next = event.target.value === '' ? undefined : Number(event.target.value)
                if (next === undefined || Number.isNaN(next)) return
                const start = typeof startValue === 'number' ? startValue : Math.max(0, next - CLIP_PRECISION)
                onChange(start, next)
              }}
            />
          </label>
        </div>
      </div>
    )
  }

  const display = displayClipWindow(startValue, endsValue, bounds)
  const commit = (start: number, ends: number) => {
    const normalized = normalizeClipWindow(start, ends, bounds)
    onChange(normalized.start, normalized.ends)
  }

  return (
    <div className="vc-notebook-clip-window w-full min-w-[240px]">
      <div className="vc-notebook-clip-window-head">
        <span className="vc-notebook-clip-window-label">Clip window</span>
        <div className="vc-notebook-clip-window-values">
          <input
            type="number"
            step={CLIP_PRECISION}
            min={bounds.min}
            max={bounds.max}
            value={display.start}
            disabled={disabled}
            aria-label="Clip start seconds"
            onChange={(event) => {
              const next = Number(event.target.value)
              if (Number.isNaN(next)) return
              commit(next, display.ends)
            }}
          />
          <span>–</span>
          <input
            type="number"
            step={CLIP_PRECISION}
            min={bounds.min}
            max={bounds.max}
            value={display.ends}
            disabled={disabled}
            aria-label="Clip end seconds"
            onChange={(event) => {
              const next = Number(event.target.value)
              if (Number.isNaN(next)) return
              commit(display.start, next)
            }}
          />
          <span className="vc-notebook-clip-window-unit">s</span>
        </div>
      </div>
      <div className="vc-notebook-clip-window-track">
        <input
          type="range"
          min={bounds.min}
          max={bounds.max}
          step={CLIP_PRECISION}
          value={display.start}
          disabled={disabled}
          aria-label="Clip start"
          className={cn(
            'vc-notebook-clip-window-range vc-notebook-clip-window-range-start',
            theme.sliderTrack,
            theme.sliderThumb,
          )}
          onChange={(event) => commit(Number(event.target.value), display.ends)}
        />
        <input
          type="range"
          min={bounds.min}
          max={bounds.max}
          step={CLIP_PRECISION}
          value={display.ends}
          disabled={disabled}
          aria-label="Clip end"
          className={cn(
            'vc-notebook-clip-window-range vc-notebook-clip-window-range-end',
            theme.sliderTrack,
            theme.sliderThumb,
          )}
          onChange={(event) => commit(display.start, Number(event.target.value))}
        />
      </div>
    </div>
  )
}
