// React Flow canvas projecting a char_swap PlanSidecar as a node graph. Node/
// edge arrays are owned by React Flow state (so drags persist) and re-synced
// only when the graph *structure* changes — per-gen sidecar updates and the 5s
// asset poll flow to nodes via PlanFlowContext, never rebuilding the graph.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { MediaItem } from '@/components/sidebar/types';
import type { SourceAspect } from '@/lib/plan-aspect';
import { frameCharacterIds, type PlanSidecar } from './charSwapModel';
import { buildPlanGraph, planGraphStructuralKey } from './buildPlanGraph';
import { PlanFlowProvider, type PlanFlowContextValue } from './PlanFlowContext';
import type { CharSwapActions } from './useCharSwapActions';
import { CharacterRefNode } from './nodes/CharacterRefNode';
import { SourceFrameNode } from './nodes/SourceFrameNode';
import { SwapGenNode } from './nodes/SwapGenNode';
import { SceneVideoNode } from './nodes/SceneVideoNode';

// Stable module const — re-creating nodeTypes per render is a React Flow footgun
// (remounts every node each render).
const NODE_TYPES = {
  characterRef: CharacterRefNode,
  sourceFrame: SourceFrameNode,
  swapGen: SwapGenNode,
  sceneVideo: SceneVideoNode,
};

const MAX_CHARS_PER_FRAME = 2;

// Edge endpoints are stable ids: `char:{assetId}` → `swap:{sceneIndex}:{frame}`.
function parseCharNodeId(id: string | null | undefined): string | null {
  return id && id.startsWith('char:') ? id.slice('char:'.length) : null;
}
function parseSwapNodeId(id: string | null | undefined): { sceneIndex: number; frameIndex: 1 | 2 } | null {
  const m = id ? /^swap:(\d+):([12])$/.exec(id) : null;
  return m ? { sceneIndex: Number(m[1]), frameIndex: Number(m[2]) as 1 | 2 } : null;
}

interface PlanFlowCanvasProps {
  sidecar: PlanSidecar;
  mediaItems: MediaItem[];
  projectSlug: string;
  sourceAspect: SourceAspect;
  actions: CharSwapActions;
}

export function PlanFlowCanvas({ sidecar, mediaItems, projectSlug, sourceAspect, actions }: PlanFlowCanvasProps) {
  const structuralKey = planGraphStructuralKey(sidecar);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Rebuild only when the graph SHAPE changes. The effect re-runs on every
  // sidecar identity change (incl. per-gen updates) but early-returns unless the
  // structural key moved, so node drag positions survive gens and asset polls.
  const syncedKey = useRef<string | null>(null);
  useEffect(() => {
    if (syncedKey.current === structuralKey) return;
    syncedKey.current = structuralKey;
    const g = buildPlanGraph(sidecar);
    // Preserve any node drag positions across a re-sync (wiring edits and
    // auto-match change the structural key but must not reset the layout).
    setNodes((prev) => {
      const posById = new Map(prev.map((n) => [n.id, n.position]));
      return g.nodes.map((n) => {
        const pos = posById.get(n.id);
        return pos ? { ...n, position: pos } : n;
      });
    });
    setEdges(g.edges);
  }, [structuralKey, sidecar, setNodes, setEdges]);

  // --- Editable character→swap wiring -------------------------------------
  // Connect a character to a frame: append it (dedup, cap at 2 by dropping the
  // oldest) and persist. The sidecar update re-derives the edge on re-sync.
  const onConnect = useCallback((c: Connection) => {
    const charId = parseCharNodeId(c.source);
    const swap = parseSwapNodeId(c.target);
    if (!charId || !swap) return;
    const current = frameCharacterIds(sidecar.scenes[swap.sceneIndex], swap.frameIndex, sidecar.characters);
    if (current.includes(charId)) return;
    const next = [...current, charId].slice(-MAX_CHARS_PER_FRAME);
    void actions.setFrameCharacters(swap.sceneIndex, swap.frameIndex, next);
  }, [sidecar, actions]);

  // Only char→swap wires may be created.
  const isValidConnection = useCallback(
    (c: Connection | Edge) => Boolean(parseCharNodeId(c.source) && parseSwapNodeId(c.target)),
    [],
  );

  // Guard deletions: never delete nodes, only `wire` edges, and never empty a
  // frame (must keep ≥1 character).
  const onBeforeDelete = useCallback(async ({ nodes: nDel, edges: eDel }: { nodes: Node[]; edges: Edge[] }) => {
    if (nDel.length > 0) return false;
    if (eDel.length === 0) return false;
    if (eDel.some((e) => !e.data?.wire)) return false;
    const removals = new Map<string, number>();
    for (const e of eDel) {
      const swap = parseSwapNodeId(e.target);
      if (!swap) return false;
      const k = `${swap.sceneIndex}:${swap.frameIndex}`;
      removals.set(k, (removals.get(k) ?? 0) + 1);
    }
    for (const [k, n] of removals) {
      const [s, f] = k.split(':').map(Number);
      const count = frameCharacterIds(sidecar.scenes[s], f as 1 | 2, sidecar.characters).length;
      if (count - n < 1) return false;
    }
    return true;
  }, [sidecar]);

  // Disconnect: persist the reduced character list for each affected frame.
  const onEdgesDelete = useCallback((deleted: Edge[]) => {
    const byFrame = new Map<string, { sceneIndex: number; frameIndex: 1 | 2; remove: Set<string> }>();
    for (const e of deleted) {
      if (!e.data?.wire) continue;
      const swap = parseSwapNodeId(e.target);
      const charId = parseCharNodeId(e.source);
      if (!swap || !charId) continue;
      const k = `${swap.sceneIndex}:${swap.frameIndex}`;
      if (!byFrame.has(k)) byFrame.set(k, { sceneIndex: swap.sceneIndex, frameIndex: swap.frameIndex, remove: new Set() });
      byFrame.get(k)!.remove.add(charId);
    }
    for (const { sceneIndex, frameIndex, remove } of byFrame.values()) {
      const next = frameCharacterIds(sidecar.scenes[sceneIndex], frameIndex, sidecar.characters).filter((id) => !remove.has(id));
      if (next.length >= 1) void actions.setFrameCharacters(sceneIndex, frameIndex, next);
    }
  }, [sidecar, actions]);

  const ctx = useMemo<PlanFlowContextValue>(
    () => ({ sidecar, characters: sidecar.characters, mediaItems, projectSlug, sourceAspect, actions }),
    [sidecar, mediaItems, projectSlug, sourceAspect, actions],
  );

  return (
    <div className="w-full h-full bg-zinc-950" data-rfcanvas>
      <PlanFlowProvider value={ctx}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onBeforeDelete={onBeforeDelete}
          onEdgesDelete={onEdgesDelete}
          isValidConnection={isValidConnection}
          nodeTypes={NODE_TYPES}
          fitView
          minZoom={0.15}
          maxZoom={1.75}
          nodesConnectable
          elementsSelectable
          proOptions={{ hideAttribution: true }}
          colorMode="dark"
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#27272a" />
          <Controls showInteractive={false} className="!bg-zinc-900 !border-zinc-700" />
          <MiniMap
            pannable
            zoomable
            className="!bg-zinc-900/90 !border !border-zinc-700"
            maskColor="rgba(0,0,0,0.6)"
            nodeColor="#34d39955"
          />
        </ReactFlow>
      </PlanFlowProvider>
    </div>
  );
}
