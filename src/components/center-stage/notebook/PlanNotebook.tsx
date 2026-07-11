import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  ControlButton,
  Controls,
  PanOnScrollMode,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from '@xyflow/react'
import { BookOpen, ImageIcon, Loader2, MessageSquareText, Rows3, Redo2, Undo2, Video } from 'lucide-react'
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
  nextNotebookTrackPosition,
  notebookDropTarget,
  notebookInitialViewport,
  notebookTrackLayout,
  NOTEBOOK_TRANSLATE_EXTENT,
  reorderStepsOnTracks,
  removeSteps,
  setFirstFrameSource,
  snapDefinitionToTracks,
  toolboxStepSeeds,
} from './model'
import { NotebookSidebar } from './NotebookSidebar'
import { NotebookStageBoard, type NotebookDropPreview } from './NotebookStageBoard'
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
  onAddStep: (
    type: 'prompt' | 'image' | 'video',
    position: { x: number; y: number },
    parentId: string | null,
  ) => void
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
  const canvasRef = useRef<HTMLDivElement>(null)
  const [draggedStepType, setDraggedStepType] = useState<'prompt' | 'image' | 'video' | null>(null)
  const [dropPreview, setDropPreview] = useState<NotebookDropPreview | null>(null)
  const clearDropPreview = useCallback(() => {
    setDraggedStepType(null)
    setDropPreview(null)
  }, [])
  const previewDropAt = useCallback((position: { x: number; y: number }) => {
    if (!draggedStepType) return null
    const target = notebookDropTarget(definition, draggedStepType, position, selectedStepId)
    const preview = { ...target, type: draggedStepType }
    setDropPreview(preview)
    return preview
  }, [definition, draggedStepType, selectedStepId])
  const onDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    const stepType = event.dataTransfer.getData('application/x-videocity-notebook-step')
    if (stepType === 'prompt' || stepType === 'image' || stepType === 'video') {
      const target = notebookDropTarget(definition, stepType, position, selectedStepId)
      onAddStep(stepType, target.position, target.parentId)
      clearDropPreview()
      return
    }
    const json = event.dataTransfer.getData('application/json')
    if (!json) {
      clearDropPreview()
      return
    }
    try {
      const payload = JSON.parse(json) as { id?: unknown; slug?: unknown; type?: unknown }
      if (
        (payload.type !== 'image' && payload.type !== 'video' && payload.type !== 'audio')
        || (typeof payload.id !== 'string' && typeof payload.slug !== 'string')
      ) {
        clearDropPreview()
        return
      }
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
      clearDropPreview()
    } catch {
      clearDropPreview()
      return
    }
  }, [clearDropPreview, definition, flow.nodes, onAddAsset, onAddStep, reactFlow, selectedStepId])
  const onInit = useCallback((instance: ReactFlowInstance<NotebookFlowNode, Edge>) => {
    const canvasWidth = canvasRef.current?.clientWidth ?? 720
    void instance.setViewport(notebookInitialViewport(definition, canvasWidth))
  }, [definition])
  const addFromToolbox = useCallback((type: 'prompt' | 'image' | 'video') => {
    const layout = notebookTrackLayout(definition)
    const selectedDepth = selectedStepId ? layout.depths.get(selectedStepId) : undefined
    const canUseSelection = type !== 'prompt' && selectedStepId && selectedDepth !== undefined
    if (canUseSelection) {
      const selected = definition.sequence.find((step) => step.id === selectedStepId)
      const selectedPosition = selected ? layout.positions.get(selected.id) : null
      if (selected && selectedPosition) {
        const pointer = {
          x: selectedPosition.x,
          y: nextNotebookTrackPosition(definition, type, selectedDepth + 1).y,
        }
        const target = notebookDropTarget(definition, type, pointer, selected.id)
        onAddStep(type, target.position, target.parentId)
        return
      }
    }
    onAddStep(type, nextNotebookTrackPosition(definition, type), null)
  }, [definition, onAddStep, selectedStepId])
  const handleAutoLayout = useCallback(() => {
    onAutoLayout()
    const canvasWidth = canvasRef.current?.clientWidth ?? 720
    window.setTimeout(() => {
      void reactFlow.setViewport(notebookInitialViewport(definition, canvasWidth), { duration: 280 })
    }, 60)
  }, [definition, onAutoLayout, reactFlow])
  const canvasNodes = useMemo<NotebookFlowNode[]>(() => flow.nodes.map((node) => (
    node.id === dropPreview?.parentId ? { ...node, className: 'vc-notebook-drop-parent' } : node
  )), [dropPreview?.parentId, flow.nodes])

  return (
    <div
      ref={canvasRef}
      className={`vc-notebook-canvas ${selectedStepId ? 'vc-notebook-has-route' : ''} ${dropPreview ? 'vc-notebook-is-deploying' : ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        if (draggedStepType) {
          previewDropAt(reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY }))
        }
      }}
      onDrop={onDrop}
    >
      <ReactFlow
        nodes={canvasNodes}
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
        connectionLineType={ConnectionLineType.SmoothStep}
        minZoom={0.25}
        maxZoom={1.5}
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
        panOnScroll
        panOnScrollMode={PanOnScrollMode.Vertical}
        panOnScrollSpeed={0.9}
        zoomOnScroll={false}
        fitView={false}
        translateExtent={NOTEBOOK_TRANSLATE_EXTENT}
      >
        <NotebookStageBoard definition={definition} selectedStepId={selectedStepId} preview={dropPreview} />
        <Background variant={BackgroundVariant.Lines} gap={32} size={0.6} />
        <Controls showInteractive={false}>
          <ControlButton onClick={onUndo} disabled={!canUndo} title="Undo"><Undo2 /></ControlButton>
          <ControlButton onClick={onRedo} disabled={!canRedo} title="Redo"><Redo2 /></ControlButton>
          <ControlButton onClick={handleAutoLayout} title="Auto-arrange"><Rows3 /></ControlButton>
        </Controls>
        <Controls
          className="vc-notebook-add-controls"
          position="top-left"
          showInteractive={false}
          showZoom={false}
          showFitView={false}
        >
          <ControlButton
            className="vc-notebook-add-cell"
            title="Add prompt cell"
            draggable
            onClick={() => addFromToolbox('prompt')}
            onDragStart={(event) => {
              event.dataTransfer.setData('application/x-videocity-notebook-step', 'prompt')
              event.dataTransfer.effectAllowed = 'copy'
              setDraggedStepType('prompt')
            }}
            onDragEnd={clearDropPreview}
          >
            <MessageSquareText />
          </ControlButton>
          <ControlButton
            className="vc-notebook-add-cell"
            title="Add image cell"
            draggable
            onClick={() => addFromToolbox('image')}
            onDragStart={(event) => {
              event.dataTransfer.setData('application/x-videocity-notebook-step', 'image')
              event.dataTransfer.effectAllowed = 'copy'
              setDraggedStepType('image')
            }}
            onDragEnd={clearDropPreview}
          >
            <ImageIcon />
          </ControlButton>
          <ControlButton
            className="vc-notebook-add-cell"
            title="Add video cell"
            draggable
            onClick={() => addFromToolbox('video')}
            onDragStart={(event) => {
              event.dataTransfer.setData('application/x-videocity-notebook-step', 'video')
              event.dataTransfer.effectAllowed = 'copy'
              setDraggedStepType('video')
            }}
            onDragEnd={clearDropPreview}
          >
            <Video />
          </ControlButton>
        </Controls>
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
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])
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
    selectedStepId,
  })
  const commit = useCallback((next: NotebookPlanDefinition, coalesceKey?: string) => {
    history.commit(next, coalesceKey)
  }, [history])
  const getDefinition = useCallback(() => definition, [definition])
  const handleConnect = useCallback((connection: Connection) => {
    const current = getDefinition()
    if (!current || !connection.source || !connection.target) return
    commit(snapDefinitionToTracks(connectSteps(current, connection.source, connection.target)))
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
    commit(snapDefinitionToTracks(next))
    if (selectedStepId && deleted.has(selectedStepId)) setSelectedStepId(null)
  }, [commit, getDefinition, selectedStepId])
  const handleMove = useCallback((nodes: Node[]) => {
    const current = getDefinition()
    if (!current) return
    commit(reorderStepsOnTracks(current, nodes.map((node) => ({ id: node.id, position: node.position }))))
  }, [commit, getDefinition])
  const handleAutoLayout = useCallback(() => {
    const current = getDefinition()
    if (!current) return
    commit(autoLayout(current))
  }, [commit, getDefinition])
  const handleAddStep = useCallback((
    type: 'prompt' | 'image' | 'video',
    position: { x: number; y: number },
    parentId: string | null,
  ) => {
    const current = getDefinition()
    const seed = toolboxStepSeeds.find((candidate) => candidate.type === type)
    if (!current || !seed) return
    const added = addStep(current, seed, position)
    const stepId = added.sequence.at(-1)?.id
    const connected = parentId && stepId ? connectSteps(added, parentId, stepId) : added
    commit(snapDefinitionToTracks(connected))
  }, [commit, getDefinition])
  const handleAddAsset = useCallback((slug: string, _position: { x: number; y: number }, targetId: string | null) => {
    const current = getDefinition()
    if (!current) return
    const added = addAssetStep(current, slug, nextNotebookTrackPosition(current, 'asset'))
    const next = targetId ? connectSteps(added.definition, added.stepId, targetId) : added.definition
    commit(snapDefinitionToTracks(next))
  }, [commit, getDefinition])
  const updateDefinition = useCallback((next: NotebookPlanDefinition, coalesceKey?: string) => {
    commit(next, coalesceKey)
  }, [commit])

  return (
    <section className="vc-notebook h-full min-h-0 flex flex-col overflow-hidden border border-zinc-600/50">
      <header className="flex items-center justify-between px-3 py-3 shrink-0 border-b border-zinc-800/60 bg-black/60">
        <span className="flex items-center gap-1.5 px-2 py-0.5 text-xs font-mono font-bold text-emerald-300/70">
          <BookOpen className="w-3.5 h-3.5" />
          <span>/notebook</span>
        </span>
        <CloseButton onClick={onClose} tone="emerald" title="Close (ESC)" />
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
                if (current) commit(snapDefinitionToTracks(disconnectSteps(current, sourceId, targetId)))
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
