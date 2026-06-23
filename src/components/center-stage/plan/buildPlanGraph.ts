// Deterministic projection of a scene-based char_swap PlanSidecar into a React
// Flow node/edge graph. Pure of mediaItems: layout + identity depend only on the
// sidecar's *structure* (scene count, character count, scene boundaries), so the
// graph is stable across the 5s asset poll — live tile state flows to nodes via
// PlanFlowContext, not node data. Positions are derived (not stored): columns by
// pipeline stage, rows by scene.
import type { Edge, Node } from '@xyflow/react';
import { frameCharacterIds, type PlanSidecar } from './charSwapModel';

// Columns by pipeline stage.
const CHAR_COL_X = 0;
const SOURCE_COL_X = 360;
const SWAP_COL_X = 760;
const VIDEO_COL_X = 1180;
// Vertical rhythm.
const ROW_H = 300; // frame1 → frame2 within a scene
const SCENE_GAP = 140; // between scene bands
const CHAR_GAP = 170; // between character-ref nodes on the left rail

const EDGE_STROKE = 'rgba(52, 211, 153, 0.30)';
const EDGE_STROKE_PROP = 'rgba(52, 211, 153, 0.55)';
// Character→swap wires are editable (connect/disconnect) and tinted violet to
// match the character-node accent, signalling they're the interactive ones.
const EDGE_STROKE_WIRE = 'rgba(167, 139, 250, 0.60)';

export type CharacterRefNodeData = { assetId: string; name: string };
export type SourceFrameNodeData = {
  sceneIndex: number;
  frameIndex: 1 | 2;
  cacheBust: string;
  label: string;
};
export type SwapGenNodeData = { sceneIndex: number; frameIndex: 1 | 2; label: string };
export type SceneVideoNodeData = { sceneIndex: number; label: string };

function roEdge(id: string, source: string, target: string, propagation = false): Edge {
  return {
    id,
    source,
    target,
    type: 'default', // bezier
    selectable: false,
    deletable: false,
    focusable: false,
    style: {
      stroke: propagation ? EDGE_STROKE_PROP : EDGE_STROKE,
      strokeWidth: 1.5,
      ...(propagation ? { strokeDasharray: '6 4' } : {}),
    },
  };
}

// Editable character→swap wire. data.wire flags it for the canvas connect/
// disconnect handlers, which translate edge edits into frame_characters writes.
function wireEdge(charAssetId: string, sceneIndex: number, frameIndex: 1 | 2): Edge {
  const source = `char:${charAssetId}`;
  const target = `swap:${sceneIndex}:${frameIndex}`;
  return {
    id: `${source}->${target}`,
    source,
    target,
    type: 'default',
    selectable: true,
    deletable: true,
    focusable: true,
    data: { wire: true },
    style: { stroke: EDGE_STROKE_WIRE, strokeWidth: 1.5 },
  };
}

export function buildPlanGraph(sidecar: PlanSidecar): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  sidecar.characters.forEach((c, i) => {
    const data: CharacterRefNodeData = { assetId: c.asset_id, name: c.name };
    nodes.push({
      id: `char:${c.asset_id}`,
      type: 'characterRef',
      position: { x: CHAR_COL_X, y: i * CHAR_GAP },
      data,
    });
  });

  let yCursor = 0;
  sidecar.scenes.forEach((scene, s) => {
    const rowY1 = yCursor;
    const rowY2 = yCursor + ROW_H;
    // Mirrors SceneBlock's source-frame cache-bust: boundary shifts when
    // /plan-vis re-chunks, so the same filename maps to a different frame.
    const cacheBust = `${scene.start.toFixed(2)}-${scene.end.toFixed(2)}`;

    ([1, 2] as const).forEach((f) => {
      const rowY = f === 1 ? rowY1 : rowY2;
      const srcId = `src:${s}:${f}`;
      const swapId = `swap:${s}:${f}`;

      const srcData: SourceFrameNodeData = {
        sceneIndex: s,
        frameIndex: f,
        cacheBust,
        label: `S${s + 1} · source ${f === 1 ? 'first' : 'last'}`,
      };
      nodes.push({ id: srcId, type: 'sourceFrame', position: { x: SOURCE_COL_X, y: rowY }, data: srcData });

      const swapData: SwapGenNodeData = { sceneIndex: s, frameIndex: f, label: `S${s + 1} · swap frame ${f}` };
      nodes.push({ id: swapId, type: 'swapGen', position: { x: SWAP_COL_X, y: rowY }, data: swapData });

      // Only the character(s) wired to this frame feed its swap (editable);
      // the source frame always feeds its own swap (read-only).
      frameCharacterIds(scene, f, sidecar.characters).forEach((cid) => edges.push(wireEdge(cid, s, f)));
      edges.push(roEdge(`${srcId}->${swapId}`, srcId, swapId));
    });

    // image1 swap feeds image2's prior-swap continuity reference.
    edges.push(roEdge(`swap:${s}:1->swap:${s}:2`, `swap:${s}:1`, `swap:${s}:2`));

    const videoId = `video:${s}`;
    const videoData: SceneVideoNodeData = { sceneIndex: s, label: `S${s + 1} · video` };
    nodes.push({ id: videoId, type: 'sceneVideo', position: { x: VIDEO_COL_X, y: (rowY1 + rowY2) / 2 }, data: videoData });
    edges.push(roEdge(`swap:${s}:1->${videoId}`, `swap:${s}:1`, videoId));
    edges.push(roEdge(`swap:${s}:2->${videoId}`, `swap:${s}:2`, videoId));

    // Last-frame → next-scene first-frame propagation (the extract_last_frame chain).
    if (s + 1 < sidecar.scenes.length) {
      edges.push(roEdge(`${videoId}->swap:${s + 1}:1`, videoId, `swap:${s + 1}:1`, true));
    }

    yCursor = rowY2 + ROW_H + SCENE_GAP;
  });

  return { nodes, edges };
}

// Structural fingerprint — changes only when the graph SHAPE changes (scene
// count, character set, scene boundaries). The canvas re-syncs node/edge state
// on this, so drag positions survive the asset poll and per-gen sidecar updates.
export function planGraphStructuralKey(sidecar: PlanSidecar): string {
  return [
    sidecar.characters.map((c) => c.asset_id).join(','),
    sidecar.scenes.map((s) => `${s.start.toFixed(2)}-${s.end.toFixed(2)}`).join('|'),
    // Per-frame wiring affects which char→swap edges exist, so changes here must
    // re-derive edges (node drag positions are preserved separately on re-sync).
    sidecar.scenes
      .map((s) => `${(s.frame_characters?.image1 ?? []).join('+')}/${(s.frame_characters?.image2 ?? []).join('+')}`)
      .join('|'),
  ].join('::');
}
