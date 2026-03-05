import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";

export function registerRestoreAssetVersionTool(server: McpServer, fs: ClipfirstFs): void {
  server.tool(
    "restore_asset_version",
    "Restore an asset to a previous git commit version",
    {
      asset_id: z.string().describe("Asset ID to restore (e.g. img-cute-cat)"),
      commit_hash: z.string().describe("Git commit hash to restore from"),
      project_slug: z.string().describe("Project slug"),
    },
    async ({ asset_id, commit_hash, project_slug }) => {
      const newCommit = await fs.restoreAsset(asset_id, commit_hash, project_slug);
      if (!newCommit) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: "Failed to restore asset. Check asset ID and commit hash.",
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "restored",
            asset_id,
            from_commit: commit_hash,
            new_commit: newCommit,
          }),
        }],
      };
    }
  );
}
