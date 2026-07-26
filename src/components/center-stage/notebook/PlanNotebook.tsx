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
  notebookAssetDropTarget,
  notebookDropTarget,
  notebookInitialViewport,
  notebookStageCount,
  notebookTrackLayout,
  NOTEBOOK_TRANSLATE_EXTENT,
  stageBoardMetrics,
  reorderStepsOnTracks,
  removeSteps,
  promoteRunAsset,
  setInputRoute,
  snapDefinitionToTracks,
  toolboxStepSeed,
} from './model'
import { NotebookSidebar } from './NotebookSidebar'
import { NotebookStageBoard, type NotebookDropPreview } from './NotebookStageBoard'
import { NODE_TYPES } from './nodes/nodeTypes'
import type { NotebookFlowNode } from './nodes/nodeTypes'
import { TrunkEdge } from './TrunkEdge.js'
import { TrunkHoverContext } from './TrunkHoverContext.js'

const EDGE_TYPES = { trunk: TrunkEdge }
import type { NotebookPlanDefinition, NotebookToolboxKind } from './types'
import { useCanvasCostEstimates } from './useCanvasCostEstimates'
import { useDefinitionHistory } from './useDefinitionHistory'
import { useNotebookFlow } from './useNotebookFlow'
import { useNotebookPlan } from './useNotebookPlan'
import { useNotebookRun } from './useNotebookRun'
import '@xyflow/react/dist/style.css'
import './notebook.css'

