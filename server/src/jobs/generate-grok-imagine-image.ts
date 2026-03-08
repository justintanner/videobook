import type { ClipfirstFs } from "clipfirst-fs";
import { kie } from "@nakedapi/kie";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";

type GenerateGrokImagineImagePayload = {
  type: "generate_grok_imagine_image";
  imagePath: string;
  imageFilename: string;
  imgAssetId: string;
  imgAssetDir: string;
  sourceImageId: string;
  projectSlug: string;
  prompt?: string;
};

export function registerGenerateGrokImagineImageJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_grok_imagine_image", async (payload) => {
    const {
      imageFilename, imgAssetId, imgAssetDir,
      sourceImageId, projectSlug, prompt,
    } = payload as GenerateGrokImagineImagePayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const readResult = await fs.readFile(sourceImageId, imageFilename, projectSlug);
    if (!readResult.ok) throw new Error(readResult.error.message);
    const blob = new Blob([new Uint8Array(readResult.value)]);

    const { downloadUrl } = await provider.uploadMedia({
      file: blob,
      filename: imageFilename,
    });

    const { taskId } = await provider.createTask({
      model: "grok-imagine/image-to-image",
      input: {
        image_urls: [downloadUrl],
        ...(prompt !== undefined ? { prompt } : {}),
      },
    });

    await writePendingTask(fs, imgAssetId, projectSlug, {
      taskId,
      taskType: "grok_imagine_image",
      assetId: imgAssetId,
      assetDir: imgAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        sourceImageId,
        ...(prompt !== undefined ? { prompt } : {}),
      },
    });

    return { success: true, taskId };
  });
}
