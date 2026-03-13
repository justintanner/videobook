import { useCallback } from "react";
import type { UseMcpResult } from "use-mcp/react";

export function useRenameProject(callTool: UseMcpResult["callTool"]) {
  const renameProject = useCallback(
    async (oldSlug: string, newSlug: string): Promise<boolean> => {
      const result = await callTool("rename_project", {
        old_slug: oldSlug,
        new_slug: newSlug,
      });
      return !result.isError;
    },
    [callTool],
  );

  return { renameProject };
}
