import type { ClipfirstFs } from "clipfirst-fs";
import { kie } from "@nakedapi/kie";
import { xai } from "@nakedapi/xai";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";
import { buildGrokImagineVideoPayload } from "../payload-builders.js";

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
  _provider?: string;
};

export function registerGenerateGrokImagineVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_grok_imagine_video", async (payload) => {
    const {
      imageFilename, vidAssetId, vidAssetDir,
      sourceImageId, projectSlug, prompt, mode, duration, resolution, _provider,
    } = payload as GenerateGrokImagineVideoPayload;

    const isXai = _provider !== undefined && _provider.startsWith("xai");

    const readResult = await fs.readFile(sourceImageId, imageFilename, projectSlug);
    if (!readResult.ok) throw new Error(readResult.error.message);
    const imageBytes = new Uint8Array(readResult.value);

    if (isXai) {
      // xAI path — async video generation with pending task
      const apiKey = process.env.XAI_API_KEY;
      if (!apiKey) throw new Error("XAI_API_KEY environment variable is not set");

      // Upload image via kie for a publicly accessible URL (xai needs a URL, not base64)
      const kieKey = process.env.KIE_API_KEY;
      let imageUrl: string;
      if (kieKey) {
        const kieProvider = kie({ apiKey: kieKey, timeout: 60_000 });
        const blob = new Blob([imageBytes]);
        const { downloadUrl } = await kieProvider.api.fileStreamUpload({ file: blob, filename: imageFilename });
        imageUrl = downloadUrl;
      } else {
        // Fallback: base64 data URL
        const ext = imageFilename.split(".").pop()?.toLowerCase() ?? "png";
        const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
        const b64 = Buffer.from(imageBytes).toString("base64");
        imageUrl = `data:${mime};base64,${b64}`;
      }

      const provider = xai({ apiKey, timeout: 120_000 });
      const request = {
        prompt: prompt ?? "",
        image_url: imageUrl,
        ...(duration !== undefined ? { duration: parseInt(duration, 10) } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
      };
      await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
      const { request_id } = await provider.v1.videos.generations(request);

      await writePendingTask(fs, vidAssetId, projectSlug, {
        taskId: request_id,
        taskType: "xai_grok_imagine_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        projectSlug,
        createdAt: new Date().toISOString(),
        meta: {
          sourceImageId,
          ...(prompt !== undefined ? { prompt } : {}),
          ...(duration !== undefined ? { duration } : {}),
          ...(resolution !== undefined ? { resolution } : {}),
        },
      });

      return { success: true, requestId: request_id, provider: "xai" };
    }

    // Kie path — async task-based generation
    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });
    const blob = new Blob([imageBytes]);

    const { downloadUrl } = await provider.api.fileStreamUpload({
      file: blob,
      filename: imageFilename,
    });

    const request = buildGrokImagineVideoPayload(
      { prompt, mode, duration, resolution },
      [downloadUrl],
    );
    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const { taskId } = await provider.api.v1.jobs.createTask(request);

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
