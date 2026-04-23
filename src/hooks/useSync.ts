import { useState, useCallback, useRef } from "react";
import type { UseMcpResult } from "use-mcp/react";

export interface SyncResult {
  pending: Array<{ assetId: string; taskType: string; progress: number; state: string; prompt: string | null }>;
  completed: Array<{ assetId: string; taskType: string; jobId: string }>;
  failed: Array<{ assetId: string; taskType: string; failMsg: string; failedAt: string; prompt: string | null }>;
  external_uploads: Array<{ assetId: string; mediaFilename: string }>;
  auto_render: Array<{ assetId: string; jobId: string }>;
}

interface UseSyncResult {
  sync: (projectSlug: string) => void;
  syncing: boolean;
  result: SyncResult | undefined;
  error: string | undefined;
  syncCount: number;
}

export function useSync(callTool: UseMcpResult["callTool"]): UseSyncResult {
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<SyncResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [syncCount, setSyncCount] = useState(0);
  const callToolRef = useRef(callTool);
  callToolRef.current = callTool;
  const syncingRef = useRef(false);
  const prevSyncJsonRef = useRef<string>('');

  const sync = useCallback(async (projectSlug: string) => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    setError(undefined);
    console.log("[sync] calling sync for", projectSlug);
    try {
      const toolResult = await callToolRef.current("sync", { project_slug: projectSlug });
      if (toolResult.isError) {
        const content = toolResult.content as Array<{ type: string; text: string }>;
        const msg = content[0].text;
        console.error("[sync] error:", msg);
        setError(msg);
      } else {
        const content = toolResult.content as Array<{ type: string; text: string }>;
        const json = content[0].text;
        const parsed: SyncResult = JSON.parse(json);
        console.log("[sync] result:", parsed);
        // Always bump syncCount so listAssets/fetchTimeline re-run every tick
        // and pick up state the sync result doesn't carry (lock release when
        // a render finishes, new render.json metadata, etc.). useListAssets
        // diffs its own JSON and will skip the state update when the asset
        // list is unchanged, so idle ticks still don't cause re-renders.
        if (json !== prevSyncJsonRef.current) {
          prevSyncJsonRef.current = json;
          setResult(parsed);
        }
        setSyncCount((c) => c + 1);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[sync] exception:", msg);
      setError(msg);
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, []);

  return { sync, syncing, result, error, syncCount };
}
