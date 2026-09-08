import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ForgetAssetOutcome } from "../forget-asset.js";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";

const FORGET_TIMEOUT_MS = 5 * 60_000;

export function forgetAssetDef(engine: Engine): ToolDef {
  return {
    name: "forget_asset",
    description:
      "Delete an asset and permanently destroy its stored content; bytes shared with another asset are kept",
    annotations: { destructiveHint: true, idempotentHint: false },
    schema: {
      book_id: z.string().uuid(),
      asset_id: z.string(),
      clear_references: z.boolean().optional()
        .describe("Clear notebook cells and sequence clips holding the asset first"),
    },
    handler: async (args) => {
      const assetId = String(args.asset_id);
      const artifact = engine.artifacts.get(assetId);
      if (!artifact.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: artifact.error.message }],
        };
      }
      try {
        const outcome = await queue.enqueueAndWait<ForgetAssetOutcome>(
          `forget-asset-${artifact.value.artifactId}`,
          {
            type: "forget_asset",
            bookId: String(args.book_id),
            forgetArtifactId: artifact.value.artifactId,
            clearReferences: args.clear_references === true,
          },
          FORGET_TIMEOUT_MS,
        );
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: outcome.status,
              artifact_id: outcome.artifactId,
              ...(outcome.label ? { label: outcome.label } : {}),
              references: outcome.references,
              cleared_cells: outcome.clearedCells,
              forgotten_objects: outcome.forgottenObjects,
              shared_objects: outcome.sharedObjects,
              reclaimed_bytes: outcome.reclaimedBytes,
            }),
          }],
        };
      } catch (cause) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: cause instanceof Error ? cause.message : String(cause),
          }],
        };
      }
    },
  };
}
