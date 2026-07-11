import { useCallback, useEffect, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from '@xyflow/react'
import { BookOpen, Loader2, Network, Redo2, Undo2 } from 'lucide-react'
import type { UseMcpResult } from 'use-mcp/react'
import { CloseButton } from '@/components/ui/CloseButton'
import type { MediaItem } from '@/components/sidebar/types'
import type { OnGenerationLifecycle } from '@/lib/generation-lifecycle'
import {
  addAssetStep,
  addStep,
  autoLayout,
  canConnect,
  connectSteps,
  disconnectSteps,
  graphLayoutBounds,
  moveSteps,
  removeSteps,
  setFirstFrameSource,
  stepPosition,
  toolboxStepSeeds,
} from './model'
import { NotebookSidebar } from './NotebookSidebar'
import { NotebookToolbox } from './NotebookToolbox'
import { NODE_TYPES } from './nodes/nodeTypes'
import type { NotebookFlowNode } from './nodes/nodeTypes'
import type { NotebookPlanDefinition } from './types'
import { useCanvasCostEstimates } from './useCanvasCostEstimates'
import { useDefinitionHistory } from './useDefinitionHistory'
import { useNotebookFlow } from './useNotebookFlow'
import { useNotebookPlan } from './useNotebookPlan'
import { useNotebookRun } from './useNotebookRun'
import '@xyflow/react/dist/style.css'
import './notebook.css'

interface NotebookProps {
  projectSlug: string
  callTool: UseMcpResult['callTool']
  mcpState: UseMcpResult['state']
  mediaItems: MediaItem[]
  onClose: () => void
  onOpenAsset?: (assetId: string) => void
  onGenerationLifecycle?: OnGenerationLifecycle
}

interface NotebookCanvasProps {
  definition: NotebookPlanDefinition
  flow: ReturnType<typeof useNotebookFlow>
  selectedStepId: string | null
  onSelectedStepIdChanged: (id: string | null) => void
  onConnect: (connection: Connection) => void
  onDelete: (payload: { nodes: Node[]; edges: Edge[] }) => void
  onMove: (nodes: Node[]) => void
  onAddStep: (type: 'prompt' | 'image' | 'video', position: { x: number; y: number }) => void
  onAddAsset: (slug: string, position: { x: number; y: number }, targetId: string | null) => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onAutoLayout: () => void
}

function NotebookCanvas({
  definition,
  flow,
  selectedStepId,
  onSelectedStepIdChanged,
  onConnect,
  onDelete,
  onMove,
  onAddStep,
  onAddAsset,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onAutoLayout,
}: NotebookCanvasProps) {
  const reactFlow = useReactFlow()
  const onDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    const stepType = event.dataTransfer.getData('application/x-videocity-notebook-step')
    if (stepType === 'prompt' || stepType === 'image' || stepType === 'video') {
      onAddStep(stepType, position)
      return
    }
    const json = event.dataTransfer.getData('application/json')
    if (!json) return
    try {
      const payload = JSON.parse(json) as { id?: unknown; slug?: unknown; type?: unknown }
      if (
        (payload.type !== 'image' && payload.type !== 'video' && payload.type !== 'audio')
        || (typeof payload.id !== 'string' && typeof payload.slug !== 'string')
      ) return
      const slug = typeof payload.slug === 'string' ? payload.slug : payload.id as string
      const target = flow.nodes.find((node) => {
        const width = node.width ?? 0
        const height = node.height ?? 0
        return node.type !== 'prompt' && node.type !== 'asset'
          && position.x >= node.position.x
          && position.x <= node.position.x + width
          && position.y >= node.position.y
          && position.y <= node.position.y + height
      })
      onAddAsset(slug, position, target?.id ?? null)
    } catch {
      return
    }
  }, [flow.nodes, onAddAsset, onAddStep, reactFlow])
  const onInit = useCallback((instance: ReactFlowInstance<NotebookFlowNode, Edge>) => {
    const bounds = graphLayoutBounds(definition)
    const width = Math.max(1, bounds.maxX - bounds.minX)
    const zoom = Math.min(1, Math.max(0.5, 720 / width))
    instance.setViewport({ x: 360 - (bounds.minX + width / 2) * zoom, y: 40 - bounds.minY * zoom, zoom })
  }, [definition])
  const addBelow = useCallback((type: 'prompt' | 'image' | 'video') => {
    const bounds = graphLayoutBounds(definition)
    onAddStep(type, { x: 320, y: bounds.maxY + 48 })
  }, [definition, onAddStep])
  const handleAutoLayout = useCallback(() => {
    onAutoLayout()
    window.setTimeout(() => {
      reactFlow.fitView({ padding: 0.18, duration: 280, maxZoom: 1 })
    }, 60)
  }, [onAutoLayout, reactFlow])

  return (
    <div
      className="vc-notebook-canvas"
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={onDrop}
    >
      <ReactFlow
        nodes={flow.nodes}
        edges={flow.edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={flow.onNodesChange}
        onEdgesChange={flow.onEdgesChange}
        onConnect={onConnect}
        isValidConnection={(connection) => Boolean(
          connection.source && connection.target && canConnect(definition, connection.source, connection.target),
        )}
        onDelete={onDelete}
        onNodeDragStop={(_, __, nodes) => onMove(nodes)}
        onSelectionChange={({ nodes }) => onSelectedStepIdChanged(nodes.length === 1 ? nodes[0].id : null)}
        onInit={onInit}
        deleteKeyCode={['Backspace', 'Delete']}
        connectionRadius={28}
        minZoom={0.25}
        maxZoom={1.5}
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
        fitView={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={40} size={1} />
        <Controls showInteractive={false}>
          <ControlButton onClick={onUndo} disabled={!canUndo} title="Undo"><Undo2 /></ControlButton>
          <ControlButton onClick={onRedo} disabled={!canRedo} title="Redo"><Redo2 /></ControlButton>
          <ControlButton onClick={handleAutoLayout} title="Auto organize"><Network /></ControlButton>
        </Controls>
        <NotebookToolbox onAdd={addBelow} />
      </ReactFlow>
      <span className="sr-only">{selectedStepId}</span>
    </div>
  )
}

export function Notebook({
  projectSlug,
  callTool,
  mcpState,
  mediaItems,
  onClose,
  onOpenAsset,
  onGenerationLifecycle,
}: NotebookProps) {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)
  const plan = useNotebookPlan({ projectSlug, callTool, mcpState })
  const history = useDefinitionHistory(plan.setDefinition)
  const resetHistory = history.reset
  useEffect(() => {
    resetHistory(plan.loadedDefinition)
  }, [resetHistory, plan.loadedDefinition, plan.loadVersion])
  const definition = plan.definition
  const run = useNotebookRun({
    projectSlug,
    callTool,
    definition,
    replaceDefinition: async (next, stepId) => {
      history.commit(next)
      setSelectedStepId(stepId)
    },
    onGenerationLifecycle,
  })
  const stepCosts = useCanvasCostEstimates({
    projectSlug,
    callTool,
    definition,
    enabled: mcpState === 'ready',
  })
  const flow = useNotebookFlow({
    definition,
    mediaItems,
    stepCosts,
    runningStepIds: run.runningStepIds,
    errors: run.errors,
  })
  const commit = useCallback((next: NotebookPlanDefinition, coalesceKey?: string) => {
    history.commit(next, coalesceKey)
  }, [history])
  const getDefinition = useCallback(() => definition, [definition])
  const handleConnect = useCallback((connection: Connection) => {
    const current = getDefinition()
    if (!current || !connection.source || !connection.target) return
    commit(connectSteps(current, connection.source, connection.target))
  }, [commit, getDefinition])
  const handleDelete = useCallback(({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) => {
    const current = getDefinition()
    if (!current) return
    const deleted = new Set(nodes.map((node) => node.id))
    let next = removeSteps(current, [...deleted])
    for (const edge of edges) {
      if (!deleted.has(edge.source) && !deleted.has(edge.target)) {
        next = disconnectSteps(next, edge.source, edge.target)
      }
    }
    commit(next)
    if (selectedStepId && deleted.has(selectedStepId)) setSelectedStepId(null)
  }, [commit, getDefinition, selectedStepId])
  const handleMove = useCallback((nodes: Node[]) => {
    const current = getDefinition()
    if (!current) return
    commit(moveSteps(current, nodes.map((node) => ({ id: node.id, position: node.position }))))
  }, [commit, getDefinition])
  const handleAutoLayout = useCallback(() => {
    const current = getDefinition()
    if (!current) return
    commit(autoLayout(current))
  }, [commit, getDefinition])
  const handleAddStep = useCallback((type: 'prompt' | 'image' | 'video', position: { x: number; y: number }) => {
    const current = getDefinition()
    const seed = toolboxStepSeeds.find((candidate) => candidate.type === type)
    if (!current || !seed) return
    commit(addStep(current, seed, position))
  }, [commit, getDefinition])
  const handleAddAsset = useCallback((slug: string, position: { x: number; y: number }, targetId: string | null) => {
    const current = getDefinition()
    if (!current) return
    const target = targetId ? current.sequence.find((step) => step.id === targetId) : null
    const targetPosition = target ? stepPosition(target) : null
    const added = addAssetStep(current, slug, targetPosition
      ? { x: targetPosition.x - 248, y: targetPosition.y }
      : position)
    const next = targetId ? connectSteps(added.definition, added.stepId, targetId) : added.definition
    commit(next)
  }, [commit, getDefinition])
  const updateDefinition = useCallback((next: NotebookPlanDefinition, coalesceKey?: string) => {
    commit(next, coalesceKey)
  }, [commit])
  const title = typeof definition?.properties.title === 'string' && definition.properties.title.trim()
    ? definition.properties.title
    : 'Notebook'

  return (
    <section className="vc-notebook h-full min-h-0 flex flex-col overflow-hidden border border-zinc-600/50">
      <header className="vc-notebook-header">
        <div>
          <span><BookOpen /> Notebook</span>
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
      {plan.error ? <div className="vc-notebook-load-error">{plan.error}</div> : null}
      {plan.legacy ? <div className="vc-notebook-legacy-note">This project has a notebook from the old formula system. Saving changes replaces that old plan file.</div> : null}
      {definition ? (
        <div className="vc-notebook-body">
          <ReactFlowProvider>
            <NotebookCanvas
              definition={definition}
              flow={flow}
              selectedStepId={selectedStepId}
              onSelectedStepIdChanged={setSelectedStepId}
              onConnect={handleConnect}
              onDelete={handleDelete}
              onMove={handleMove}
              onAddStep={handleAddStep}
              onAddAsset={handleAddAsset}
              canUndo={history.canUndo}
              canRedo={history.canRedo}
              onUndo={history.undo}
              onRedo={history.redo}
              onAutoLayout={handleAutoLayout}
            />
            <NotebookSidebar
              projectSlug={projectSlug}
              callTool={callTool}
              mcpState={mcpState}
              definition={definition}
              selectedStepId={selectedStepId}
              mediaItems={mediaItems}
              stepCosts={stepCosts}
              runningStepIds={run.runningStepIds}
              errors={run.errors}
              updateDefinition={updateDefinition}
              onDisconnect={(sourceId, targetId) => {
                const current = getDefinition()
                if (current) commit(disconnectSteps(current, sourceId, targetId))
              }}
              onSetFirstFrame={(targetId, sourceId) => {
                const current = getDefinition()
                if (current) commit(setFirstFrameSource(current, targetId, sourceId))
              }}
              onRun={run.run}
              onOpenAsset={onOpenAsset}
            />
          </ReactFlowProvider>
        </div>
      ) : plan.saveState === 'loading' ? <div className="vc-notebook-loading"><Loader2 /> Loading notebook</div> : null}
    </section>
  )
}
