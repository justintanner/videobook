import { useCallback, useEffect, useRef, useState } from "react";
import type { UseMcpResult } from "use-mcp/react";
import { toast } from "@/hooks/useToast";
import type { GitCommit } from "@/hooks/useAssetHistory";

/**
 * Step a script asset's HEAD backward/forward through its git history in one click.
 *
 * Each PREV/NEXT call invokes restore_asset_version against the target commit and
 * issues a sync so the normal item.prompt flow picks up the new content. There is
 * no preview mode — the viewer always reflects HEAD.
 *
 * `idx` is the current position in the ORIGINAL history list captured on first
 * fetch. We don't refetch after each restore so the Next button keeps meaning
 * "move toward where I started".
 */

export interface UseScriptHistoryNavResult {
  loading: boolean;
  canPrev: boolean;
  canNext: boolean;
  prev: () => Promise<void>;
  next: () => Promise<void>;
}

const FILENAME = "original.md";
const EMPTY_COMMITS: GitCommit[] = [];

interface Args {
  callTool: UseMcpResult["callTool"];
  assetId: string;
  projectSlug: string;
}

interface HistoryState {
  assetId: string;
  commits: GitCommit[];
  idx: number;
}

export function useScriptHistoryNav({ callTool, assetId, projectSlug }: Args): UseScriptHistoryNavResult {
  const [history, setHistory] = useState<HistoryState>(() => ({ assetId, commits: [], idx: 0 }));
  const [loading, setLoading] = useState(false);
  if (history.assetId !== assetId) {
    setHistory({ assetId, commits: [], idx: 0 });
  }
  const commits = history.assetId === assetId ? history.commits : EMPTY_COMMITS;
  const idx = history.assetId === assetId ? history.idx : 0;

  const callToolRef = useRef(callTool);
  useEffect(() => {
    callToolRef.current = callTool;
  }, [callTool]);
  const inFlightRef = useRef(false);

  const fetchCommits = useCallback(async (): Promise<GitCommit[]> => {
    const result = await callToolRef.current("asset_history", {
      asset_id: assetId,
      project_slug: projectSlug,
      limit: 50,
    });
    if (result.isError) return [];
    const content = result.content as Array<{ type: string; text: string }>;
    const raw: GitCommit[] = JSON.parse(content[0].text);
    const filtered = raw.filter((c) => !c.files || c.files.length === 0 || c.files.includes(FILENAME));
    setHistory({ assetId, commits: filtered, idx: 0 });
    return filtered;
  }, [assetId, projectSlug]);

  const stepTo = useCallback(async (targetIdx: number, list: GitCommit[]) => {
    const commit = list[targetIdx];
    if (!commit) return;
    const result = await callToolRef.current("restore_asset_version", {
      asset_id: assetId,
      commit_hash: commit.hash,
      project_slug: projectSlug,
    });
    if (result.isError) {
      const content = result.content as Array<{ type: string; text: string }> | undefined;
      toast({ title: "Restore failed", description: content?.[0]?.text ?? "Unknown error", duration: 3500 });
      return;
    }
    setHistory({ assetId, commits: list, idx: targetIdx });
    await callToolRef.current("reconcile_project_work", { project_slug: projectSlug });
  }, [assetId, projectSlug]);

  const prev = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    try {
      let list = commits;
      if (list.length === 0) {
        list = await fetchCommits();
        if (list.length <= 1) {
          toast({ title: "No older versions", duration: 2000 });
          return;
        }
      }
      if (idx + 1 >= list.length) return;
      await stepTo(idx + 1, list);
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [commits, idx, fetchCommits, stepTo]);

  const next = useCallback(async () => {
    if (inFlightRef.current || idx <= 0 || commits.length === 0) return;
    inFlightRef.current = true;
    setLoading(true);
    try {
      await stepTo(idx - 1, commits);
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [commits, idx, stepTo]);

  return {
    loading,
    canPrev: commits.length === 0 ? true : idx + 1 < commits.length,
    canNext: idx > 0,
    prev,
    next,
  };
}
