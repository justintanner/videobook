import { useSyncExternalStore } from 'react'
import type { UseMcpResult } from 'use-mcp/react'
import type { MediaItem } from '@/components/sidebar/types'

// The SWD react wrapper renders step/root editors into a SEPARATE React root
// (ReactDOM.createRoot on the editor container), so neither prop updates nor
// React Context from PlanNotebook can reach a mounted editor. This bridge is
// an external store the editor subscribes to with useSyncExternalStore, which
// works across roots — it is the only sanctioned channel for volatile data
// (poll-driven mediaItems, run state) into the editor panel.
export interface EditorBridgeState {
  mediaItems: MediaItem[]
  runningStepIds: Set<string>
  errors: Map<string, string>
  mcpState: UseMcpResult['state']
}

export interface EditorBridge {
  publish: (next: EditorBridgeState) => void
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => EditorBridgeState
}

export function createEditorBridge(initial: EditorBridgeState): EditorBridge {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    publish(next) {
      const unchanged = next.mediaItems === state.mediaItems
        && next.runningStepIds === state.runningStepIds
        && next.errors === state.errors
        && next.mcpState === state.mcpState
      if (unchanged) return
      state = next
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => state,
  }
}

export function useEditorBridgeState(bridge: EditorBridge): EditorBridgeState {
  return useSyncExternalStore(bridge.subscribe, bridge.getSnapshot)
}
