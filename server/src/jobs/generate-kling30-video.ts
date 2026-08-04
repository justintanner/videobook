import type { Engine } from "videobook-engine";
import type { KlingElement, KlingVideoRequest, MultiShotPrompt } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildKling30VideoPayload } from "../payload-builders.js";
import { transformProviderPrompt } from "../provider-prompt-transform.js";

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
  bookId: string;
  prompt?: string;
  mode: KlingVideoRequest["input"]["mode"];
  duration: KlingVideoRequest["input"]["duration"];
  sound: boolean;
  aspect_ratio?: KlingVideoRequest["input"]["aspect_ratio"];
  multi_shots: boolean;
  multi_prompt?: MultiShotPrompt[];
};

export function registerGenerateKling30VideoJob(fs: Engine): void {
  registerJobHandler("generate_kling30_video", async (payload, ctx) => {
    const {
      imageInputs, elementInputs, sourceImageIds,
      vidAssetId, vidAssetDir, bookId,
      prompt, mode, duration, sound, aspect_ratio,
      multi_shots, multi_prompt,
    } = payload as GenerateKling30VideoPayload;

    requireApiKey("KIE_API_KEY");

    // Upload reference images
    const imageUrls: string[] = [];
    for (const { assetId, filename } of imageInputs) {
      imageUrls.push(await uploadAssetToKie(fs, assetId, filename, bookId));
    }

    // Upload element media and build KlingElement array
    const elements: KlingElement[] = [];
    for (const elem of elementInputs) {
      const urls: string[] = [];
      for (const { assetId, filename } of elem.inputs) {
        urls.push(await uploadAssetToKie(fs, assetId, filename, bookId));
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

    const normalizedPrompt = prompt === undefined
      ? undefined
      : transformProviderPrompt("generate_kie_kling_3_0_video", {
        prompt,
        image_slugs: imageInputs.map((input) => input.assetId),
      });
    const request = buildKling30VideoPayload(
      { prompt: normalizedPrompt, mode, duration, sound, aspect_ratio, multi_shots, multi_prompt },
      imageUrls,
      elements,
    );
    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "kling30_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      bookId,
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
