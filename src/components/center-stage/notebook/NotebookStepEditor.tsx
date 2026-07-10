import { useMemo } from 'react'
import { AlertCircle, Clock3, ImageIcon, Loader2, Video } from 'lucide-react'
import { useStepEditor } from 'sequential-workflow-designer-react'
import type { UseMcpResult } from 'use-mcp/react'
import { CharacterPickerPopover } from '@/components/gen/ui/CharacterPickerPopover'
import { DynamicField } from '@/components/gen/ui/DynamicField'
import { GenerateCommandButton } from '@/components/gen/GenerateCommandButton'
import { GenSection } from '@/components/gen/ui/GenSection'
import { MediaStrip } from '@/components/gen/ui/MediaStrip'
import { appendImageSlug, deriveStripSlots } from '@/components/gen/ui/media-strip'
import { ModelProviderSelector } from '@/components/gen/ui/ModelSelector'
import { PromptSection } from '@/components/gen/ui/PromptSection'
import { genThemes } from '@/components/gen/ui/gen-themes'
import { isAssetField } from '@/components/gen/ui/fieldHelpers'
import { effectiveToolName, getMode, inferModeKey, modeRequiredMissing } from '@/components/gen/modes'
import type { ModelOption } from '@/components/gen/types'
import type { EstimateCall } from '@/hooks/useEstimateCost'
import { useEstimateCost } from '@/hooks/useEstimateCost'
import { usePromptHistory } from '@/hooks/usePromptHistory'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { MediaItem } from '@/components/sidebar/types'
import { useEditorBridgeState } from './editorBridge'
import type { EditorBridge } from './editorBridge'
import { nearestPromptAbove, latestAssetId, stepRunStatus } from './model'
import type { JsonRecord, NotebookPlanDefinition, NotebookPlanStep, NotebookRunState } from './types'
import { useGenPreview } from './useGenPreview'

