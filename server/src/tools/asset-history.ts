import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs, GitCommit } from "clipfirst-fs";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

type RewriteMeta = {
  model: string;
  variant: "full" | "tldr";
  platform?: "ig" | "tiktok" | "youtube";
  customPrompt?: string;
  processedAt?: string;
};

type EnrichedCommit = GitCommit & { rewrite?: RewriteMeta };

type OriginalJson = {
  origin?: string;
  model?: string;
  variant?: "full" | "tldr";
  platform?: "ig" | "tiktok" | "youtube";
  customPrompt?: string;
  processed_at?: string;
};

async function enrichCommitsWithRewrite(
  fs: ClipfirstFs,
  commits: GitCommit[],
  assetId: string,
  projectSlug: string,
): Promise<EnrichedCommit[]> {
  if (!assetId.startsWith("script-")) return commits;

  const enriched = await Promise.all(
    commits.map(async (commit): Promise<EnrichedCommit> => {
      const result = await fs.readFileAtCommit(
        assetId,
        ".original.json",
        commit.hash,
        projectSlug,
      );
      if (!result.ok) return commit;
      let parsed: OriginalJson;
      try {
        parsed = JSON.parse(result.value) as OriginalJson;
      } catch {
        return commit;
      }
      if (parsed.origin !== "describe_image") return commit;
      const rewrite: RewriteMeta = {
        model: parsed.model ?? "gpt-5.2",
        variant: parsed.variant ?? "full",
        ...(parsed.platform ? { platform: parsed.platform } : {}),
        ...(parsed.customPrompt ? { customPrompt: parsed.customPrompt } : {}),
        ...(parsed.processed_at ? { processedAt: parsed.processed_at } : {}),
      };
      return { ...commit, rewrite };
    }),
  );
  return enriched;
}

export function assetHistoryDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "asset_history",
    description: "Get git commit history for a specific asset",
    schema: {
      asset_id: z.string().describe("Asset ID (e.g. img-cute-cat)"),
      project_slug: z.string().describe("Project slug"),
      limit: z.number().optional().describe("Max commits to return (default 20)"),
    },
    handler: async (args) => {
      const { asset_id, project_slug, limit } = args as { asset_id: string; project_slug: string; limit?: number };
      const commits = await fs.getAssetHistory(asset_id, project_slug, limit ?? 20);
      const enriched = await enrichCommitsWithRewrite(fs, commits, asset_id, project_slug);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(enriched),
        }],
      };
    },
  };
}

export function registerAssetHistoryTool(server: McpServer, fs: ClipfirstFs): void {
  const def = assetHistoryDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
