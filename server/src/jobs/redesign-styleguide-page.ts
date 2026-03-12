import type { ClipfirstFs } from "clipfirst-fs";
import { kie } from "@nakedapi/kie";
import { registerJobHandler } from "../queue.js";

type RedesignPayload = {
  type: "redesign_styleguide_page";
  prompt: string;
  screenshotAssetId: string;
  screenshotFilename: string;
  redesignAssetId: string;
  redesignAssetDir: string;
  projectSlug: string;
  aspectRatio: string;
  resolution: string;
};

const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 300_000;

export function registerRedesignStyleguidePageJob(fs: ClipfirstFs): void {
  registerJobHandler("redesign_styleguide_page", async (payload) => {
    const {
      prompt,
      screenshotAssetId,
      screenshotFilename,
      redesignAssetId,
      projectSlug,
      aspectRatio,
      resolution,
    } = payload as RedesignPayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    // 1. Read screenshot and upload to KIE
    const readResult = await fs.readFile(screenshotAssetId, screenshotFilename, projectSlug);
    if (!readResult.ok) throw new Error(readResult.error.message);

    const blob = new Blob([new Uint8Array(readResult.value)]);
    const { downloadUrl } = await provider.uploadMedia({ file: blob, filename: screenshotFilename });

    // 2. Create nano-banana-pro task
    const { taskId } = await provider.createTask({
      model: "nano-banana-pro",
      input: {
        prompt,
        image_input: [downloadUrl],
        aspect_ratio: aspectRatio,
        resolution,
      },
    });

    // 3. Poll for completion
    const start = Date.now();
    while (Date.now() - start < POLL_TIMEOUT_MS) {
      const taskInfo = await provider.getTask(taskId);

      if (taskInfo.state === "success") {
        const imageUrl = taskInfo.result?.resultUrls[0];
        if (!imageUrl) throw new Error("No image URL in task result");

        // 4. Download and save result
        const response = await fetch(imageUrl);
        if (!response.ok) throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);

        const buffer = Buffer.from(await response.arrayBuffer());
        await fs.writeFile(redesignAssetId, "original.png", buffer, projectSlug);

        // 5. Write provenance metadata
        await fs.writeMetadata(redesignAssetId, "original", {
          source_screenshot: screenshotAssetId,
          model: "nano-banana-pro",
          prompt,
          aspect_ratio: aspectRatio,
          resolution,
          generated_at: new Date().toISOString(),
        }, projectSlug);

        return { success: true, taskId };
      }

      if (taskInfo.state === "fail") {
        throw new Error(`KIE task failed: ${taskInfo.failMsg ?? "unknown error"}`);
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(`KIE task ${taskId} timed out after ${POLL_TIMEOUT_MS}ms`);
  });
}
