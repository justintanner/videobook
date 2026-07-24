import type { Engine } from "videobook-engine";
import { z } from "zod";
import { syncDef } from "./sync.js";
import type { ToolDef } from "./tool-def.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sleepDef(fs: Engine): ToolDef {
  return {
    name: "wait_for_asset_ready",
    description:
      "Wait until an asset's asynchronous generation, reconciliation, and file writes finish or the timeout expires.",
    schema: {
      asset_id: z.string().describe("Asset ID to wait on"),
      book_id: z.string().describe("Project slug"),
      timeout_seconds: z
        .number()
        .default(300)
        .describe("Max seconds to wait before returning a timeout error"),
    },
    handler: async (args) => {
      const {
        asset_id,
        book_id,
        timeout_seconds,
      } = args as {
        asset_id: string;
        book_id: string;
        timeout_seconds: number;
      };

      // Verify asset exists
      const manifestResult = await fs.files.manifest(asset_id);
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
        const syncResult = await syncHandler({ book_id });
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

        const jobs = fs.jobs.queue.list({
          artifactId: asset_id,
          limit: 20,
        });
        const failedJob = jobs.find((job) => job.state === "failed");
        if (failedJob) {
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
                  error: failedJob.error?.message ?? "Asset job failed",
                  last_sync: lastSync,
                }),
              },
            ],
          };
        }
        const activeJob = jobs.some(
          (job) =>
            job.state === "queued" ||
            job.state === "running" ||
            job.state === "completing",
        );
        const ptRead = await fs.jobs.pending.read(asset_id);
        const pendingTask = ptRead.ok ? ptRead.value : null;
        const locked = await fs.jobs.locks.isLocked(assetDir);
        const workRead = await fs.jobs.artifactWork.read(book_id
        );
        const activeWork =
          workRead.ok &&
          workRead.value !== null &&
          (workRead.value.status === "working" ||
            (workRead.value.status === "pending" &&
              typeof workRead.value.meta.kind === "string"));

        if (
          pendingTask === null &&
          !locked &&
          !activeJob &&
          !activeWork
        ) {
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

        await delay(
          Math.min(5000, Math.max(1, deadline - Date.now())),
        );
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