interface NotebookStepEditorProps {
  projectSlug: string
  callTool: UseMcpResult['callTool']
  // Volatile data (poll-driven assets, run state) arrives via the bridge:
  // this editor renders in a separate React root, so parent prop updates
  // never reach a mounted instance. Everything else must be identity-stable.
  bridge: EditorBridge
  onRun: (
    step: NotebookPlanStep,
    option: ModelOption,
    provider: string,
    values: Record<string, unknown>,
  ) => void
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

export function NotebookStepEditor({
  projectSlug,
  callTool,
  bridge,
  onRun,
  onOpenAsset,
}: NotebookStepEditorProps) {
  const editor = useStepEditor<NotebookPlanStep, NotebookPlanDefinition>()
  const { mediaItems, runningStepIds, errors, mcpState } = useEditorBridgeState(bridge)
  const step = editor.step

  if (step.type === 'prompt') {
    return <PromptCellEditor editor={editor} />
  }

  return (
    <GenerationCellEditor
      editor={editor}
      projectSlug={projectSlug}
      callTool={callTool}
      mcpState={mcpState}
      definition={editor.definition}
      mediaItems={mediaItems}
      running={runningStepIds.has(step.id)}
      error={errors.get(step.id) ?? null}
      onRun={onRun}
      onOpenAsset={onOpenAsset}
    />
  )
}

function PromptCellEditor({
  editor,
}: {
  editor: ReturnType<typeof useStepEditor<NotebookPlanStep, NotebookPlanDefinition>>
}) {
  const text = typeof editor.properties.text === 'string' ? editor.properties.text : ''

  return (
    <div className="vc-notebook-editor">
      <div className="vc-notebook-cell-type vc-notebook-cell-type-prompt">Prompt cell</div>
      <label htmlFor={`step-name-${editor.id}`}>Cell name</label>
      <Input
        id={`step-name-${editor.id}`}
        value={editor.name}
        onChange={(event) => editor.setName(event.target.value)}
      />
      <label htmlFor={`step-text-${editor.id}`}>Prompt</label>
      <textarea
        id={`step-text-${editor.id}`}
        className="vc-notebook-text"
        value={text}
        onChange={(event) => {
          editor.setProperty('text', event.target.value)
          editor.notifyPropertiesChanged()
        }}
        placeholder="Write the instruction this notebook will reuse."
        rows={8}
      />
    </div>
  )
}

interface GenerationCellEditorProps {
  editor: ReturnType<typeof useStepEditor<NotebookPlanStep, NotebookPlanDefinition>>
  projectSlug: string
  callTool: UseMcpResult['callTool']
  mcpState: UseMcpResult['state']
  definition: NotebookPlanDefinition
  mediaItems: MediaItem[]
  running: boolean
  error: string | null
  onRun: NotebookStepEditorProps['onRun']
  onOpenAsset?: (assetId: string) => void
}

function GenerationCellEditor({
  editor,
  projectSlug,
  callTool,
  mcpState,
  definition,
  mediaItems,
  running,
  error,
  onRun,
  onOpenAsset,
}: GenerationCellEditorProps) {
  const category: 'image' | 'video' = editor.type === 'video' ? 'video' : 'image'
  const values = record(editor.properties.values)
  const model = typeof editor.properties.model === 'string' ? editor.properties.model : ''
  const provider = typeof editor.properties.provider === 'string' ? editor.properties.provider : ''
  const preview = useGenPreview({ category, projectSlug, callTool, model, provider })
  const selectedOption = preview.selectedOption
  const mergedValues = useMemo(
    () => ({ ...(selectedOption?.prefilled_values ?? {}), ...values }),
    [selectedOption?.prefilled_values, values],
  )
  const modeKey = selectedOption?.modes ? inferModeKey(selectedOption.modes, mergedValues) : null
  const activeMode = selectedOption?.modes && modeKey ? getMode(selectedOption.modes, modeKey) : null
  const prompt = typeof mergedValues.prompt === 'string' ? mergedValues.prompt : ''
  const promptHistory = usePromptHistory(
    callTool,
    category === 'image' ? 'image_generate' : 'video_generate',
    projectSlug,
  )
  const calls = useMemo<EstimateCall[] | null>(() => {
    if (!selectedOption) return null
    const toolName = effectiveToolName(selectedOption, modeKey)
    return [{ toolName, input: { ...mergedValues, project_slug: projectSlug } }]
  }, [selectedOption, modeKey, mergedValues, projectSlug])
  const cost = useEstimateCost(callTool, { calls })
  const step = editor.step
  const runStatus = stepRunStatus(step, mediaItems)
  const requiredMissing = useMemo(() => {
    if (!selectedOption) return ['model']
    const required = selectedOption.schema.required ?? []
    const missing = required.filter((name) => {
      if (name === 'project_slug') return false
      const value = mergedValues[name]
      return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
    })
    if (activeMode) missing.push(...modeRequiredMissing(activeMode, mergedValues))
    return Array.from(new Set(missing))
  }, [selectedOption, mergedValues, activeMode])
  const imageAssets = useMemo(
    () => mediaItems
      .filter((item) => item.type === 'image' && item.status === 'ready')
      .map((item) => ({ slug: item.slug, filePath: item.filePath, thumbnailSrc: item.thumbnailSrc ?? null })),
    [mediaItems],
  )
  // Video outputs are offered only when the selected model can take a video
  // ref; they route to video_slug (image_slugs rejects vid-* server-side).
  const supportsVideoRef = Boolean(selectedOption?.schema.properties.video_slug)
  const previousOutputs = useMemo(() => {
    const currentIndex = definition.sequence.findIndex((candidate) => candidate.id === step.id)
    return definition.sequence
      .slice(0, Math.max(0, currentIndex))
      .filter((candidate) => candidate.type !== 'prompt')
      .map((candidate) => latestAssetId(candidate))
      .filter((assetId): assetId is string => assetId !== null)
      .map((assetId) => mediaItems.find((item) => item.id === assetId))
      .filter((item): item is MediaItem => item != null && item.status === 'ready')
      .filter((item) => item.type === 'image' || supportsVideoRef)
  }, [definition.sequence, mediaItems, step.id, supportsVideoRef])

  const updateProperty = (name: string, value: string | JsonRecord | string[]) => {
    editor.setProperty(name, value)
    editor.notifyPropertiesChanged()
  }
  const updateValues = (name: string, value: unknown) => {
    // Spread the PERSISTED values, not mergedValues: baking the current
    // model's prefills into the step would carry stale defaults across a
    // model switch (e.g. a resolution the new model rejects). Prefills stay
    // live via the merge at render/run time instead.
    updateProperty('values', { ...values, [name]: value } as JsonRecord)
  }
  const copyPromptAbove = () => {
    const currentIndex = definition.sequence.findIndex((candidate) => candidate.id === step.id)
    const above = nearestPromptAbove(definition, currentIndex)
    const text = above && typeof above.properties.text === 'string' ? above.properties.text : ''
    if (text) updateValues('prompt', text)
  }
  const characterRefs = stringArray(mergedValues.character_refs)
  const characterField = selectedOption?.schema.properties.character_refs
  const fieldEntries = selectedOption
    ? Object.entries(selectedOption.schema.properties).filter(([name]) =>
      name !== 'project_slug' && name !== 'prompt' && name !== 'character_refs' && !isAssetField(name),
    )
    : []
  const stripSlots = selectedOption ? deriveStripSlots(selectedOption) : []
  const hasRefs = stripSlots.length > 0 || Boolean(characterField)

  return (
    <div className="vc-notebook-editor">
      <div className={`vc-notebook-cell-type vc-notebook-cell-type-${category}`}>{category} cell</div>
      <label htmlFor={`step-name-${editor.id}`}>Cell name</label>
      <Input
        id={`step-name-${editor.id}`}
        value={editor.name}
        onChange={(event) => editor.setName(event.target.value)}
      />
      {preview.loading && !preview.preview ? (
        <div className="vc-notebook-loading"><Loader2 /> Loading generation controls</div>
      ) : preview.error ? (
        <div className="vc-notebook-error"><AlertCircle /> {preview.error}</div>
      ) : selectedOption ? (
        <>
          <ModelProviderSelector
            selectedModelKey={preview.selectedModelKey}
            selectedProviderKey={preview.selectedProviderKey}
            modelOptions={preview.preview?.model_options ?? []}
            onChange={(nextModel, nextProvider) => {
              updateProperty('model', nextModel)
              updateProperty('provider', nextProvider)
              preview.selectModel(nextModel, nextProvider)
            }}
            disabled={running}
            variant={category}
          />
          <PromptSection
            value={prompt}
            onChange={(next) => updateValues('prompt', next)}
            disabled={running}
            required={(selectedOption.schema.required ?? []).includes('prompt')}
            category={category}
            color="plan"
            promptHistory={promptHistory}
          />
          {!prompt && nearestPromptAbove(definition, definition.sequence.findIndex((candidate) => candidate.id === step.id)) && (
            <button type="button" className="vc-notebook-copy-prompt" onClick={copyPromptAbove}>
              Use prompt from step above
            </button>
          )}
          {previousOutputs.length > 0 && (
            <div className="vc-notebook-prior-output">
              <span>Earlier outputs</span>
              <div>
                {previousOutputs.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    title={`Use ${item.id} as a reference`}
                    onClick={() => {
                      const slug = item.slug.startsWith('@') ? item.slug : `@${item.id}`
                      if (item.type === 'video') updateValues('video_slug', slug)
                      else updateValues('image_slugs', appendImageSlug(mergedValues, slug))
                    }}
                  >
                    {item.thumbnailSrc ? <img src={item.thumbnailSrc} alt={item.title} /> : <ImageIcon />}
                  </button>
                ))}
              </div>
            </div>
          )}
          {hasRefs && (
            <GenSection
              label="refs"
              color="plan"
              required={(selectedOption.schema.required ?? []).some((name) => isAssetField(name))}
            >
              <div className="space-y-2">
                {stripSlots.length > 0 && (
                  <MediaStrip
                    size="large"
                    option={selectedOption}
                    activeMode={activeMode}
                    formValues={mergedValues}
                    resolvedAssets={preview.preview?.resolved_assets ?? []}
                    droppedAssets={new Map()}
                    projectImages={imageAssets}
                    onChange={updateValues}
                    disabled={running}
                    domain="plan"
                    characters={[]}
                    onRemoveCharacter={() => {}}
                    warnings={selectedOption.validation.warnings ?? []}
                  />
                )}
                {characterField && (
                  <CharacterPickerPopover
                    selectedRefs={characterRefs}
                    onChange={(refs) => updateValues('character_refs', refs)}
                    maxItems={characterField.maxItems ?? 7}
                    disabled={running}
                    callTool={callTool}
                    mcpState={mcpState}
                    projectSlug={projectSlug}
                    domain="plan"
                  />
                )}
              </div>
            </GenSection>
          )}
          {fieldEntries.length > 0 && (
            <GenSection label="options" color="plan">
              <div className="flex flex-wrap gap-x-6 gap-y-3">
                {fieldEntries.map(([name, schema]) => (
                  <DynamicField
                    key={name}
                    name={name}
                    schema={schema}
                    value={mergedValues[name]}
                    onChange={(value) => updateValues(name, value)}
                    required={(selectedOption.schema.required ?? []).includes(name)}
                    disabled={running}
                    theme={genThemes.plan}
                    callTool={callTool}
                    mcpState={mcpState}
                    projectSlug={projectSlug}
                  />
                ))}
              </div>
            </GenSection>
          )}
          <RunStatus status={runStatus.state} />
          {error && <div className="vc-notebook-error"><AlertCircle /> {error}</div>}
          <GenerateCommandButton
            variant="plan"
            state={running ? 'submitting' : undefined}
            disabled={requiredMissing.length > 0 || running || runStatus.state === 'pending'}
            disabledReason={requiredMissing.length > 0 ? `Missing: ${requiredMissing.join(', ')}` : undefined}
            cost={cost}
            onClick={() => onRun(step, selectedOption, preview.selectedProviderKey, mergedValues)}
          />
          <OutputGallery step={step} mediaItems={mediaItems} onOpenAsset={onOpenAsset} />
        </>
      ) : null}
    </div>
  )
}

