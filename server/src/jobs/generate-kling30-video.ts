import type { ClipfirstFs } from "clipfirst-fs";
import type { KlingElement, MultiShotPrompt } from "@nakedapi/kie";
import { kie } from "@nakedapi/kie";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";
import { buildKling30VideoPayload } from "../payload-builders.js";

type ImageInput = { assetId: string; filename: string };
type ElementInput = {
  inputs: ImageInput[];
  name: string;
  desc: string;
  hasVideo: boolean;
};

type GenerateKling30VideoPayload = {
  type: "generate_kling30_video";
  imageInputs: ImageInput[];
  elementInputs: ElementInput[];
  sourceImageIds: string[];
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt?: string;
  mode?: "std" | "pro";
  duration?: string;
  sound?: boolean;
  aspect_ratio?: string;
  multi_shots?: boolean;
  multi_prompt?: MultiShotPrompt[];
};

export function registerGenerateKling30VideoJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_kling30_video", async (payload) => {
    const {
      imageInputs, elementInputs, sourceImageIds,
      vidAssetId, vidAssetDir, projectSlug,
      prompt, mode, duration, sound, aspect_ratio,
      multi_shots, multi_prompt,
    } = payload as GenerateKling30VideoPayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    // Upload reference images
    const imageUrls: string[] = [];
    for (const { assetId, filename } of imageInputs) {
      const readResult = await fs.readFile(assetId, filename, projectSlug);
      if (!readResult.ok) throw new Error(readResult.error.message);
      const blob = new Blob([new Uint8Array(readResult.value)]);
      const upload = await provider.api["file-stream-upload"]({ file: blob, filename });
      if (!upload.data?.downloadUrl) throw new Error("KIE upload failed: no download URL in response");
      imageUrls.push(upload.data.downloadUrl);
    }

    // Upload element media and build KlingElement array
    const elements: KlingElement[] = [];
    for (const elem of elementInputs) {
      const urls: string[] = [];
      for (const { assetId, filename } of elem.inputs) {
        const readResult = await fs.readFile(assetId, filename, projectSlug);
        if (!readResult.ok) throw new Error(readResult.error.message);
        const blob = new Blob([new Uint8Array(readResult.value)]);
        const elemUpload = await provider.api["file-stream-upload"]({ file: blob, filename });
        if (!elemUpload.data?.downloadUrl) throw new Error("KIE upload failed: no download URL in response");
        urls.push(elemUpload.data.downloadUrl);
      }

      const element: KlingElement = {
        name: elem.name || (elem.inputs[0]?.assetId ?? ""),
        description: elem.desc,
      };

      if (elem.hasVideo) {
        element.element_input_video_urls = urls;
      } else if (urls.length > 0) {
        element.element_input_urls = urls;
      }

      elements.push(element);
    }

    const request = buildKling30VideoPayload(
      { prompt, mode, duration, sound, aspect_ratio, multi_shots, multi_prompt },
      imageUrls,
      elements,
    );
    const taskResult = await provider.api.v1.jobs.createTask(request);
    if (!taskResult.data?.taskId) {
      const msg = (taskResult as Record<string, unknown>).msg as string | undefined;
      throw new Error(`KIE createTask failed: ${msg ?? 'no taskId in response'}`);
    }
    const taskId = taskResult.data.taskId;

    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    await writePendingTask(fs, vidAssetId, projectSlug, {
      taskId,
      taskType: "kling30_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        sourceImageIds,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(sound !== undefined ? { sound } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(multi_shots !== undefined ? { multi_shots } : {}),
      },
    });

    return { success: true, taskId };
  });
}
