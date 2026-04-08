import type { ClipfirstFs } from "clipfirst-fs";
import { kie, uploadFile, submitMediaJob } from "@nakedapi/kie";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";
import { buildWan27ReferenceVideoPayload } from "../payload-builders.js";

type RefInput = { assetId: string; filename: string };

type GenerateWan27ReferenceVideoPayload = {
  type: "generate_wan27_reference_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  negative_prompt?: string;
  imageInputs: RefInput[];
  videoInputs: RefInput[];
  firstFrame?: RefInput;
  voiceRef?: RefInput;
  sourceImageIds: string[];
  sourceVideoIds: string[];
  sourceAudioIds: string[];
  resolution?: "720p" | "1080p";
  aspect_ratio?: string;
  duration?: string;
  prompt_extend?: boolean;
  seed?: number;
};

async function uploadInputs(
  fs: ClipfirstFs,
  provider: ReturnType<typeof kie>,
  inputs: RefInput[],
  projectSlug: string,
): Promise<string[]> {
  const urls: string[] = [];
  for (const { assetId, filename } of inputs) {
    const readResult = await fs.readFile(assetId, filename, projectSlug);
    if (!readResult.ok) throw new Error(readResult.error.message);
    const blob = new Blob([new Uint8Array(readResult.value)]);
    urls.push(await uploadFile(provider, blob, filename));
  }
  return urls;
}

async function uploadSingle(
  fs: ClipfirstFs,
  provider: ReturnType<typeof kie>,
  input: RefInput,
  projectSlug: string,
): Promise<string> {
  const readResult = await fs.readFile(input.assetId, input.filename, projectSlug);
  if (!readResult.ok) throw new Error(readResult.error.message);
  const blob = new Blob([new Uint8Array(readResult.value)]);
  return uploadFile(provider, blob, input.filename);
}

export function registerGenerateWan27ReferenceVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_wan27_reference_video", async (payload) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt, negative_prompt,
      imageInputs, videoInputs, firstFrame, voiceRef,
      sourceImageIds, sourceVideoIds, sourceAudioIds,
      resolution, aspect_ratio, duration, prompt_extend, seed,
    } = payload as GenerateWan27ReferenceVideoPayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const referenceImageUrls = await uploadInputs(fs, provider, imageInputs, projectSlug);
    const referenceVideoUrls = await uploadInputs(fs, provider, videoInputs, projectSlug);
    const firstFrameUrl = firstFrame ? await uploadSingle(fs, provider, firstFrame, projectSlug) : undefined;
    const referenceVoiceUrl = voiceRef ? await uploadSingle(fs, provider, voiceRef, projectSlug) : undefined;

    const request = buildWan27ReferenceVideoPayload(
      { prompt, negative_prompt, resolution, aspect_ratio, duration, prompt_extend, seed },
      { referenceImageUrls, referenceVideoUrls, firstFrameUrl, referenceVoiceUrl },
    );
    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    await writePendingTask(fs, vidAssetId, projectSlug, {
      taskId,
      taskType: "wan27_reference_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        prompt,
        mode: "reference",
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
      },
    });

    return { success: true, taskId };
  });
}