function RunStatus({ status }: { status: NotebookRunState }) {
  if (status === 'idle') return null
  if (status === 'missing') return <div className="vc-notebook-status"><Clock3 /> Syncing</div>
  if (status === 'pending') return <div className="vc-notebook-status"><Clock3 /> Running</div>
  // 'ready' is intentionally silent: the card thumbnail + output gallery already
  // signal completion, and the user asked to hide the redundant "Ready" chip.
  if (status === 'ready') return null
  return <div className="vc-notebook-status"><AlertCircle /> Failed</div>
}

function OutputGallery({
  step,
  mediaItems,
  onOpenAsset,
}: {
  step: NotebookPlanStep
  mediaItems: MediaItem[]
  onOpenAsset?: (assetId: string) => void
}) {
  const assetIds = stringArray(step.properties.asset_ids)
  if (assetIds.length === 0) return null
  return (
    <div className="vc-notebook-output-gallery">
      {assetIds.map((assetId) => {
        const item = mediaItems.find((candidate) => candidate.id === assetId)
        const failed = item?.status === 'error'
        return (
          <button
            type="button"
            key={assetId}
            className={cn(failed && 'vc-notebook-output-error')}
            title={item?.failedMessage ?? assetId}
            onClick={() => onOpenAsset?.(assetId)}
          >
            {item?.thumbnailSrc ? <img src={item.thumbnailSrc} alt={item.title} /> : step.type === 'video' ? <Video /> : <ImageIcon />}
          </button>
        )
      })}
    </div>
  )
}
