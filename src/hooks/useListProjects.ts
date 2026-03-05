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

export function useListProjects(callTool: UseMcpResult["callTool"]): UseListProjectsResult {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await callTool("list_projects", {});
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed: Project[] = JSON.parse(content[0].text);
      setProjects(parsed);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [callTool]);

  return { projects, loading, error, refresh };
}
