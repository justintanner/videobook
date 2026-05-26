import type { VideocityFs } from "vc-engine";
import { z } from "zod";
import { syncDef } from "./sync.js";
import type { ToolDef } from "./tool-def.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sleepDef(fs: VideocityFs): ToolDef {
  return {
    name: "sleep",
    description:
      "Block until an asset's async work (KIE task polling, completion jobs, file writes) is fully done. Calls sync repeatedly under the hood. Useful for e2e tests that need to wait for generation pipelines to complete.",
    schema: {
      asset_id: z.string().describe("Asset ID to wait on"),
      project_slug: z.string().describe("Project slug"),
      timeout_seconds: z
        .number()
        .default(300)
        .describe("Max seconds to wait before returning a timeout error"),
    },
    handler: async (args) => {
      const {
        asset_id,
        project_slug,
        timeout_seconds,
      } = args as {
        asset_id: string;
        project_slug: string;
        timeout_seconds: number;
      };

      // Verify asset exists
      const manifestResult = await fs.getManifest(asset_id, project_slug);
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                asset_id,
                status: "not_found",
                error: "Asset not found",
              }),
            },
          ],
        };
      }

      const assetDir = manifestResult.value.path;
      const syncHandler = syncDef(fs).handler;
      const deadline = Date.now() + timeout_seconds * 1000;
      const startTime = Date.now();
      let iterations = 0;
      let lastSync: unknown = null;

      while (Date.now() < deadline) {
        iterations++;

        // Drive state machine forward
        const syncResult = await syncHandler({ project_slug });
        const syncData = JSON.parse(syncResult.content[0].text) as {
          pending: Array<{ assetId: string }>;
          completed: Array<{ assetId: string }>;
          failed: Array<{ assetId: string; failMsg: string }>;
          external_uploads: Array<{ assetId: string }>;
          auto_render: Array<{ assetId: string }>;
        };
        lastSync = syncData;

        // Check for failure
        const failure = syncData.failed.find((f) => f.assetId === asset_id);
        if (failure) {
          return {
            isError: true as const,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  asset_id,
                  status: "failed",
                  elapsed_seconds: Math.round(
                    (Date.now() - startTime) / 1000,
                  ),
                  iterations,
                  error: failure.failMsg,
                  last_sync: lastSync,
                }),
              },
            ],
          };
        }

        // Check done: no pending task and not locked
        const ptRead = await fs.pendingTasks.read(project_slug, asset_id);
        const pendingTask = ptRead.ok ? ptRead.value : null;
        const locked = await fs.isLocked(assetDir);

        if (pendingTask === null && !locked) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  asset_id,
                  status: "ready",
                  elapsed_seconds: Math.round(
                    (Date.now() - startTime) / 1000,
                  ),
                  iterations,
                  last_sync: lastSync,
                }),
              },
            ],
          };
        }

        await delay(5000);
      }

      // Timeout
      return {
        isError: true as const,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              asset_id,
              status: "timeout",
              elapsed_seconds: Math.round((Date.now() - startTime) / 1000),
              iterations,
              last_sync: lastSync,
            }),
          },
        ],
      };
    },
  };
}
