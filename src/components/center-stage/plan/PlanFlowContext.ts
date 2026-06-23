// Shared state for the char_swap flow canvas. Nodes read live data (mediaItems,
// projectSlug, characters) from here rather than via React Flow node `data`, so
// the node/edge arrays stay structurally stable across the 5s asset poll while
// tiles still re-render as assets land. callTool/actions are added in Phase 2.
import { createContext, useContext } from 'react';
import type { MediaItem } from '@/components/sidebar/types';
import type { SourceAspect } from '@/lib/plan-aspect';
import type { PlanSidecar } from './charSwapModel';
import type { CharSwapActions } from './useCharSwapActions';

export interface PlanFlowContextValue {
  sidecar: PlanSidecar;
  characters: PlanSidecar['characters'];
  mediaItems: MediaItem[];
  projectSlug: string;
  sourceAspect: SourceAspect;
  actions: CharSwapActions;
}

const PlanFlowContext = createContext<PlanFlowContextValue | null>(null);

export const PlanFlowProvider = PlanFlowContext.Provider;

export function usePlanFlow(): PlanFlowContextValue {
  const ctx = useContext(PlanFlowContext);
  if (!ctx) throw new Error('usePlanFlow must be used inside <PlanFlowProvider>');
  return ctx;
}
