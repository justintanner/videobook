import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function restoreAssetVersionDef(fs: Engine): ToolDef {
  return {
    name: "restore_asset_version",
    description: "Restore an asset from an immutable revision as a new revision",
    schema: {
      asset_id: z
        .string()
        .describe("Stable artifact UUID, or the slug of an active artifact"),
      commit_hash: z.string().describe("DoltLite revision hash to restore from"),
      book_id: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, commit_hash } = args as { asset_id: string; commit_hash: string; book_id: string };
      const artifact = fs.artifacts.get(asset_id);
      const artifactId = artifact.ok ? artifact.value.artifactId : asset_id;
      const restored = await fs.history.restoreArtifact(
        artifactId,
        commit_hash,
      );
      if (!restored.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: restored.error.message }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "restored",
            asset_id: artifactId,
            from_commit: commit_hash,
            new_commit: restored.value.hash,
          }),
        }],
      };
    },
  };
}
