import { useCallback, useMemo, useRef, useState } from 'react'
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
import { notebookStepIcon } from './icons'
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
  const plan = useNotebookPlan({ projectSlug, callTool })
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

  useCanvasStepDecorations(rootRef, definition, mediaItems)

  const title = typeof definition?.properties.title === 'string' && definition.properties.title.trim()
    ? definition.properties.title
    : 'Plan notebook'

  return (
    <section ref={rootRef} className="vc-notebook h-full min-h-0 flex flex-col">
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
      {plan.wrapped ? (
        <SequentialWorkflowDesigner
          definition={plan.wrapped}
          onDefinitionChange={plan.onDefinitionChange}
          selectedStepId={selectedStepId}
          onSelectedStepIdChanged={setSelectedStepId}
          stepsConfiguration={stepsConfiguration}
          validatorConfiguration={validatorConfiguration}
          toolboxConfiguration={toolboxConfiguration}
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
              callTool={callTool}
              mcpState={mcpState}
              definition={plan.wrapped.value}
              mediaItems={mediaItems}
              running={selectedStepId != null && run.runningStepIds.has(selectedStepId)}
              error={selectedStepId == null ? null : run.errors.get(selectedStepId) ?? null}
              onRun={(step, option, provider, values) => {
                void run.run(step, option, provider, values)
              }}
              onOpenAsset={onOpenAsset}
            />
          }
          controller={controller}
        />
      ) : (
        <div className="vc-notebook-loading"><Loader2 /> Loading Plan notebook</div>
      )}
    </section>
  )
}
