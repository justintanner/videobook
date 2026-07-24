import { useState, useCallback, useRef, useEffect } from "react";
import type { UseMcpResult } from "use-mcp/react";

export type RewriteVariant = 'full' | 'tldr';
export type RewritePlatform = 'ig' | 'tiktok' | 'youtube';

export interface RewriteMeta {
  model: string;
  variant: RewriteVariant;
  platform?: RewritePlatform;
  customPrompt?: string;
  processedAt?: string;
}

export interface Revision {
  hash: string;
  message: string;
  date: string;
  author?: string;
  files?: string[];
  fileChanges?: Array<{
    status: string;
    file: string;
    oldFile?: string;
  }>;
  rewrite?: RewriteMeta;
}

interface UseAssetHistoryResult {
  commits: Revision[];
  loading: boolean;
  fetchHistory: (assetId: string, bookId: string) => Promise<void>;
  restoreVersion: (assetId: string, commitHash: string, bookId: string) => Promise<boolean>;
}

export function useAssetHistory(callTool: UseMcpResult["callTool"]): UseAssetHistoryResult {
  const [commits, setCommits] = useState<Revision[]>([]);
  const [loading, setLoading] = useState(false);
  const callToolRef = useRef(callTool);
  useEffect(() => { callToolRef.current = callTool; }, [callTool]);

  const fetchHistory = useCallback(async (assetId: string, bookId: string) => {
    setLoading(true);
    try {
      const result = await callToolRef.current("asset_history", { asset_id: assetId, book_id: bookId });
      if (result.isError) {
        setCommits([]);
        return;
      }
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed: Revision[] = JSON.parse(content[0].text);
      setCommits(parsed);
    } catch (e: unknown) {
      console.error("[asset_history] exception:", e instanceof Error ? e.message : String(e));
      setCommits([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const restoreVersion = useCallback(async (assetId: string, commitHash: string, bookId: string): Promise<boolean> => {
    try {
      const result = await callToolRef.current("restore_asset_version", {
        asset_id: assetId,
        commit_hash: commitHash,
        book_id: bookId,
      });
      return !result.isError;
    } catch (e: unknown) {
      console.error("[restore_asset_version] exception:", e instanceof Error ? e.message : String(e));
      return false;
    }
  }, []);

  return { commits, loading, fetchHistory, restoreVersion };
}
