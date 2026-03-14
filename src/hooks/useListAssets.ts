import { useState, useCallback, useRef, useEffect } from "react";
import type { UseMcpResult } from "use-mcp/react";

export interface ListAsset {
  id: string;
  type: string;
  created_at: string;
  path: string;
  media_url: string | null;
  thumbnail_url: string | null;
}

interface UseListAssetsResult {
  listAssets: (projectSlug: string, sort?: "newest" | "oldest") => Promise<ListAsset[] | null>;
  assets: ListAsset[] | undefined;
  clearAssets: () => void;
}

export function useListAssets(callTool: UseMcpResult["callTool"]): UseListAssetsResult {
  const [assets, setAssets] = useState<ListAsset[] | undefined>();
  const callToolRef = useRef(callTool);
  useEffect(() => { callToolRef.current = callTool; }, [callTool]);

  const listAssets = useCallback(async (projectSlug: string, sort?: "newest" | "oldest"): Promise<ListAsset[] | null> => {
    try {
      const result = await callToolRef.current("list_assets", { project_slug: projectSlug, sort });
      if (result.isError) return null;
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed: { assets: ListAsset[] } = JSON.parse(content[0].text);
      setAssets(parsed.assets);
      return parsed.assets;
    } catch (e: unknown) {
      console.error("[list_assets] exception:", e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);

  const clearAssets = useCallback(() => {
    setAssets(undefined);
  }, []);

  return { listAssets, assets, clearAssets };
}
