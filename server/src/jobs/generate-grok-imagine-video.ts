import { readFile } from "node:fs/promises";
import { kie } from "@nakedapi/kie";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";

type GenerateGrokImagineVideoPayload = {
  type: "generate_grok_imagine_video";
  imagePath: string;
  imageFilename: string;
  vidAssetId: string;
  vidAssetDir: string;
  sourceImageId: string;
  projectSlug: string;
  prompt?: string;
  mode?: "fun" | "normal" | "spicy";
  duration?: "6" | "10" | "15";
  resolution?: "480p" | "720p";
};

export function registerGenerateGrokImagineVideoJob(): void {
  registerJobHandler("generate_grok_imagine_video", async (payload) => {
    const {
      imagePath, imageFilename, vidAssetId, vidAssetDir,
      sourceImageId, projectSlug, prompt, mode, duration, resolution,
    } = payload as GenerateGrokImagineVideoPayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const imageBuffer = await readFile(imagePath);
    const blob = new Blob([imageBuffer]);

    const { downloadUrl } = await provider.uploadMedia({
      file: blob,
      filename: imageFilename,
    });

    const { taskId } = await provider.createTask({
      model: "grok-imagine/image-to-video",
      input: {
        image_urls: [downloadUrl],
        ...(prompt !== undefined ? { prompt } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
      },
    });

    await writePendingTask(vidAssetDir, {
      taskId,
      taskType: "grok_imagine_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        sourceImageId,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
      },
    });

    return { success: true, taskId };
  });
}
