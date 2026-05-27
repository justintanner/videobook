import { useState, useCallback } from "react";
import type { UseMcpResult } from "use-mcp/react";

export interface Project {
  slug: string;
  path: string;
  asset_count: number;
}

interface UseListProjectsResult {
  projects: Project[];
  loading: boolean;
  error: string | undefined;
  refresh: () => void;
}

let cachedProjects: Project[] = [];

// Returns `prev` (reference-equal) when parsed matches by length+slug order,
// otherwise returns `parsed`. Each hook instance must compare against its own
// state — comparing against the shared module cache leaves sibling instances
// stuck on their initial value when the cache was filled by a peer.
export function reduceProjectsState(prev: Project[], parsed: Project[]): Project[] {
  const same =
    parsed.length === prev.length &&
    parsed.every((p, i) => p.slug === prev[i]?.slug && p.asset_count === prev[i]?.asset_count);
  return same ? prev : parsed;
}

export function useListProjects(callTool: UseMcpResult["callTool"]): UseListProjectsResult {
  const [projects, setProjects] = useState<Project[]>(cachedProjects);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await callTool("list_projects", {});
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed: Project[] = JSON.parse(content[0].text);
      cachedProjects = parsed;
      setProjects((prev) => reduceProjectsState(prev, parsed));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [callTool]);

  return { projects, loading, error, refresh };
}
