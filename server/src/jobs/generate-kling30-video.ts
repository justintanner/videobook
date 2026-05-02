import type { ClipfirstFs } from "clipfirst-engine";
import type { KlingElement, MultiShotPrompt } from "@apicity/kie";
import { kie, submitMediaJob } from "@apicity/kie";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
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
  registerJobHandler("generate_kling30_video", async (payload, ctx) => {
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
      imageUrls.push(await uploadAssetToKie(fs, assetId, filename, projectSlug));
    }

    // Upload element media and build KlingElement array
    const elements: KlingElement[] = [];
    for (const elem of elementInputs) {
      const urls: string[] = [];
      for (const { assetId, filename } of elem.inputs) {
        urls.push(await uploadAssetToKie(fs, assetId, filename, projectSlug));
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
    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    {
      const _ptResult = await fs.pendingTasks.write(projectSlug, {
        taskId,
        taskType: "kling30_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        meta: {
          sourceImageIds,
          ...(prompt !== undefined ? { prompt } : {}),
          ...(mode !== undefined ? { mode } : {}),
          ...(duration !== undefined ? { duration } : {}),
          ...(sound !== undefined ? { sound } : {}),
          ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
          ...(multi_shots !== undefined ? { multi_shots } : {}),
        },
    }, ctx.getOwnerId());
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${vidAssetId}: ${_ptResult.error.message}`);
      if (_ptResult.value === null) throw new Error(`Lost local lease while writing pending-task`);
    }
    ctx.setLease({ kind: "task", taskId });

    return { success: true, taskId };
  });
}
