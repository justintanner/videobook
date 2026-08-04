import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import {
  AlibabaVideoSynthesisInputSchema,
  AlibabaVideoSynthesisModelSchema,
  AlibabaVideoSynthesisParametersSchema,
} from "@apicity/alibaba/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import {
  apicityField,
  apicityStringField,
  apicityUnionEnumField,
} from "./schema-from-apicity.js";
import { requireAtLeastOne, toolError } from "./_shared.js";
import {
  resolveAudioRef,
  resolveImageRef,
  resolveVideoRef,
  type RefInput,
} from "./_seedance2-shared.js";
import { generationLabel } from "../artifact-label.js";

const generateAlibabaVideoSchema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(AlibabaVideoSynthesisInputSchema.shape.prompt, "Video description", { required: true }),
  negative_prompt: apicityStringField(AlibabaVideoSynthesisInputSchema.shape.negative_prompt, "Negative prompt — things to avoid"),
  model: apicityUnionEnumField(AlibabaVideoSynthesisModelSchema, "DashScope video model name ('wan2.7-i2v' or 'wan2.7-videoedit')", { required: true }),
  first_frame_ref: z.string().optional().describe("First frame image artifact id"),
  last_frame_ref: z.string().optional().describe("Last frame image artifact id"),
  first_clip_ref: z.string().optional().describe("Video artifact id for clip continuation"),
  driving_audio_ref: z.string().optional().describe("Audio artifact id for audio-driven motion"),
  video_ref: z.string().optional().describe("Reference video artifact id"),
  resolution: apicityField(AlibabaVideoSynthesisParametersSchema.shape.resolution, "Output resolution"),
  duration: apicityField(AlibabaVideoSynthesisParametersSchema.shape.duration, "Video duration in seconds (0=full source, or 2-10)"),
  prompt_extend: apicityField(AlibabaVideoSynthesisParametersSchema.shape.prompt_extend, "Intelligent prompt rewriting"),
  watermark: apicityField(AlibabaVideoSynthesisParametersSchema.shape.watermark, "Add watermark to output video"),
  audio_setting: apicityField(AlibabaVideoSynthesisParametersSchema.shape.audio_setting, "Driving-audio behavior: auto or origin"),
  seed: apicityField(AlibabaVideoSynthesisParametersSchema.shape.seed, "Random seed for reproducibility"),
  _provider: z.string().optional().describe("Provider key (e.g., 'alibaba')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateAlibabaVideoSchema>;

export function generateAlibabaVideoDef(fs: Engine): ToolDef {
  return {
    name: "generate_alibaba_wan_2_7_video",
    description: "Generate a video using Alibaba Cloud DashScope Video Synthesis. Requires at least one media input (first/last frame, reference video, driving audio, or clip continuation). Creates a new video artifact and enqueues a background job.",
    schema: generateAlibabaVideoSchema,
    handler: async (args) => {
      const {
        book_id, prompt, negative_prompt, model,
        first_frame_ref, last_frame_ref, first_clip_ref, driving_audio_ref, video_ref,
        resolution, duration, prompt_extend, watermark, audio_setting, seed,
      } = args as Args;
      const resolvedModel = AlibabaVideoSynthesisModelSchema.parse(model);

      if (!process.env.DASHSCOPE_API_KEY) {
        return toolError("DASHSCOPE_API_KEY environment variable is not set");
      }

      const missingInput = requireAtLeastOne("generate_alibaba_wan_2_7_video", [
        { name: "first_frame_ref", value: first_frame_ref },
        { name: "last_frame_ref", value: last_frame_ref },
        { name: "first_clip_ref", value: first_clip_ref },
        { name: "driving_audio_ref", value: driving_audio_ref },
        { name: "video_ref", value: video_ref },
      ]);
      if (missingInput) return missingInput;

      let firstFrame: RefInput | undefined;
      if (first_frame_ref) {
        const r = await resolveImageRef(fs, first_frame_ref, book_id);
        if (!r.ok) return toolError(r.error);
        firstFrame = r.value;
      }

      let lastFrame: RefInput | undefined;
      if (last_frame_ref) {
        const r = await resolveImageRef(fs, last_frame_ref, book_id);
        if (!r.ok) return toolError(r.error);
        lastFrame = r.value;
      }

      let firstClip: RefInput | undefined;
      if (first_clip_ref) {
        const r = await resolveVideoRef(fs, first_clip_ref, book_id);
        if (!r.ok) return toolError(r.error);
        firstClip = r.value;
      }

      let drivingAudio: RefInput | undefined;
      if (driving_audio_ref) {
        const r = await resolveAudioRef(fs, driving_audio_ref, book_id);
        if (!r.ok) return toolError(r.error);
        drivingAudio = r.value;
      }

      let videoRef: RefInput | undefined;
      if (video_ref) {
        const r = await resolveVideoRef(fs, video_ref, book_id);
        if (!r.ok) return toolError(r.error);
        videoRef = r.value;
      }

      const videoName = generationLabel("alibaba", prompt);
      const assetResult = await fs.artifacts.create("vid", videoName);
      if (!assetResult.ok) {
        return toolError(`Failed to create video asset: ${assetResult.error.message}`);
      }

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = [firstFrame?.assetId, lastFrame?.assetId].filter((v): v is string => v !== undefined);
      const sourceVideoIds = [firstClip?.assetId, videoRef?.assetId].filter((v): v is string => v !== undefined);
      const sourceAudioIds = drivingAudio ? [drivingAudio.assetId] : [];

      const jobId = `alibaba-video-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_alibaba_video",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
        prompt,
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        model: resolvedModel,
        ...(firstFrame ? { firstFrame } : {}),
        ...(lastFrame ? { lastFrame } : {}),
        ...(firstClip ? { firstClip } : {}),
        ...(drivingAudio ? { drivingAudio } : {}),
        ...(videoRef ? { videoRef } : {}),
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
        ...(resolution !== undefined ? { resolution } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(prompt_extend !== undefined ? { prompt_extend } : {}),
        ...(watermark !== undefined ? { watermark } : {}),
        ...(audio_setting !== undefined ? { audio_setting } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            source_images: sourceImageIds,
            source_videos: sourceVideoIds,
            source_audios: sourceAudioIds,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
