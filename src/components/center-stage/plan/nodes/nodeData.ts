// Per-card `data` shapes for the vertical char_swap stack. These used to live in
// buildPlanGraph.ts (the React Flow projection); the stack renders the cards
// directly, so the types live here, decoupled from @xyflow/react.
export type SourceFrameNodeData = {
  sceneIndex: number;
  frameIndex: 1 | 2;
  cacheBust: string;
  label: string;
};
export type SwapGenNodeData = { sceneIndex: number; frameIndex: 1 | 2; label: string };
export type SceneVideoNodeData = { sceneIndex: number; label: string };
