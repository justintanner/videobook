import type { ClipfirstFs } from "clipfirst-fs";
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

export function registerGenerateGrokImagineVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_grok_imagine_video", async (payload) => {
    const {
      imageFilename, vidAssetId, vidAssetDir,
      sourceImageId, projectSlug, prompt, mode, duration, resolution,
    } = payload as GenerateGrokImagineVideoPayload;

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
      model: "grok-imagine/image-to-video",
      input: {
        image_urls: [downloadUrl],
        ...(prompt !== undefined ? { prompt } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
      },
    });

    await writePendingTask(fs, vidAssetId, projectSlug, {
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
