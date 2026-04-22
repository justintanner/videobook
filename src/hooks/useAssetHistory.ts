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

export interface GitCommit {
  hash: string;
  message: string;
  date: string;
  author?: string;
  files?: string[];
  rewrite?: RewriteMeta;
}

interface UseAssetHistoryResult {
  commits: GitCommit[];
  loading: boolean;
  fetchHistory: (assetId: string, projectSlug: string) => Promise<void>;
  restoreVersion: (assetId: string, commitHash: string, projectSlug: string) => Promise<boolean>;
}

export function useAssetHistory(callTool: UseMcpResult["callTool"]): UseAssetHistoryResult {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(false);
  const callToolRef = useRef(callTool);
  useEffect(() => { callToolRef.current = callTool; }, [callTool]);

  const fetchHistory = useCallback(async (assetId: string, projectSlug: string) => {
    setLoading(true);
    try {
      const result = await callToolRef.current("asset_history", { asset_id: assetId, project_slug: projectSlug });
      if (result.isError) {
        setCommits([]);
        return;
      }
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed: GitCommit[] = JSON.parse(content[0].text);
      setCommits(parsed);
    } catch (e: unknown) {
      console.error("[asset_history] exception:", e instanceof Error ? e.message : String(e));
      setCommits([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const restoreVersion = useCallback(async (assetId: string, commitHash: string, projectSlug: string): Promise<boolean> => {
    try {
      const result = await callToolRef.current("restore_asset_version", {
        asset_id: assetId,
        commit_hash: commitHash,
        project_slug: projectSlug,
      });
      return !result.isError;
    } catch (e: unknown) {
      console.error("[restore_asset_version] exception:", e instanceof Error ? e.message : String(e));
      return false;
    }
  }, []);

  return { commits, loading, fetchHistory, restoreVersion };
}
