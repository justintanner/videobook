import type { VideocityFs } from "videobook-engine";
import { z } from "zod";
import type { ToolDef, ToolResult } from "./tool-def.js";

export function readFileAtCommitDef(fs: VideocityFs): ToolDef {
  return {
    name: "read_file_at_commit",
    description:
      "Read a file's contents from a specific immutable revision for a given asset. " +
      "Non-destructive — used to preview an old version of a script/prompt without restoring it. " +
      "The legacy endpoint name is preserved for Videocity MCP compatibility.",
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
      const result = await fs.readFileAtCommit(asset_id, filename, commit_hash, project_slug);
      if (!result.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: result.error.message }],
        };
      }
      return {
        content: [{ type: "text" as const, text: result.value }],
      };
    },
  };
}
