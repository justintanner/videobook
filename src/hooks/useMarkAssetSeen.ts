import { useCallback, useEffect, useRef } from 'react';
import type { UseMcpResult } from 'use-mcp/react';

export function useMarkAssetSeen(callTool: UseMcpResult['callTool']) {
  const callToolRef = useRef(callTool);
  useEffect(() => { callToolRef.current = callTool; }, [callTool]);

  return useCallback(async (assetId: string, projectSlug: string): Promise<boolean> => {
    try {
      const result = await callToolRef.current('mark_asset_seen', { asset_id: assetId, project_slug: projectSlug });
      return !result.isError;
    } catch (e: unknown) {
      console.error('[mark_asset_seen] exception:', e instanceof Error ? e.message : String(e));
      return false;
    }
  }, []);
}
