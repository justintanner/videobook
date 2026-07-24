import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { modelSlug } from "@apicity/cost";
import { VolcengineVideoToVideoLipSyncRequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import { findAudioFile, findVideoFile } from "videobook-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringField } from "./schema-from-apicity.js";

const SLUG = modelSlug("kie", "volcengine/video-to-video-lip-sync");
const volcengineLipSync = VolcengineVideoToVideoLipSyncRequestSchema.shape.input.shape;

type RefInput = { assetId: string; filename: string };
type ResolveOk = { ok: true; value: RefInput };
type ResolveErr = { ok: false; error: string };

async function resolveVideoSlug(fs: Engine, raw: string, projectSlug: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  if (!assetId.startsWith("vid-")) return { ok: false, error: `video_slug must be a vid-* asset, got: ${assetId}` };
  const manifest = await fs.files.manifest(assetId, projectSlug);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findVideoFile(manifest.value.files);
  if (!file) return { ok: false, error: `No video file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

async function resolveAudioSlug(fs: Engine, raw: string, projectSlug: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  if (!assetId.startsWith("aud-")) return { ok: false, error: `audio_slug must be an aud-* asset, got: ${assetId}` };
  const manifest = await fs.files.manifest(assetId, projectSlug);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findAudioFile(manifest.value.files, assetId);
  if (!file) return { ok: false, error: `No audio file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

const generateVolcengineLipsyncVideoSchema = {
  project_slug: z.string().describe("Project slug"),
  video_slug: apicityStringField(volcengineLipSync.video_url, "Source video asset to lip-sync (e.g., @vid-scene)", { required: true }),
  audio_slug: apicityStringField(volcengineLipSync.audio_url, "Driving audio asset whose speech drives the lips (e.g., @aud-voice)", { required: true }),
  mode: apicityField(volcengineLipSync.mode, "Quality mode: lite (faster) or basic", { required: true }),
  separate_vocal: apicityField(volcengineLipSync.separate_vocal, "Separate vocals from background audio before sync"),
  open_scenedet: apicityField(volcengineLipSync.open_scenedet, "Enable scene-cut detection"),
  align_audio: apicityField(volcengineLipSync.align_audio, "Align audio to the video timeline"),
  align_audio_reverse: apicityField(volcengineLipSync.align_audio_reverse, "Reverse the audio alignment direction"),
  templ_start_seconds: apicityField(volcengineLipSync.templ_start_seconds, "Template start offset in seconds"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateVolcengineLipsyncVideoSchema>;

export function generateVolcengineLipsyncVideoDef(fs: Engine): ToolDef {
  return {
    name: "generate_kie_volcengine_video_to_video_lip_sync",
    description: "Lip-sync a source video to driving audio using Volcengine video-to-video lip-sync (kie). Creates a new vid- asset and enqueues a background job.",
    schema: generateVolcengineLipsyncVideoSchema,
    handler: async (args) => {
      const {
        project_slug, video_slug, audio_slug,
        mode, separate_vocal, open_scenedet, align_audio, align_audio_reverse, templ_start_seconds,
      } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      if (!video_slug) {
        return { isError: true as const, content: [{ type: "text" as const, text: "Volcengine lip-sync requires video_slug" }] };
      }
      if (!audio_slug) {
        return { isError: true as const, content: [{ type: "text" as const, text: "Volcengine lip-sync requires audio_slug" }] };
      }

      const videoResult = await resolveVideoSlug(fs, video_slug, project_slug);
      if (!videoResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: videoResult.error }] };
      const videoInput = videoResult.value;

      const audioResult = await resolveAudioSlug(fs, audio_slug, project_slug);
      if (!audioResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: audioResult.error }] };
      const audioInput = audioResult.value;

      const videoName = `${SLUG}-${String(Date.now())}`;
      const assetResult = await fs.artifacts.create("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { slug: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceVideoIds = [videoInput.assetId];
      const sourceAudioIds = [audioInput.assetId];

      const jobId = `${SLUG}-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_volcengine_lipsync_video",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        videoInput,
        audioInput,
        sourceVideoIds,
        sourceAudioIds,
        mode,
        ...(separate_vocal !== undefined ? { separate_vocal } : {}),
        ...(open_scenedet !== undefined ? { open_scenedet } : {}),
        ...(align_audio !== undefined ? { align_audio } : {}),
        ...(align_audio_reverse !== undefined ? { align_audio_reverse } : {}),
        ...(templ_start_seconds !== undefined ? { templ_start_seconds } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
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
