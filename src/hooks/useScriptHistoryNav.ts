import { useCallback, useEffect, useRef, useState } from "react";
import type { UseMcpResult } from "use-mcp/react";
import { toast } from "@/hooks/useToast";
import type { GitCommit } from "@/hooks/useAssetHistory";

/**
 * Navigate a script asset's git history non-destructively.
 *
 * index 0  = HEAD (no preview — show current item.prompt)
 * index >0 = N commits back; `preview` holds the markdown content from that commit
 *
 * `revert` restores the currently-previewed commit to HEAD (destructive, creates a new commit).
 */

export interface UseScriptHistoryNavResult {
  commits: GitCommit[];
  commitsLoading: boolean;
  index: number;
  preview: string | null;
  previewLoading: boolean;
  canPrev: boolean;
  canNext: boolean;
  prev: () => void;
  next: () => void;
  reset: () => void;
  reverting: boolean;
  revert: () => Promise<boolean>;
  currentCommit: GitCommit | null;
}

const FILENAME = "original.md";

interface Args {
  callTool: UseMcpResult["callTool"];
  assetId: string;
  projectSlug: string;
}

export function useScriptHistoryNav({ callTool, assetId, projectSlug }: Args): UseScriptHistoryNavResult {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [index, setIndex] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [reverting, setReverting] = useState(false);

  const callToolRef = useRef(callTool);
  callToolRef.current = callTool;

  // Reset local nav state whenever the asset changes
  useEffect(() => {
    setIndex(0);
    setPreview(null);
    setCommits([]);
  }, [assetId]);

  // Only include commits that actually touched original.md — otherwise Prev/Next
  // would step through unrelated commits (renames in sibling files, etc.) with
  // identical content
  const fetchCommits = useCallback(async (): Promise<GitCommit[]> => {
    setCommitsLoading(true);
    try {
      const result = await callToolRef.current("asset_history", {
        asset_id: assetId,
        project_slug: projectSlug,
        limit: 50,
      });
      if (result.isError) {
        setCommits([]);
        return [];
      }
      const content = result.content as Array<{ type: string; text: string }>;
      const raw: GitCommit[] = JSON.parse(content[0].text);
      const filtered = raw.filter((c) => !c.files || c.files.length === 0 || c.files.includes(FILENAME));
      setCommits(filtered);
      return filtered;
    } catch (e: unknown) {
      console.error("[history-nav] fetch failed:", e instanceof Error ? e.message : String(e));
      setCommits([]);
      return [];
    } finally {
      setCommitsLoading(false);
    }
  }, [assetId, projectSlug]);

  const fetchPreview = useCallback(async (commitHash: string): Promise<string | null> => {
    setPreviewLoading(true);
    try {
      const result = await callToolRef.current("read_file_at_commit", {
        asset_id: assetId,
        filename: FILENAME,
        commit_hash: commitHash,
        project_slug: projectSlug,
      });
      if (result.isError) {
        const content = result.content as Array<{ type: string; text: string }> | undefined;
        const msg = content?.[0]?.text ?? "Failed to load preview";
        toast({ title: "Preview failed", description: msg, duration: 3000 });
        return null;
      }
      const content = result.content as Array<{ type: string; text: string }>;
      return content[0].text;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: "Preview failed", description: msg, duration: 3000 });
      return null;
    } finally {
      setPreviewLoading(false);
    }
  }, [assetId, projectSlug]);

  const applyIndex = useCallback(async (nextIndex: number, knownCommits: GitCommit[]) => {
    if (nextIndex <= 0) {
      setIndex(0);
      setPreview(null);
      return;
    }
    const commit = knownCommits[nextIndex];
    if (!commit) return;
    setIndex(nextIndex);
    const content = await fetchPreview(commit.hash);
    if (content === null) {
      // Roll back on failure
      setIndex(0);
      setPreview(null);
      return;
    }
    setPreview(content);
  }, [fetchPreview]);

  const prev = useCallback(async () => {
    let list = commits;
    if (list.length === 0) {
      list = await fetchCommits();
      if (list.length === 0) {
        toast({ title: "No history", description: "This script has no previous versions", duration: 2500 });
        return;
      }
    }
    const next = index + 1;
    if (next >= list.length) return;
    await applyIndex(next, list);
  }, [commits, index, fetchCommits, applyIndex]);

  const next = useCallback(async () => {
    if (index <= 0) return;
    await applyIndex(index - 1, commits);
  }, [index, commits, applyIndex]);

  const reset = useCallback(() => {
    setIndex(0);
    setPreview(null);
  }, []);

  const revert = useCallback(async (): Promise<boolean> => {
    const commit = commits[index];
    if (!commit || index <= 0) return false;
    setReverting(true);
    try {
      const result = await callToolRef.current("restore_asset_version", {
        asset_id: assetId,
        commit_hash: commit.hash,
        project_slug: projectSlug,
      });
      if (result.isError) {
        const content = result.content as Array<{ type: string; text: string }> | undefined;
        const msg = content?.[0]?.text ?? "Revert failed";
        toast({ title: "Revert failed", description: msg, duration: 3500 });
        return false;
      }
      toast({
        title: "Reverted",
        description: `Restored ${commit.hash.slice(0, 7)}`,
        duration: 2000,
      });
      await callToolRef.current("sync", { project_slug: projectSlug });
      // Fresh history + clear preview so the viewer drops back to HEAD
      setCommits([]);
      setIndex(0);
      setPreview(null);
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: "Revert failed", description: msg, duration: 3500 });
      return false;
    } finally {
      setReverting(false);
    }
  }, [commits, index, assetId, projectSlug]);

  return {
    commits,
    commitsLoading,
    index,
    preview,
    previewLoading,
    canPrev: commits.length === 0 ? true : index + 1 < commits.length,
    canNext: index > 0,
    prev,
    next,
    reset,
    reverting,
    revert,
    currentCommit: index > 0 ? commits[index] ?? null : null,
  };
}
