import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function restoreAssetVersionDef(fs: VideocityFs): ToolDef {
  return {
    name: "restore_asset_version",
    description: "Restore an asset to a previous git commit version",
    schema: {
      asset_id: z.string().describe("Asset ID to restore (e.g. img-cute-cat)"),
      commit_hash: z.string().describe("Git commit hash to restore from"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, commit_hash, project_slug } = args as { asset_id: string; commit_hash: string; project_slug: string };
      const newCommit = await fs.restoreAsset(asset_id, commit_hash, project_slug);
      if (!newCommit) {
        return {
          isError: true as const,
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
    },
  };
}

