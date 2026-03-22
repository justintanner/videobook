import { useCallback, useRef, useEffect } from "react";
import type { UseMcpResult } from "use-mcp/react";

export function useRenderSettings(callTool: UseMcpResult["callTool"]) {
  const callToolRef = useRef(callTool);
  useEffect(() => { callToolRef.current = callTool; }, [callTool]);

  const fetchRenderSettings = useCallback(async (
    assetId: string,
    projectSlug: string,
  ): Promise<Record<string, Record<string, unknown>> | null> => {
    try {
      const result = await callToolRef.current("render_settings", {
        asset_id: assetId,
        project_slug: projectSlug,
      });
      if (result.isError) return null;
      const content = result.content as Array<{ type: string; text: string }>;
      return JSON.parse(content[0].text);
    } catch (e: unknown) {
      console.error("[render_settings] exception:", e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);

  return { fetchRenderSettings };
}
