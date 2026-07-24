import type { Engine, Revision } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

type RewriteMeta = {
  model: string;
  variant: "full" | "tldr";
  platform?: "ig" | "tiktok" | "youtube";
  customPrompt?: string;
  processedAt?: string;
};

type EnrichedCommit = Revision & { rewrite?: RewriteMeta };

type OriginalMetadata = {
  origin?: string;
  model?: string;
  variant?: "full" | "tldr";
  platform?: "ig" | "tiktok" | "youtube";
  customPrompt?: string;
  processed_at?: string;
};

async function enrichCommitsWithRewrite(
  fs: Engine,
  commits: Revision[],
  artifact: string,
  project: string,
): Promise<EnrichedCommit[]> {
  if (!artifact.startsWith("script-")) return commits;
  return Promise.all(
    commits.map(async (commit): Promise<EnrichedCommit> => {
      const result =
        await fs.metadata.artifacts.readAtRevision<OriginalMetadata>(
          artifact,
          "original",
          commit.hash,
          project,
        );
      if (!result.ok || result.value.origin !== "describe_image") {
        return commit;
      }
      const metadata = result.value;
      return {
        ...commit,
        rewrite: {
          model: metadata.model ?? "gpt-5.2",
          variant: metadata.variant ?? "full",
          ...(metadata.platform ? { platform: metadata.platform } : {}),
          ...(metadata.customPrompt
            ? { customPrompt: metadata.customPrompt }
            : {}),
          ...(metadata.processed_at
            ? { processedAt: metadata.processed_at }
            : {}),
        },
      };
    }),
  );
}

export function assetHistoryDef(fs: Engine): ToolDef {
  return {
    name: "asset_history",
    description: "Get immutable Dolt revision history for an asset",
    schema: {
      asset_id: z.string().describe("Active artifact slug or stable UUID"),
      project_slug: z.string().describe("Project slug"),
      limit: z.number().optional().describe("Maximum revisions (default 20)"),
    },
    handler: async (args) => {
      const { asset_id, project_slug, limit } = args as {
        asset_id: string;
        project_slug: string;
        limit?: number;
      };
      try {
        const commits = fs.history.artifact(
          asset_id,
          project_slug,
          limit ?? 20,
        );
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(
              await enrichCommitsWithRewrite(
                fs,
                commits,
                asset_id,
                project_slug,
              ),
            ),
          }],
        };
      } catch (error) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: error instanceof Error ? error.message : String(error),
          }],
        };
      }
    },
  };
}
