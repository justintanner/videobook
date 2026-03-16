import { useCallback, useRef, useEffect } from "react";
import type { UseMcpResult } from "use-mcp/react";

interface UseRenderAssetResult {
  renderAsset: (assetId: string, projectSlug: string) => Promise<boolean>;
}

export function useRenderAsset(callTool: UseMcpResult["callTool"]): UseRenderAssetResult {
  const callToolRef = useRef(callTool);
  useEffect(() => { callToolRef.current = callTool; }, [callTool]);

  const renderAsset = useCallback(async (assetId: string, projectSlug: string): Promise<boolean> => {
    try {
      const result = await callToolRef.current("render", {
        asset_id: assetId,
        project_slug: projectSlug,
      });
      return !result.isError;
    } catch (e: unknown) {
      console.error("[render] exception:", e instanceof Error ? e.message : String(e));
      return false;
    }
  }, []);

  return { renderAsset };
}
