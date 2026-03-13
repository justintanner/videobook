import { useCallback } from "react";
import type { UseMcpResult } from "use-mcp/react";
import type { SyncResult } from "./useSync";

export function useSwitchProject(callTool: UseMcpResult["callTool"]) {
  const switchProject = useCallback(
    async (slug: string): Promise<SyncResult | null> => {
      const result = await callTool("switch_project", { project_slug: slug });
      if (result.isError) return null;
      const content = result.content as Array<{ type: string; text: string }>;
      return JSON.parse(content[0].text) as SyncResult;
    },
    [callTool],
  );

  return { switchProject };
}
