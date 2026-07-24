import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef, ToolResult } from "./tool-def.js";

export function readFileAtCommitDef(fs: Engine): ToolDef {
  return {
    name: "read_file_at_commit",
    description:
      "Read a file's contents from a specific immutable revision for a given asset. " +
      "Non-destructive — used to preview an old version of a script/prompt without restoring it.",
    schema: {
      asset_id: z.string().describe("Asset ID (e.g. script-desc-*)"),
      filename: z.string().describe("Filename within the asset directory (e.g. original.md)"),
      commit_hash: z.string().describe("DoltLite revision hash"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args): Promise<ToolResult> => {
      const { asset_id, filename, commit_hash, project_slug } = args as {
        asset_id: string;
        filename: string;
        commit_hash: string;
        project_slug: string;
      };
      const artifact = fs.artifacts.get(project_slug, asset_id);
      if (!artifact.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: artifact.error.message }],
        };
      }
      const result = await fs.files.readAtRevision(
        artifact.value.artifactId,
        filename,
        commit_hash,
      );
      if (!result.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: result.error.message }],
        };
      }
      return {
        content: [{ type: "text" as const, text: result.value.toString() }],
      };
    },
  };
}
