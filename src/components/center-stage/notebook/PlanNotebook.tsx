import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, Loader2 } from 'lucide-react'
import {
  SequentialWorkflowDesigner,
  useSequentialWorkflowDesignerController,
} from 'sequential-workflow-designer-react'
import type { ReactToolboxConfiguration } from 'sequential-workflow-designer-react'
import type { StepsConfiguration, ValidatorConfiguration } from 'sequential-workflow-designer'
import type { UseMcpResult } from 'use-mcp/react'
import { CloseButton } from '@/components/ui/CloseButton'
import type { MediaItem } from '@/components/sidebar/types'
import type { OnGenerationLifecycle } from '@/lib/generation-lifecycle'
import type { ModelOption } from '@/components/gen/types'
import { createEditorBridge } from './editorBridge'
import { notebookDesignerExtensions } from './designerExtensions'
import { notebookStepIcon } from './icons'
import { useCanvasCostEstimates } from './useCanvasCostEstimates'
import { toolboxStepSeeds } from './model'
import { NotebookRootEditor } from './NotebookRootEditor'
import { NotebookStepEditor } from './NotebookStepEditor'
import type { NotebookPlanDefinition, NotebookPlanStep } from './types'
import { useCanvasStepDecorations } from './useCanvasStepDecorations'
import { useNotebookPlan } from './useNotebookPlan'
import { useNotebookRun } from './useNotebookRun'
import 'sequential-workflow-designer/css/designer.css'
import 'sequential-workflow-designer/css/designer-dark.css'
import './notebook.css'

interface PlanNotebookProps {
  projectSlug: string
  callTool: UseMcpResult['callTool']
  mcpState: UseMcpResult['state']
  mediaItems: MediaItem[]
  onClose: () => void
  onOpenAsset?: (assetId: string) => void
  onGenerationLifecycle?: OnGenerationLifecycle
}

function stepHasPrompt(step: NotebookPlanStep): boolean {
  if (step.type === 'prompt') return typeof step.properties.text === 'string' && step.properties.text.trim() !== ''
  const values = step.properties.values
  return typeof values === 'object'
    && values !== null
    && !Array.isArray(values)
    && typeof (values as Record<string, unknown>).prompt === 'string'
    && ((values as Record<string, unknown>).prompt as string).trim() !== ''
}

export function PlanNotebook({
  projectSlug,
  callTool,
  mcpState,
  mediaItems,
  onClose,
  onOpenAsset,
  onGenerationLifecycle,
}: PlanNotebookProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)
  const [isEditorCollapsed, setIsEditorCollapsed] = useState(false)
  const controller = useSequentialWorkflowDesignerController()
  const plan = useNotebookPlan({ projectSlug, callTool, mcpState })
  const definition = plan.wrapped?.value ?? null
  const toolboxConfiguration = useMemo<ReactToolboxConfiguration>(() => ({
    groups: [{ name: 'Cells', steps: toolboxStepSeeds }],
  }), [])
  const stepsConfiguration = useMemo<StepsConfiguration>(() => ({
    iconUrlProvider: (_, type) => notebookStepIcon(type),
  }), [])
  const validatorConfiguration = useMemo<ValidatorConfiguration>(() => ({
    step: (step) => stepHasPrompt(step as NotebookPlanStep),
  }), [])
  const replaceDefinition = useCallback(async (next: NotebookPlanDefinition, stepId: string) => {
    await controller.replaceDefinition(next)
    setSelectedStepId(stepId)
  }, [controller])
  const run = useNotebookRun({
    projectSlug,
    callTool,
    definition,
    replaceDefinition,
    onGenerationLifecycle,
  })

  // The SWD editor panel lives in a separate React root: prop updates never
  // reach a mounted editor, so volatile data flows through the bridge and the
  // editor's callbacks/props must be identity-stable ref-backed wrappers.
  const [bridge] = useState(() => createEditorBridge({
    mediaItems,
    runningStepIds: new Set<string>(),
    errors: new Map<string, string>(),
    mcpState,
  }))
  useEffect(() => {
    bridge.publish({ mediaItems, runningStepIds: run.runningStepIds, errors: run.errors, mcpState })
  })
  const callToolRef = useRef(callTool)
  const runRef = useRef(run.run)
  const openAssetRef = useRef(onOpenAsset)
  useEffect(() => {
    callToolRef.current = callTool
    runRef.current = run.run
    openAssetRef.current = onOpenAsset
  }, [callTool, run.run, onOpenAsset])
  const stableCallTool = useCallback<UseMcpResult['callTool']>(
    (...args) => callToolRef.current(...args),
    [],
  )
  const handleRunStep = useCallback((
    step: NotebookPlanStep,
    option: ModelOption,
    provider: string,
    values: Record<string, unknown>,
  ) => {
    void runRef.current(step, option, provider, values)
  }, [])
  const handleOpenAsset = useCallback((assetId: string) => {
    openAssetRef.current?.(assetId)
  }, [])

  const stepCosts = useCanvasCostEstimates({
    projectSlug,
    callTool: stableCallTool,
    definition,
    enabled: mcpState === 'ready',
  })
  useCanvasStepDecorations(rootRef, definition, mediaItems, stepCosts)

  const title = typeof definition?.properties.title === 'string' && definition.properties.title.trim()
    ? definition.properties.title
    : 'Plan notebook'

  return (
    <section ref={rootRef} className="vc-notebook h-full min-h-0 flex flex-col overflow-hidden border border-zinc-600/50">
      <header className="vc-notebook-header">
        <div>
          <span><BookOpen /> Plan</span>
          <h1>{title}</h1>
        </div>
        <div>
          <span className={`vc-notebook-save vc-notebook-save-${plan.saveState}`}>
            {plan.saveState === 'saving' || plan.saveState === 'loading' ? <Loader2 /> : null}
            {plan.saveState}
          </span>
          <CloseButton onClick={onClose} tone="emerald" />
        </div>
      </header>
      {plan.error && <div className="vc-notebook-load-error">{plan.error}</div>}
      {plan.legacy && (
        <div className="vc-notebook-legacy-note">
          This project has a plan from the old formula system. It opens here as an empty
          notebook; saving any change will replace the old plan file.
        </div>
      )}
      {plan.wrapped ? (
        <SequentialWorkflowDesigner
          definition={plan.wrapped}
          onDefinitionChange={plan.onDefinitionChange}
          selectedStepId={selectedStepId}
          onSelectedStepIdChanged={setSelectedStepId}
          stepsConfiguration={stepsConfiguration}
          validatorConfiguration={validatorConfiguration}
          toolboxConfiguration={toolboxConfiguration}
          extensions={notebookDesignerExtensions}
          controlBar={true}
          contextMenu={true}
          keyboard={true}
          undoStackSize={20}
          theme="dark"
          isEditorCollapsed={isEditorCollapsed}
          onIsEditorCollapsedChanged={setIsEditorCollapsed}
          rootEditor={<NotebookRootEditor />}
          stepEditor={
            <NotebookStepEditor
              projectSlug={projectSlug}
              callTool={stableCallTool}
              bridge={bridge}
              onRun={handleRunStep}
              onOpenAsset={handleOpenAsset}
            />
          }
          controller={controller}
        />
      ) : plan.saveState === 'loading' ? (
        <div className="vc-notebook-loading"><Loader2 /> Loading Plan notebook</div>
      ) : null}
    </section>
  )
}
