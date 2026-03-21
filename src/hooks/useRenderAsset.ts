import { useCallback, useRef, useEffect } from "react";
import type { UseMcpResult } from "use-mcp/react";
import type { RenderSettings } from "@/components/center-stage/render-settings-types";

interface UseRenderAssetResult {
  renderAsset: (assetId: string, projectSlug: string, settings?: RenderSettings) => Promise<boolean>;
}

export function useRenderAsset(callTool: UseMcpResult["callTool"]): UseRenderAssetResult {
  const callToolRef = useRef(callTool);
  useEffect(() => { callToolRef.current = callTool; }, [callTool]);

  const renderAsset = useCallback(async (assetId: string, projectSlug: string, settings?: RenderSettings): Promise<boolean> => {
    try {
      const args: Record<string, string | number | boolean> = {
        asset_id: assetId,
        project_slug: projectSlug,
      };

      if (settings) {
        args.subtitles_enabled = settings.subtitlesEnabled;
        args.highlight_style = settings.subtitleStyle;
        args.position = settings.subtitlePosition;
        args.font_size = settings.fontSize;
        args.text_color = settings.textColor;
        args.highlight_color = settings.highlightColor;
        args.audio_volume = settings.audioVolume;
        args.audio_fade_in = settings.audioFadeIn;
        args.audio_fade_out = settings.audioFadeOut;
        if (settings.osgAssetId) {
          args.osg_asset_id = settings.osgAssetId;
        }
        args.osg_position = settings.osgPosition;
        args.background_mode = settings.backgroundMode;
      }

      const result = await callToolRef.current("render", args);
      return !result.isError;
    } catch (e: unknown) {
      console.error("[render] exception:", e instanceof Error ? e.message : String(e));
      return false;
    }
  }, []);

  return { renderAsset };
}
