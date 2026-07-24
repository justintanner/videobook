import { useState, useCallback, useRef, useEffect } from "react";
import type { UseMcpResult } from "use-mcp/react";

export interface ListAsset {
  id: string;
  type: string;
  created_at: string;
  path: string;
  media_url: string | null;
  thumbnail_url: string | null;
  status: string;
  width: number | null;
  height: number | null;
  origin: string | null;
  prompt: string | null;
  renders: string[];
  duration: number | null;
  waveform: number[] | null;
  frame_dirs: Record<string, string[]>;
  archive_id: string | null;
  archived_at: string | null;
  seen_at: number | null;
  /** Character assets only: whether an ElevenLabs voice is assigned. Null for
   *  non-character assets (or older servers that don't report it). */
  has_voice?: boolean | null;
  /** Video/final assets only: configured on-screen graphic overlay, or null. */
  osg?: { assetId: string; position: string; size: string; scale: number } | null;
}

interface UseListAssetsResult {
  listAssets: (bookId: string, sort?: "newest" | "oldest") => Promise<ListAsset[] | null>;
  assets: ListAsset[] | undefined;
  clearAssets: () => void;
  removeAsset: (assetId: string) => void;
  markAssetSeenLocal: (assetId: string) => void;
}

/** Whether a list_assets response should update UI state (guards stale races). */
export function shouldApplyListAssetsResult(
  requestSeq: number,
  latestSeq: number,
  requestProject: string,
  activeProject: string | null,
): boolean {
  return requestSeq === latestSeq && activeProject === requestProject;
}

export function useListAssets(callTool: UseMcpResult["callTool"]): UseListAssetsResult {
  const [assets, setAssets] = useState<ListAsset[] | undefined>();
  const callToolRef = useRef(callTool);
  useEffect(() => { callToolRef.current = callTool; }, [callTool]);
  const prevJsonRef = useRef<string>('');
  const requestSeqRef = useRef(0);
  const activeProjectRef = useRef<string | null>(null);

  const listAssets = useCallback(async (bookId: string, sort?: "newest" | "oldest"): Promise<ListAsset[] | null> => {
    const requestSeq = ++requestSeqRef.current;
    activeProjectRef.current = bookId;
    try {
      const result = await callToolRef.current("list_assets", { book_id: bookId, sort });
      if (result.isError) return null;
      const content = result.content as Array<{ type: string; text: string }>;
      const json = content[0].text;
      const parsed: { assets: ListAsset[] } = JSON.parse(json);
      if (!shouldApplyListAssetsResult(
        requestSeq,
        requestSeqRef.current,
        bookId,
        activeProjectRef.current,
      )) {
        return parsed.assets;
      }
      // Only update state when the asset data actually changed to avoid
      // breaking useMemo chains and causing unnecessary re-renders.
      if (json !== prevJsonRef.current) {
        prevJsonRef.current = json;
        setAssets(parsed.assets);
      }
      return parsed.assets;
    } catch (e: unknown) {
      console.error("[list_assets] exception:", e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);

  const clearAssets = useCallback(() => {
    setAssets(undefined);
    prevJsonRef.current = '';
    activeProjectRef.current = null;
  }, []);

  const removeAsset = useCallback((assetId: string) => {
    setAssets((prev) => {
      if (!prev) return prev;
      const next = prev.filter((a) => a.id !== assetId);
      prevJsonRef.current = JSON.stringify({ assets: next });
      return next;
    });
  }, []);

  const markAssetSeenLocal = useCallback((assetId: string) => {
    setAssets((prev) => {
      if (!prev) return prev;
      let mutated = false;
      const next = prev.map((a) => {
        if (a.id !== assetId || a.seen_at !== null) return a;
        mutated = true;
        return { ...a, seen_at: Math.floor(Date.now() / 1000) };
      });
      if (!mutated) return prev;
      prevJsonRef.current = JSON.stringify({ assets: next });
      return next;
    });
  }, []);

  return { listAssets, assets, clearAssets, removeAsset, markAssetSeenLocal };
}
