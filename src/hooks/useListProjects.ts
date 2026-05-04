import { useState, useCallback } from "react";
import type { UseMcpResult } from "use-mcp/react";

interface Project {
  slug: string;
  path: string;
}

interface UseListProjectsResult {
  projects: Project[];
  loading: boolean;
  error: string | undefined;
  refresh: () => void;
}

let cachedProjects: Project[] = [];

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
      setProjects((prev) => {
        const same =
          parsed.length === prev.length &&
          parsed.every((p, i) => p.slug === prev[i]?.slug);
        return same ? prev : parsed;
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [callTool]);

  return { projects, loading, error, refresh };
}
