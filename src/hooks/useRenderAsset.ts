import { useCallback, useRef, useEffect } from "react";
import type { UseMcpResult } from "use-mcp/react";
import type { RenderSettings } from "@/components/center-stage/render-settings-types";
import type { Orientation } from "@/hooks/useTimeline";

interface RenderOutcome {
  ok: boolean;
  error?: string;
}

interface UseRenderAssetResult {
  renderAsset: (assetId: string, projectSlug: string, orientation?: Orientation, settings?: RenderSettings) => Promise<RenderOutcome>;
}

export function useRenderAsset(callTool: UseMcpResult["callTool"]): UseRenderAssetResult {
  const callToolRef = useRef(callTool);
  useEffect(() => { callToolRef.current = callTool; }, [callTool]);

  const renderAsset = useCallback(async (assetId: string, projectSlug: string, orientation?: Orientation, settings?: RenderSettings): Promise<RenderOutcome> => {
    try {
      const args: Record<string, string | number | boolean> = {
        asset_id: assetId,
        project_slug: projectSlug,
      };

      if (orientation) {
        args.orientation = orientation;
      }

      if (settings) {
        args.subtitles_enabled = settings.subtitlesEnabled;
        args.subtitle_language = settings.subtitleLanguage;
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
        args.osg_size = settings.osgSize;
        args.osg_scale = settings.osgScale;
        if (settings.osgStartSeconds != null) {
          args.osg_start_seconds = settings.osgStartSeconds;
        }
        if (settings.osgEndSeconds != null) {
          args.osg_end_seconds = settings.osgEndSeconds;
        }
        if (settings.osgTailSeconds != null) {
          args.osg_tail_seconds = settings.osgTailSeconds;
        }
        args.background_mode = settings.backgroundMode;
        args.stroke_width = settings.strokeWidth;
        args.stroke_color = settings.strokeColor;
        args.shadow_blur = settings.shadowBlur;
        args.shadow_opacity = settings.shadowOpacity;
      }

      const result = await callToolRef.current("render_video", args);
      if (result.isError) {
        const content = result.content as Array<{ type: string; text: string }> | undefined;
        return { ok: false, error: content?.[0]?.text ?? "render failed" };
      }
      return { ok: true };
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e);
      console.error("[render] exception:", error);
      return { ok: false, error };
    }
  }, []);

  return { renderAsset };
}