interface NotebookProps {
  notebookId: string
  bookId: string
  callTool: UseMcpResult['callTool']
  mcpState: UseMcpResult['state']
  mediaItems: MediaItem[]
  onClose: () => void
  onOpenAsset?: (assetId: string) => void
  onGenerationLifecycle?: OnGenerationLifecycle
  onManageCharacters?: () => void
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
    kind: NotebookToolboxKind,
    position: { x: number; y: number },
    parentId: string | null,
    depth?: number,
  ) => void
  onAddAsset: (slug: string, position: { x: number; y: number }, targetId: string | null, depth?: number) => void
  onAddStage: () => void
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
  onAddStage,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onAutoLayout,
}: NotebookCanvasProps) {
  const reactFlow = useReactFlow()
  const canvasRef = useRef<HTMLDivElement>(null)
  const [draggedStepType, setDraggedStepType] = useState<NotebookToolboxKind | null>(null)
  const [dropPreview, setDropPreview] = useState<NotebookDropPreview | null>(null)
  const [hoveredGroupId, setHoveredGroupId] = useState<string | null>(null)
  const clearDropPreview = useCallback(() => {
    setDraggedStepType(null)
    setDropPreview(null)
  }, [])
  const previewDropAt = useCallback((position: { x: number; y: number }) => {
    if (!draggedStepType) return null
    const target = notebookDropTarget(definition, draggedStepType, position, selectedStepId)
    const seed = toolboxStepSeed(draggedStepType)
    const preview = {
      ...target,
      type: seed.type,
      assetKind: draggedStepType === 'image' || draggedStepType === 'video' ? draggedStepType : null,
    }
    setDropPreview(preview)
    return preview
  }, [definition, draggedStepType, selectedStepId])
  const onDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    const stepType = event.dataTransfer.getData('application/x-videocity-notebook-step')
    if (stepType === 'note' || stepType === 'image' || stepType === 'video') {
      const target = notebookDropTarget(definition, stepType, position, selectedStepId)
      onAddStep(stepType, target.position, target.parentId, target.depth)
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
      const target = notebookAssetDropTarget(definition, position)
      onAddAsset(slug, target.position, target.connectTargetId, target.depth)
      clearDropPreview()
    } catch {
      clearDropPreview()
      return
    }
  }, [clearDropPreview, definition, onAddAsset, onAddStep, reactFlow, selectedStepId])
  const onInit = useCallback((instance: ReactFlowInstance<NotebookFlowNode, Edge>) => {
    const canvasWidth = canvasRef.current?.clientWidth ?? 720
    void instance.setViewport(notebookInitialViewport(definition, canvasWidth))
  }, [definition])
  const addFromToolbox = useCallback((type: NotebookToolboxKind) => {
    const layout = notebookTrackLayout(definition)
    const selectedDepth = selectedStepId ? layout.depths.get(selectedStepId) : undefined
    const canUseSelection = type !== 'note' && selectedStepId && selectedDepth !== undefined
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
      className={`vc-notebook-canvas ${selectedStepId ? 'vc-notebook-has-route' : ''} ${dropPreview ? 'vc-notebook-is-deploying' : ''} ${hoveredGroupId ? 'vc-notebook-trunk-hovering' : ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        let isAsset = false
        let assetKind: NotebookDropPreview['assetKind'] = null
        for (const type of event.dataTransfer.types) {
          if (type.startsWith('application/x-videocity-asset-')) {
            isAsset = true
            assetKind = type.replace('application/x-videocity-asset-', '') as NotebookDropPreview['assetKind']
            break
          }
        }
        const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
        if (draggedStepType) {
          previewDropAt(position)
        } else if (isAsset) {
          const target = notebookAssetDropTarget(definition, position)
          setDropPreview({ ...target, parentId: target.connectTargetId, type: 'source', assetKind })
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node)) {
          clearDropPreview()
        }
      }}
      onDrop={onDrop}
    >
      <TrunkHoverContext.Provider value={{ hoveredGroupId, setHoveredGroupId }}>
      <ReactFlow
        nodes={canvasNodes}
        edges={flow.edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={flow.onNodesChange}
        onEdgesChange={flow.onEdgesChange}
        onConnect={onConnect}
        isValidConnection={(connection) => Boolean(
          connection.source && connection.target && canConnect(definition, connection.source, connection.target),
        )}
        onDelete={(params) => {
          if (params.edges.some((e) => e.data?.groupId === hoveredGroupId)) setHoveredGroupId(null)
          onDelete(params)
        }}
        onEdgeMouseEnter={(_, edge) => setHoveredGroupId(edge.data?.groupId as string)}
        onEdgeMouseLeave={() => setHoveredGroupId(null)}
        onNodeDragStop={(_, __, nodes) => onMove(nodes)}
        onSelectionChange={({ nodes }) => onSelectedStepIdChanged(nodes.length === 1 ? nodes[0].id : null)}
        onInit={onInit}
        deleteKeyCode={['Backspace', 'Delete']}
        connectionRadius={28}
        connectionLineType={ConnectionLineType.Step}
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
        <NotebookStageBoard definition={definition} selectedStepId={selectedStepId} preview={dropPreview} onAddStage={onAddStage} />
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
            title="Add note cell"
            draggable
            onClick={() => addFromToolbox('note')}
            onDragStart={(event) => {
              event.dataTransfer.setData('application/x-videocity-notebook-step', 'note')
              event.dataTransfer.effectAllowed = 'copy'
              setDraggedStepType('note')
            }}
            onDragEnd={clearDropPreview}
          >
            <MessageSquareText />
          </ControlButton>
          <ControlButton
            className="vc-notebook-add-cell"
            title="Add image asset"
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
            title="Add video asset"
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
      </TrunkHoverContext.Provider>
      <span className="sr-only">{selectedStepId}</span>
    </div>
  )
}

export function Notebook({
  notebookId,
  bookId,
  callTool,
  mcpState,
  mediaItems,
  onClose,
  onOpenAsset,
  onGenerationLifecycle,
  onManageCharacters,
}: NotebookProps) {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)
  const plan = useNotebookPlan({ notebookId, bookId, callTool, mcpState })
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
    bookId,
    callTool,
    definition,
    replaceDefinition: async (next, stepId) => {
      history.commit(next)
      setSelectedStepId(stepId)
    },
    onGenerationLifecycle,
  })
  const stepCosts = useCanvasCostEstimates({
    bookId,
    callTool,
    definition,
    enabled: mcpState === 'ready',
  })
  const commit = useCallback((next: NotebookPlanDefinition, coalesceKey?: string) => {
    history.commit(next, coalesceKey)
  }, [history])
  const getDefinition = useCallback(() => definition, [definition])
  const handlePromoteAsset = useCallback((stepId: string, assetId: string) => {
    const current = getDefinition()
    if (!current) return
    commit(promoteRunAsset(current, stepId, assetId))
  }, [commit, getDefinition])
  const flow = useNotebookFlow({
    definition,
    mediaItems,
    stepCosts,
    runningStepIds: run.runningStepIds,
    errors: run.errors,
    selectedStepId,
    onPromoteAsset: handlePromoteAsset,
  })
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
    type: NotebookToolboxKind,
    position: { x: number; y: number },
    parentId: string | null,
    depth?: number,
  ) => {
    const current = getDefinition()
    const seed = toolboxStepSeed(type)
    if (!current) return
    const added = addStep(current, seed, position, parentId === null ? depth : undefined)
    const stepId = added.sequence.at(-1)?.id
    const connected = parentId && stepId ? connectSteps(added, parentId, stepId) : added
    commit(snapDefinitionToTracks(connected))
  }, [commit, getDefinition])
  const handleAddAsset = useCallback((slug: string, position: { x: number; y: number }, targetId: string | null, depth?: number) => {
    const current = getDefinition()
    if (!current) return
    const added = addAssetStep(current, slug, position, depth)
    const next = targetId ? connectSteps(added.definition, added.stepId, targetId) : added.definition
    commit(snapDefinitionToTracks(next))
  }, [commit, getDefinition])
  const handleAddStage = useCallback(() => {
    const current = getDefinition()
    if (!current) return
    const layout = notebookTrackLayout(current)
    const stageCount = notebookStageCount(current)
    const metrics = stageBoardMetrics(layout, null, stageCount)
    commit({
      ...current,
      properties: { ...current.properties, stage_count: metrics.rowCount + 1 },
    })
  }, [commit, getDefinition])
  const updateDefinition = useCallback((next: NotebookPlanDefinition, coalesceKey?: string) => {
    commit(next, coalesceKey)
  }, [commit])

  return (
    <section className="vc-notebook h-full min-h-0 flex flex-col overflow-hidden border border-zinc-600/50">
      <header className="flex items-center justify-between px-3 py-3 shrink-0 border-b border-zinc-800/60 bg-black/60">
        <span className="flex items-center gap-1.5 px-2 py-0.5 text-xs font-mono font-bold text-emerald-300/70">
 <BookOpen className="size-3.5" />
          <span>/notebook {notebookId.replace(/^nb-/, '')}</span>
        </span>
        <CloseButton onClick={onClose} tone="emerald" title="Close (ESC)" />
      </header>
      {plan.error ? <div className="vc-notebook-load-error">{plan.error}</div> : null}
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
              onAddStage={handleAddStage}
              canUndo={history.canUndo}
              canRedo={history.canRedo}
              onUndo={history.undo}
              onRedo={history.redo}
              onAutoLayout={handleAutoLayout}
            />
            <NotebookSidebar
              bookId={bookId}
              callTool={callTool}
              mcpState={mcpState}
              definition={definition}
              selectedStepId={selectedStepId}
              onManageCharacters={onManageCharacters}
              mediaItems={mediaItems}
              stepCosts={stepCosts}
              runningStepIds={run.runningStepIds}
              errors={run.errors}
              updateDefinition={updateDefinition}
              onDisconnect={(sourceId, targetId) => {
                const current = getDefinition()
                if (current) commit(snapDefinitionToTracks(disconnectSteps(current, sourceId, targetId)))
              }}
              onSetInputRoute={(targetId, sourceId, param) => {
                const current = getDefinition()
                if (current) commit(setInputRoute(current, targetId, sourceId, param))
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
