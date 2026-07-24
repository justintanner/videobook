import { useCallback } from "react";
import type { UseMcpResult } from "use-mcp/react";

export function useSwitchProject(callTool: UseMcpResult["callTool"]) {
  const switchProject = useCallback(
    async (slug: string): Promise<boolean> => {
      const result = await callTool("switch_project", { book_id: slug });
      return !result.isError;
    },
    [callTool],
  );

  return { switchProject };
}
