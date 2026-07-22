import { useCallback, useRef, useEffect } from "react";
import type { UseMcpResult } from "use-mcp/react";
import type { TranscriptInfo } from "@/components/center-stage/render-settings-types";

export interface RenderSettingsResponse {
  settings: Record<string, Record<string, unknown>>;
  transcript: TranscriptInfo | null;
}

export function useRenderSettings(callTool: UseMcpResult["callTool"]) {
  const callToolRef = useRef(callTool);
  useEffect(() => { callToolRef.current = callTool; }, [callTool]);

  const fetchRenderSettings = useCallback(async (
    assetId: string,
    projectSlug: string,
  ): Promise<RenderSettingsResponse | null> => {
    try {
      const result = await callToolRef.current("get_render_settings", {
        asset_id: assetId,
        project_slug: projectSlug,
      });
      if (result.isError) return null;
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text) as Partial<RenderSettingsResponse>;
      return {
        settings: parsed.settings ?? {},
        transcript: parsed.transcript ?? null,
      };
    } catch (e: unknown) {
      console.error("[render_settings] exception:", e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);

  return { fetchRenderSettings };
}
