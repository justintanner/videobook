import { useCallback } from "react";
import type { UseMcpResult } from "use-mcp/react";

export function useCreateProject(callTool: UseMcpResult["callTool"]) {
  const createProject = useCallback(
    async (slug: string): Promise<boolean> => {
      const result = await callTool("create_project", { project_slug: slug });
      return !result.isError;
    },
    [callTool],
  );

  return { createProject };
}
